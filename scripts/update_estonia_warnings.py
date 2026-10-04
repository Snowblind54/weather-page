"""Copy the full official four-day forecast, including grouped county alerts.

The legacy KAIA warnings.xml omits forecast county alerts. The warning page
publishes its complete map data as inline JSON; parse that JSON without eval.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

SOURCE = 'https://www.ilmateenistus.ee/ilm/prognoosid/hoiatused/'
# Official EHAK county codes (teabekeskus.tehik.ee/et/loendid/ehak/2025v2).
REGIONS = {
    '37': 'Harju maakond', '39': 'Hiiu maakond', '45': 'Ida-Viru maakond',
    '50': 'Jõgeva maakond', '52': 'Järva maakond', '56': 'Lääne maakond',
    '60': 'Lääne-Viru maakond', '64': 'Põlva maakond', '68': 'Pärnu maakond',
    '71': 'Rapla maakond', '74': 'Saare maakond', '79': 'Tartu maakond',
    '81': 'Valga maakond', '84': 'Viljandi maakond', '87': 'Võru maakond',
    '99993': 'Peipsi järv', '99995': 'Soome lahe idaosa',
    '99996': 'Soome lahe lääneosa', '99997': 'Läänemere põhjaosa',
    '99998': 'Väinameri', '99999': 'Liivi lahe põhjaosa',
}


def parse_forecast(page):
    match = re.search(r'_var\["warningsData"\]\s*=\s*', page)
    if not match:
        raise ValueError('Official forecast JSON was not found')
    forecast, _ = json.JSONDecoder().raw_decode(page[match.end():])
    if not isinstance(forecast, dict) or not forecast:
        raise ValueError('Official forecast has no calendar days')
    records = {}
    for day, bucket in forecast.items():
        datetime.strptime(day, '%Y-%m-%d')
        for group in bucket['DATA'].values():
            for row in group['ROWS']:
                if row['status'] != 'PUBLIC' or int(row['warning_level']) == 0:
                    continue
                start = datetime.fromisoformat(row['onset'])
                end = datetime.fromisoformat(row['expires'])
                if not start.tzinfo or not end.tzinfo or end <= start:
                    raise ValueError('Invalid official warning validity')
                level = int(row['warning_level'])
                if level not in (1, 2, 3):
                    raise ValueError('Unknown official warning level')
                areas = [str(int(code.strip())) for code in row['region_ids'].split(',')]
                for code in areas:
                    if code not in REGIONS:
                        raise ValueError('Unknown official warning region: ' + code)
                    record = {
                        'id': str(row['id']), 'regionId': code,
                        'country': 'Estonia', 'area': REGIONS[code],
                        'event': row['warning_type_eng'] or row['warning_type_est'],
                        'level': level,
                        'effective': start.astimezone(timezone.utc).isoformat(),
                        'expires': end.astimezone(timezone.utc).isoformat(),
                        'description': row['alert_text_eng'] or row['alert_text_est'],
                        'descriptionEstonian': row['alert_text_est'],
                        'preAlert': str(row.get('pre_alert', '')).lower() == 'true',
                    }
                    # Day buckets repeat spanning warnings. Retain distinct time
                    # segments of the same alert, rather than deduplicating by ID.
                    key = json.dumps(record, sort_keys=True, ensure_ascii=False)
                    records[key] = record
    return sorted(forecast), sorted(records.values(), key=lambda r: (r['effective'], r['regionId'], r['id']))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, help='Saved official HTML for validation')
    parser.add_argument('--output', type=Path, default=Path('data/estonia-warnings.json'))
    args = parser.parse_args()
    if args.input:
        page = args.input.read_text(encoding='utf-8')
    else:
        request = Request(SOURCE, headers={'User-Agent': 'NorthernWeather/1.0 (+https://snowblind54.github.io/weather-page/)', 'Accept': 'text/html'})
        with urlopen(request, timeout=45) as response:
            page = response.read().decode('utf-8')
    days, records = parse_forecast(page)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if today > max(days):
        raise ValueError('Official forecast page is out of date')
    snapshot = {'schemaVersion': 1, 'source': SOURCE,
                'fetchedAt': datetime.now(timezone.utc).isoformat(),
                'forecastDays': days, 'records': records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(args.output)
    print(f'Saved {len(records)} official Estonia forecast warning areas')


if __name__ == '__main__':
    main()
