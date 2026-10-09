"""Account-wide R2 operation cutoff; analytics credentials never reach browsers."""
import calendar
from datetime import datetime, timezone
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

A_LIMIT = 950_000
B_LIMIT = 9_700_000
API = 'https://api.cloudflare.com/client/v4/graphql'
CONTROL = '_fallback/budget.json'
CLASS_A = set('ListBuckets PutBucket ListObjects ListObjectsV2 PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration'.lower().split())
CLASS_B = set('HeadBucket HeadObject GetObject UsageSummary GetUsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration'.lower().split())
FREE = set('DeleteObject DeleteObjects DeleteBucket AbortMultipartUpload'.lower().split())
QUERY = '''query WeatherR2Usage($accountTag: string!, $start: Time!, $end: Time!) {
 viewer { accounts(filter: {accountTag: $accountTag}) {
  r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
   sum { requests } dimensions { actionType }
  }
 } }
}'''
_lock = threading.Lock()
_cached = None
_checked = 0


class BudgetPaused(RuntimeError):
    pass


def period(now, day):
    try: day = int(day)
    except (TypeError, ValueError): raise ValueError('R2_BILLING_DAY must be a number from 1 to 31') from None
    if not 1 <= day <= 31: raise ValueError('Billing day must be between 1 and 31')
    def date(year, month):
        return datetime(year, month, min(day, calendar.monthrange(year, month)[1]), tzinfo=timezone.utc)
    start = date(now.year, now.month)
    if now < start:
        start = date(now.year-1, 12) if now.month == 1 else date(now.year, now.month-1)
    end = date(start.year+1, 1) if start.month == 12 else date(start.year, start.month+1)
    return start, end


def previous_control():
    from github_fallback import download
    try:
        value = json.loads(download(CONTROL))
        if value.get('version') != 1: raise ValueError('Invalid cutoff control')
        return value
    except urllib.error.HTTPError as exc:
        if exc.code == 404: return {}
        raise


def usage(now, start):
    endpoint = os.environ.get('R2_ENDPOINT', '')
    account = re.search(r'https://([a-f0-9]{32})(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com', endpoint, re.I)
    if not account: raise ValueError('Account ID missing from R2 endpoint')
    payload = {'query': QUERY, 'variables': {'accountTag': account.group(1),
        'start': start.isoformat(), 'end': now.isoformat()}}
    request = urllib.request.Request(API, data=json.dumps(payload).encode(), headers={
        'Authorization': 'Bearer '+os.environ['CLOUDFLARE_R2_ANALYTICS_TOKEN'].strip(),
        'Content-Type': 'application/json', 'User-Agent': 'NorthWeather-UsageGuard/1.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if result.get('errors'):
        messages = '; '.join(str(error.get('message', 'Query rejected')) for error in result['errors'] if isinstance(error, dict))
        raise ValueError('Cloudflare analytics rejected the query: '+messages)
    accounts = result['data']['viewer']['accounts']
    if len(accounts) != 1: raise ValueError('Cloudflare analytics did not return the account')
    rows = accounts[0]['r2OperationsAdaptiveGroups']
    if len(rows) >= 10000: raise ValueError('Incomplete analytics result')
    counts = {'classA': 0, 'classB': 0}
    for row in rows:
        count = row['sum']['requests']
        if isinstance(count, bool) or not isinstance(count, (int,float)) or not math.isfinite(count) or count < 0:
            raise ValueError('Invalid analytics count')
        action = re.sub(r'[^a-z]', '', row['dimensions']['actionType'].lower())
        if action in CLASS_A: counts['classA'] += math.ceil(count)
        elif action in CLASS_B: counts['classB'] += math.ceil(count)
        elif action not in FREE and count:
            # Analytics also includes dashboard/configuration actions absent from
            # the billing operation table. Count these against both limits so an
            # unfamiliar action cannot hide usage or stop all weather delivery.
            counts['classA'] += math.ceil(count)
            counts['classB'] += math.ceil(count)
            print('R2 guard conservatively counts unfamiliar operation against both limits: '+action[:80], file=sys.stderr)
    return counts


def decision(now=None, previous=None):
    now = now or datetime.now(timezone.utc)
    if os.environ.get('R2_PAUSED','').lower() == 'true':
        if previous is None:
            try: previous = previous_control()
            except Exception: previous = {}
        enabled = bool(os.environ.get('CLOUDFLARE_R2_ANALYTICS_TOKEN','').strip() or previous.get('enabled'))
        return {'version':1,'enabled':enabled,'paused':True,'reason':'manual_pause','until':int(now.timestamp()+1800)}
    try:
        previous = previous_control() if previous is None else previous
        token = os.environ.get('CLOUDFLARE_R2_ANALYTICS_TOKEN','').strip()
        if not token and not previous.get('enabled'):
            return {'version':1,'enabled':False,'paused':False,'reason':'analytics_token_required','until':0}
        if not token: raise ValueError('Analytics token missing after activation')
        start, end = period(now, os.environ['R2_BILLING_DAY'])
        key = start.date().isoformat()
        if previous.get('period') == key and previous.get('reason') == 'operations_limit' and previous.get('paused'):
            return previous
        counts = usage(now, start)
        paused = counts['classA'] >= A_LIMIT or counts['classB'] >= B_LIMIT
        return {'version':1,'enabled':True,'paused':paused,'reason':'operations_limit' if paused else 'within_limits',
            'period':key,'until':int(end.timestamp()) if paused else 0,
            'checkedAt':now.isoformat(),'limits':{'classA':A_LIMIT,'classB':B_LIMIT},**counts}
    except Exception as exc:
        # No guessed usage or zero totals when an activated guard loses telemetry.
        diagnostic = str(exc)
        for secret in [os.environ.get('CLOUDFLARE_R2_ANALYTICS_TOKEN', ''), os.environ.get('R2_ENDPOINT', ''), os.environ.get('R2_BILLING_DAY', '')]:
            if secret: diagnostic = diagnostic.replace(secret, '[redacted]')
        diagnostic = re.sub(r'[a-fA-F0-9]{32}', '[account]', diagnostic)
        diagnostic = re.sub(r'[\r\n]', ' ', diagnostic)[:500]
        print('R2 guard verification failed ('+type(exc).__name__+'): '+diagnostic, file=sys.stderr, flush=True)
        return {'version':1,'enabled':True,'paused':True,'reason':'analytics_unavailable',
            'until':int(now.timestamp()+900),'checkedAt':now.isoformat()}


def ensure_allowed(**_kwargs):
    global _cached, _checked
    with _lock:
        if _cached is None or time.monotonic()-_checked >= 60:
            _cached = decision(); _checked = time.monotonic()
        if _cached['paused']:
            raise BudgetPaused('R2 operation guard: '+_cached['reason']+'; using GitHub fallback')


def monitor():
    from github_fallback import publish, ROOT
    try: old = previous_control()
    except Exception: old = None
    state = decision(previous=old)
    public = {key:state[key] for key in ['version','enabled','paused','reason','until']}
    if 'period' in state: public['period'] = state['period']
    print(json.dumps(public), flush=True)
    signature = lambda s: tuple((s or {}).get(k) for k in ['enabled','paused','reason','period','until'])
    if signature(state) != signature(old):
        publish([], root=ROOT, active=False, control=public)
    if not state['enabled']:
        print('::warning::Automatic cutoff not activated: add CLOUDFLARE_R2_ANALYTICS_TOKEN and R2_BILLING_DAY.')
    elif state['reason'] == 'analytics_unavailable':
        print('::warning::R2 blocked until analytics/configuration can be verified.')


if __name__ == '__main__':
    monitor()
