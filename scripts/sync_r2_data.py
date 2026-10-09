"""Publish without bucket scans; central maintenance audits storage and expiry."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
import json
import math
import mimetypes
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'weather/'
BUDGET = 8_000_000_000
INDEX_RESERVE = 10_000_000
AUDIT_MAX_AGE = 2 * 3600


def inventory(client, bucket):
    return {obj['Key']: obj for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket)
            for obj in page.get('Contents', [])}


def scopes(values):
    result = [str(PurePosixPath(value.rstrip('/'))) for value in (values or ['data'])]
    if any((value != 'data' and not value.startswith('data/')) or '..' in PurePosixPath(value).parts for value in result):
        raise ValueError('Only relative paths inside data/ may be published')
    return result


def in_scope(key, selected):
    return any(key == PREFIX + value or key.startswith(PREFIX + value + '/') for value in selected)


def expiry_days(key):
    if key.startswith(PREFIX + 'data/snow-history/'):
        return 16
    if key.startswith((PREFIX + 'data/radar-tiles/', PREFIX + 'data/radar-cache/', PREFIX + 'data/cloud-tiles/')):
        return 1
    return 2


def expired_keys(objects, protected, now):
    return [key for key, obj in objects.items() if key.startswith(PREFIX + 'data/')
            and key not in protected and obj['LastModified'] < now - timedelta(days=expiry_days(key))]


def plan_peak(total, changes):
    return total + sum(size for _, size, _ in changes)


def generation(path):
    if path.suffix != '.json' or path.parent.name != 'data':
        return None
    data = json.loads(path.read_text())
    value = data.get('generatedAt', data.get('generated_at')) if isinstance(data, dict) else None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except ValueError:
            return None
    return value if isinstance(value, (int, float)) else None


def save_registry(client, bucket, registry, lease):
    from r2_store import INDEX_KEY
    body = json.dumps(registry, separators=(',', ':')).encode()
    if len(body) > INDEX_RESERVE:
        raise RuntimeError('Publication registry exceeded its reserved metadata budget')
    if lease: lease.check()
    client.put_object(Bucket=bucket, Key=INDEX_KEY, Body=body,
                      ContentType='application/json', CacheControl='no-store')


def audit_cleanup(client, bucket, registry, now, root, lease):
    # One paginated scan, only here. Include foreign objects in the budget,
    # but never delete anything outside the managed weather prefix.
    entries = {k: dict(v) for k, v in registry['files'].items()}
    protected = {k for k, v in entries.items() if v.get('protected')} | set(registry.get('pending', []))
    objects = inventory(client, bucket)
    expired = expired_keys(objects, protected, now)
    for start in range(0, len(expired), 1000):
        if lease: lease.check()
        result = client.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': k} for k in expired[start:start + 1000]], 'Quiet': True})
        if result.get('Errors'):
            raise RuntimeError('Expiry deletion failed; storage audit withheld')
        for key in expired[start:start + 1000]:
            objects.pop(key, None)
    # Only live entries need hashes. Retired objects remain in bucket_bytes
    # until this central job expires them; their individual hashes are unused.
    for key in list(entries):
        if key not in protected:
            del entries[key]
            continue
        obj = objects.get(key)
        if not obj:
            entries[key]['etag'] = None
            entries[key]['exists'] = False
        else:
            if entries[key].get('etag') != obj.get('ETag'):
                entries[key]['sha256'] = None
            entries[key].update(size=obj['Size'], etag=obj.get('ETag'), exists=True)
    total = sum(obj['Size'] for obj in objects.values())
    updated = dict(registry, files=entries, accounting={
        'version': 1, 'bucket_bytes': total, 'audited_at': now.timestamp()})
    save_registry(client, bucket, updated, lease)
    report = {'generatedAt': now.isoformat(), 'budgetBytes': BUDGET,
              'bucketBytes': total, 'managedFiles': len(entries), 'uploadedFiles': 0,
              'expiredFiles': len(expired), 'inventoryScans': 1, 'status': 'audited'}
    (root / 'r2-storage-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    if total + INDEX_RESERVE > BUDGET:
        raise RuntimeError('8 GB storage guard: audited bucket is above the admission budget')
    return report


def sync(client, bucket, root=ROOT, now=None, selected=None, registry=None, lease=None, cleanup_only=False):
    from r2_store import INDEX_KEY
    now, selected = now or datetime.now(timezone.utc), scopes(selected)
    registry = registry if registry is not None else {'version': 1, 'files': {}}
    entries = {k: dict(v) for k, v in registry.get('files', {}).items()}
    files = {}
    if not cleanup_only:
        for value in selected:
            source = root / value
            candidates = [source] if source.is_file() else source.rglob('*')
            for path in candidates:
                if path.is_file():
                    if not path.resolve().is_relative_to((root / 'data').resolve()):
                        raise ValueError('Source data path escapes data/')
                    files[PREFIX + path.relative_to(root).as_posix()] = path
        if not files:
            raise RuntimeError('No source data; refusing expiry or publication')
        for key, path in files.items():
            incoming, previous = generation(path), entries.get(key, {}).get('generation')
            if incoming is not None and previous is not None and incoming < previous:
                print('Older generated snapshot withheld; current R2 data retained.', flush=True)
                return {'status': 'retained-newer-snapshot'}
    elif not entries:
        raise RuntimeError('No publication registry; refusing blind expiry')
    if cleanup_only:
        return audit_cleanup(client, bucket, registry, now, root, lease)
    accounting = registry.get('accounting', {})
    audited_at, total = accounting.get('audited_at'), accounting.get('bucket_bytes')
    if (accounting.get('version') != 1 or not isinstance(total, (int, float)) or not math.isfinite(total) or total < 0
            or not isinstance(audited_at, (int, float))
            or not math.isfinite(audited_at)
            or not 0 <= now.timestamp() - audited_at <= AUDIT_MAX_AGE):
        raise RuntimeError('Fresh central R2 storage audit required; keeping last successful data')

    def changed(item):
        key, path = item
        size, digest = path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()
        cached = entries.get(key, {})
        if (cached.get('exists', True) and cached.get('etag') and cached.get('size') == size
                and cached.get('sha256') == digest):
            return None
        return (key, size, digest)

    with ThreadPoolExecutor(max_workers=24) as pool:
        changes = [item for item in pool.map(changed, files.items()) if item]
    peak = plan_peak(total, changes) + INDEX_RESERVE
    if peak > BUDGET:
        raise RuntimeError(f'8 GB storage guard: incoming files and metadata would require {peak} bytes; no uploads performed')

    # Reserve the full upload bytes BEFORE the first asset PUT. A crashed or
    # partial upload stays conservatively charged until the next audit.
    # Other publishers share this accounting under the existing R2 lease.
    reserved = dict(accounting, bucket_bytes=total + sum(size for _, size, _ in changes))
    pending = set(registry.get('pending', [])) | set(files)
    intent = dict(registry, pending=sorted(pending), accounting=reserved)
    save_registry(client, bucket, intent, lease)
    old_sizes = {key: entries.get(key, {}).get('size', 0)
                 if entries.get(key, {}).get('exists', True) else 0 for key, _, _ in changes}

    def upload(item):
        if lease: lease.check()
        key, size, digest = item
        path = files[key]
        with path.open('rb') as body:
            client.put_object(Bucket=bucket, Key=key, Body=body, ContentLength=size,
                ContentType=mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                CacheControl='public, max-age=60, must-revalidate' if key.count('/') == 2 else 'public, max-age=86400',
                Metadata={'sha256': digest})
        head = client.head_object(Bucket=bucket, Key=key)
        if head['ContentLength'] != size or head.get('Metadata', {}).get('sha256') != digest:
            raise RuntimeError('Upload verification failed; remaining manifests withheld')
        entries[key] = {'sha256': digest, 'size': size, 'etag': head['ETag'], 'exists': True}

    assets = [item for item in changes if item[0].count('/') != 2]
    manifests = [item for item in changes if item[0].count('/') == 2]
    with ThreadPoolExecutor(max_workers=24) as pool:
        list(pool.map(upload, assets))
    print('Verified assets; publishing current manifests.', flush=True)
    for item in manifests:
        upload(item)
    for key in list(entries):
        if in_scope(key, selected) and key not in files:
            del entries[key]
    for key, path in files.items():
        entries[key]['protected'] = True
        entries[key]['generation'] = generation(path)
    stored = reserved['bucket_bytes'] - sum(old_sizes.values())
    remaining = [key for key in pending if not in_scope(key, selected)]
    save_registry(client, bucket, {'version': 1, 'files': entries,
        'pending': remaining, 'accounting': dict(accounting, bucket_bytes=stored)}, lease)
    report = {'generatedAt': now.isoformat(), 'budgetBytes': BUDGET, 'bucketBytes': stored,
        'managedFiles': len(files), 'uploadedFiles': len(changes), 'expiredFiles': 0,
        'inventoryScans': 0, 'status': 'verified-accounted'}
    (root / 'r2-storage-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return report


def main():
    from r2_store import connect, publication_lease, get_json, INDEX_KEY
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='*')
    parser.add_argument('--cleanup-only', action='store_true')
    args = parser.parse_args()
    if not args.paths and not args.cleanup_only:
        parser.error('Specify updater output paths; full-repository staging is retired')
    client, bucket = connect()
    with publication_lease(client, bucket) as lease:
        registry, _ = get_json(client, bucket, INDEX_KEY, {'version': 1, 'files': {}})
        sync(client, bucket, selected=args.paths, registry=registry, lease=lease, cleanup_only=args.cleanup_only)


if __name__ == '__main__':
    main()
