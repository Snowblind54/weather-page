"""Small immutable, range-readable archives of unchanged PNG radar tiles.

8-byte magic, little-endian JSON index length, JSON index, concatenated PNGs.
Offsets are relative to the payload. .bin is a standard CDN-cacheable extension.
"""
import json
import struct
import pathlib
import hashlib

MAGIC = b'NWRAD001'
MAX_INDEX = 65536
MAX_SIZE = 8 * 1024 * 1024


def pack_tiles(directory, target, indices):
    entries = {}; payload = bytearray()
    for zoom, rows in sorted(indices.items(), key=lambda v: int(v[0])):
        for coordinate in sorted(rows):
            relative = f'{zoom}/{coordinate}'
            path = directory / (relative + '.png')
            data = path.read_bytes()
            if not data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Invalid radar PNG')
            entries[relative] = [len(payload), len(data)]
            payload.extend(data)
    index = json.dumps({'tiles': entries, 'payloadBytes': len(payload)}, separators=(',', ':')).encode()
    body = MAGIC + struct.pack('<I', len(index)) + index + payload
    if len(index) > MAX_INDEX or len(body) > MAX_SIZE:
        raise ValueError('Radar frame archive exceeds safety budget')
    # Check every original tile before publication; packing never re-encodes it.
    start = 12 + len(index)
    for key, (offset, length) in entries.items():
        if body[start+offset:start+offset+length] != (directory/(key+'.png')).read_bytes():
            raise ValueError('Radar archive verification failed')
    temporary = target.with_suffix('.tmp')
    temporary.write_bytes(body)
    temporary.replace(target)
    return {'version': 1, 'path': 'data/radar-tiles/'+target.name,
            'bytes': len(body), 'index_bytes': start,
            'sha256': hashlib.sha256(body).hexdigest()}
