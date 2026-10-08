"""Publish scoped weather data in R2, expire unused files and refuse >8 GB writes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
import json
import mimetypes
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'weather/'
BUDGET = 8_000_000_000
INDEX_RESERVE = 10_000_000


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
    if key.startswith((PREFIX + 'data/radar-tiles/', PREFIX + 'data/radar-cache/')):
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


def sync(client, bucket, root=ROOT, now=None, selected=None, registry=None, lease=None, cleanup_only=False):
    from r2_store import INDEX_KEY
    now, selected = now or datetime.now(timezone.utc), scopes(selected)
    registry = registry if registry is not None else {'version': 1, 'files': {}}
    entries = dict(registry.get('files', {}))
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
    # Keep the previous live assets until all replacement manifests succeed.
    protected = {key for key, entry in entries.items() if entry.get('protected')} | set(files) | set(registry.get('pending', []))
    objects = inventory(client, bucket)
    expired = expired_keys(objects, protected, now)
    for start in range(0, len(expired), 1000):
        if lease: lease.check()
        result = client.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': k} for k in expired[start:start + 1000]], 'Quiet': True})
        if result.get('Errors'):
            raise RuntimeError('Expiry deletion failed; aborting uploads')
    objects = inventory(client, bucket)
    total = sum(obj['Size'] for obj in objects.values())

    def changed(item):
        key, path = item
        size, digest = path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()
        existing, cached = objects.get(key), entries.get(key, {})
        if existing and existing['Size'] == size:
            if cached.get('sha256') == digest and cached.get('etag') == existing.get('ETag'):
                return None
            head = client.head_object(Bucket=bucket, Key=key)
            if head.get('Metadata', {}).get('sha256') == digest:
                entries[key] = {'sha256': digest, 'size': size, 'etag': head['ETag']}
                return None
        return (key, size, digest)

    with ThreadPoolExecutor(max_workers=24) as pool:
        changes = [item for item in pool.map(changed, files.items()) if item]
    peak = plan_peak(total, changes) + INDEX_RESERVE
    if peak > BUDGET:
        raise RuntimeError(f'8 GB storage guard: incoming files and metadata would require {peak} bytes; no uploads performed')

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
        entries[key] = {'sha256': digest, 'size': size, 'etag': head['ETag']}

    assets = [item for item in changes if item[0].count('/') != 2]
    manifests = [item for item in changes if item[0].count('/') == 2]
    with ThreadPoolExecutor(max_workers=24) as pool:
        list(pool.map(upload, assets))
    print('Verified assets; publishing current manifests.', flush=True)
    if manifests:
        # Write an intent before changing any manifest. If a later PUT fails,
        # cleanup still protects every verified asset the live map may use.
        intent = dict(registry, pending=list(files))
        if lease: lease.check()
        client.put_object(Bucket=bucket, Key=INDEX_KEY, Body=json.dumps(intent).encode(),
            ContentType='application/json', CacheControl='no-store')
    for item in manifests:
        upload(item)
    for key in list(entries):
        if key in expired:
            del entries[key]
        elif not cleanup_only and in_scope(key, selected):
            entries[key]['protected'] = key in files
    for key, path in files.items():
        entries[key]['protected'] = True
        entries[key]['generation'] = generation(path)
    body = json.dumps({'version': 1, 'files': entries}, separators=(',', ':')).encode()
    if len(body) > INDEX_RESERVE:
        raise RuntimeError('Publication registry exceeded its reserved metadata budget')
    if lease: lease.check()
    client.put_object(Bucket=bucket, Key=INDEX_KEY, Body=body, ContentType='application/json', CacheControl='no-store')
    stored = sum(obj['Size'] for obj in inventory(client, bucket).values())
    if stored > BUDGET:
        raise RuntimeError('Bucket exceeded the guarded budget; check external writers')
    report = {'generatedAt': now.isoformat(), 'budgetBytes': BUDGET, 'bucketBytes': stored,
        'managedFiles': len(files), 'uploadedFiles': len(changes), 'expiredFiles': len(expired), 'status': 'verified'}
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
