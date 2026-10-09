"""R2 credentials and a conditional, renewable publication lease."""
from contextlib import contextmanager
import json
import os
import re
import threading
import time
import uuid

LOCK_KEY = '_weather/control/publish-lock.json'
INDEX_KEY = '_weather/control/registry.json'


def error_code(exc):
    return getattr(exc, 'response', {}).get('Error', {}).get('Code')


def connect():
    from r2_usage_guard import ensure_allowed
    ensure_allowed()
    import boto3
    from botocore.config import Config
    required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError('Missing GitHub secrets: ' + ', '.join(missing))
    match = re.search(r'https://[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com', os.environ['R2_ENDPOINT'].strip(), re.I)
    if not match:
        raise RuntimeError('R2_ENDPOINT must be the HTTPS S3 account endpoint ending in .r2.cloudflarestorage.com')
    client = boto3.client('s3', endpoint_url=match.group(0).lower(), region_name='auto',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'].strip(), aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'].strip(),
        config=Config(max_pool_connections=32, connect_timeout=15, read_timeout=60,
            retries={'max_attempts': 5, 'mode': 'standard'},
            request_checksum_calculation='when_required', response_checksum_validation='when_required'))
    client.meta.events.register('before-call.s3', ensure_allowed)
    return client, os.environ['R2_BUCKET'].strip()


def get_json(client, bucket, key, default=None):
    try:
        result = client.get_object(Bucket=bucket, Key=key)
        return json.loads(result['Body'].read()), result['ETag']
    except Exception as exc:
        if error_code(exc) in ['NoSuchKey', '404', 'NotFound']:
            return default, None
        raise


class Lease:
    def __init__(self, client, bucket, ttl=300):
        self.client, self.bucket, self.ttl = client, bucket, ttl
        self.owner, self.etag = uuid.uuid4().hex, None
        self.mutex, self.stop, self.failure = threading.Lock(), threading.Event(), None

    def write(self, expires, **condition):
        body = json.dumps({'owner': self.owner, 'expires': expires}).encode()
        result = self.client.put_object(Bucket=self.bucket, Key=LOCK_KEY, Body=body,
            ContentType='application/json', CacheControl='no-store', **condition)
        self.etag = result['ETag']

    def acquire(self, wait_seconds=900):
        deadline = time.monotonic() + wait_seconds
        while True:
            current, etag = get_json(self.client, self.bucket, LOCK_KEY)
            try:
                if current is None:
                    self.write(time.time() + self.ttl, IfNoneMatch='*')
                    break
                if current.get('expires', 0) < time.time():
                    self.write(time.time() + self.ttl, IfMatch=etag)
                    break
            except Exception as exc:
                if error_code(exc) not in ['PreconditionFailed', 'ConditionalRequestConflict', '412', '409']:
                    raise
            if time.monotonic() >= deadline:
                raise RuntimeError('Another R2 publisher holds the lease; keeping last successful data')
            time.sleep(3)
        self.thread = threading.Thread(target=self.heartbeat, daemon=True)
        self.thread.start()

    def heartbeat(self):
        while not self.stop.wait(30):
            try:
                with self.mutex:
                    self.write(time.time() + self.ttl, IfMatch=self.etag)
            except Exception as exc:
                self.failure = exc
                return

    def check(self):
        if self.failure:
            raise RuntimeError('R2 publication lease lost; withholding new manifests') from self.failure

    def close(self):
        self.stop.set()
        self.thread.join(timeout=150)
        if not self.failure:
            with self.mutex:
                self.write(0, IfMatch=self.etag)


@contextmanager
def publication_lease(client, bucket):
    lease = Lease(client, bucket)
    lease.acquire()
    try:
        yield lease
    finally:
        lease.close()
