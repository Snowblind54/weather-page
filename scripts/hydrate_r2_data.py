"""Restore only an updater's input scope, including its last successful data."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import sys
from r2_store import connect, get_json, INDEX_KEY, publication_lease
from sync_r2_data import ROOT, PREFIX, scopes, in_scope, inventory


def hydrate(client, bucket, selected, root=ROOT, lease=None):
    selected = scopes(selected)
    registry, _ = get_json(client, bucket, INDEX_KEY)
    if not registry or not registry.get('files'):
        raise RuntimeError('R2 publication registry must be initialized before updater inputs')
    objects = {key: {'Size': value['size'], 'ETag': value['etag'], 'sha256': value['sha256']}
               for key, value in registry['files'].items() if value.get('protected') and in_scope(key, selected)}
    if not objects:
        raise RuntimeError('R2 input scope is empty; refusing a fresh empty archive')

    def restore(item):
        key, obj = item
        path = root / key[len(PREFIX):]
        if not path.resolve().is_relative_to((root / 'data').resolve()):
            raise ValueError('Remote data key escapes data/')
        if path.is_file() and path.stat().st_size == obj['Size']:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if obj['sha256'] == digest:
                return
        if lease: lease.check()
        response = client.get_object(Bucket=bucket, Key=key, IfMatch=obj['ETag'])
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.r2tmp')
        with temporary.open('wb') as dest:
            body = response['Body']
            try:
                for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                    dest.write(chunk)
            finally:
                body.close()
        if temporary.stat().st_size != response['ContentLength']:
            temporary.unlink()
            raise RuntimeError('Incomplete R2 input; updater withheld')
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != obj['sha256']:
            temporary.unlink()
            raise RuntimeError('R2 input checksum failed; updater withheld')
        temporary.replace(path)

    with ThreadPoolExecutor(max_workers=24) as pool:
        list(pool.map(restore, objects.items()))
    # Remove retired cached inputs so they cannot become active again.
    for scope in selected:
        source = root / scope
        candidates = [source] if source.is_file() else source.rglob('*')
        for path in candidates:
            if path.is_file() and PREFIX + path.relative_to(root).as_posix() not in objects:
                path.unlink()
    print('Restored R2 updater inputs:', len(objects), flush=True)


if __name__ == '__main__':
    client, bucket = connect()
    with publication_lease(client, bucket) as lease:
        hydrate(client, bucket, sys.argv[1:], lease=lease)
