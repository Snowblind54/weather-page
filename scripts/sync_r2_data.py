"""Stage weather data in R2, with bounded writes and expiry of unused files.

Only weather/data/ is managed. All bucket objects count toward the 8 GB budget.
Current source files remain protected, including the last successful snapshots.
Run all writers in the shared r2-weather-storage Actions concurrency group.
"""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import mimetypes
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'weather/'
BUDGET = 8_000_000_000  # Decimal GB; keep 2 GB below the free storage allowance.


def inventory(client, bucket):
    return {obj['Key']: obj for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket)
            for obj in page.get('Contents', [])}


def expiry_days(key):
    if key.startswith(PREFIX + 'data/snow-history/'):
        return 16
    if key.startswith((PREFIX + 'data/radar-tiles/', PREFIX + 'data/radar-cache/')):
        return 1
    return 2


def expired_keys(objects, protected, now):
    return [key for key, obj in objects.items()
            if key.startswith(PREFIX + 'data/') and key not in protected
            and obj['LastModified'] < now - timedelta(days=expiry_days(key))]


def plan_peak(total, changes):
    """Conservative: reserve full incoming bytes even when replacing old keys."""
    return total + sum(size for _, size, _ in changes)


def sync(client, bucket, root=ROOT, now=None):
    now = now or datetime.now(timezone.utc)
    paths = sorted(p for p in (root / 'data').rglob('*') if p.is_file())
    if not paths:
        raise RuntimeError('No source data; refusing expiry or publication')
    files = {PREFIX + p.relative_to(root).as_posix(): p for p in paths}
    objects = inventory(client, bucket)
    expired = expired_keys(objects, set(files), now)
    for start in range(0, len(expired), 1000):
        result = client.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': k} for k in expired[start:start + 1000]], 'Quiet': True})
        if result.get('Errors'):
            raise RuntimeError('Expiry deletion failed; aborting uploads')
    # Re-read actual storage after expiry; never assume deletion freed space.
    objects = inventory(client, bucket)
    total = sum(o['Size'] for o in objects.values())
    changes = []
    for key, path in files.items():
        size = path.stat().st_size
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        existing = objects.get(key)
        if existing and existing['Size'] == size:
            head = client.head_object(Bucket=bucket, Key=key)
            if head.get('Metadata', {}).get('sha256') == digest:
                continue
        changes.append((key, size, digest))
    peak = plan_peak(total, changes)
    if peak > BUDGET:
        raise RuntimeError(f'8 GB storage guard: {total} stored + incoming files would require {peak} bytes; no uploads performed')
    # Assets and nested JSON first; publish root manifests only after all assets
    # have been uploaded and independently verified through authenticated HEAD.
    changes.sort(key=lambda item: (item[0].count('/') == 2, item[0].endswith('.json'), item[0]))
    for key, size, digest in changes:
        path = files[key]
        is_snapshot = key.count('/') == 2
        with path.open('rb') as body:
            client.put_object(Bucket=bucket, Key=key, Body=body, ContentLength=size,
                ContentType=mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                CacheControl='public, max-age=60, must-revalidate' if is_snapshot else 'public, max-age=86400',
                Metadata={'sha256': digest})
        head = client.head_object(Bucket=bucket, Key=key)
        if head['ContentLength'] != size or head.get('Metadata', {}).get('sha256') != digest:
            raise RuntimeError('Upload verification failed; remaining manifests withheld')
    final = inventory(client, bucket)
    stored = sum(o['Size'] for o in final.values())
    if stored > BUDGET:
        raise RuntimeError('Bucket exceeded the guarded budget; check other writers')
    report = {'generatedAt': now.isoformat(), 'budgetBytes': BUDGET,
        'bucketBytes': stored, 'managedFiles': len(files), 'uploadedFiles': len(changes),
        'expiredFiles': len(expired), 'status': 'verified',
        'publicMapCutover': 'pending public URL and browser verification'}
    (root / 'r2-storage-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return report


def main():
    import boto3
    from botocore.config import Config
    required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise RuntimeError('Missing GitHub secrets: ' + ', '.join(missing))
    endpoint = os.environ['R2_ENDPOINT'].rstrip('/')
    if not endpoint.startswith('https://'):
        raise RuntimeError('R2_ENDPOINT must be an HTTPS S3 endpoint')
    client = boto3.client('s3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'},
            request_checksum_calculation='when_required', response_checksum_validation='when_required'))
    sync(client, os.environ['R2_BUCKET'])


if __name__ == '__main__':
    main()
