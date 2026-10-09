"""Read-only publication smoke check: public CORS, complete and partial bytes."""
import json
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = 'https://northweather.app'
BASES = ['https://data.northweather.app/weather/',
         'https://raw.githubusercontent.com/Snowblind54/weather-page/weather-fallback/']


def main():
    data = json.loads((ROOT/'data/radar-tiles.json').read_text())
    records = [f for f in data['frames'] if f.get('archive')]
    if not records:
        raise RuntimeError('No archived radar frames published')
    record = max(records, key=lambda f: f['archive']['bytes'])
    path = record['archive']['path']; local = (ROOT/path).read_bytes()
    errors = []
    for base in BASES:
        try:
            for partial in [False, True]:
                headers = {'Origin': ORIGIN, 'User-Agent': 'NorthernWeather-radar-verification/1.0'}
                end = min(len(local), 16384)-1
                if partial: headers['Range'] = f'bytes=0-{end}'
                request = urllib.request.Request(base+path, headers=headers)
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.headers.get('Access-Control-Allow-Origin') not in ['*', ORIGIN]:
                        raise RuntimeError('Radar archive browser CORS is missing')
                    body = response.read(8*1024*1024+1)
                    expected = local[:end+1] if response.status == 206 else local
                    if body != expected:
                        raise RuntimeError('Public radar archive byte mismatch')
                    if partial and response.status not in [200, 206]:
                        raise RuntimeError('Public radar range request rejected')
                    print('Verified', 'range' if partial else 'whole', response.status,
                          len(body), 'bytes;', base, 'cache:', response.headers.get('CF-Cache-Status', 'n/a'), flush=True)
            print('Published archive frames:', len(records), '; one upload per frame.', flush=True)
            return
        except Exception as exc:
            errors.append(str(exc))
    raise RuntimeError('Public archive verification failed: '+'; '.join(errors))


if __name__ == '__main__':main()
