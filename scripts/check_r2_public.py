"""Check public browser access without exposing any credentials."""
import json
import os
import urllib.request

PUBLIC = 'https://pub-c945115e634a4449a06475cf7317df37.r2.dev'
ORIGIN = 'https://snowblind54.github.io'


def main():
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
    import re
    endpoint = re.search(r'https://[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com',
                         os.environ['R2_ENDPOINT'].strip(), re.I).group(0)
    client = boto3.client('s3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(request_checksum_calculation='when_required', response_checksum_validation='when_required'))
    rule = {'AllowedOrigins': [ORIGIN], 'AllowedMethods': ['GET', 'HEAD'],
            'AllowedHeaders': ['*'], 'ExposeHeaders': ['ETag'], 'MaxAgeSeconds': 3600}
    try:
        try:
            rules = client.get_bucket_cors(Bucket=os.environ['R2_BUCKET'])['CORSRules']
        except ClientError as exc:
            if exc.response['Error']['Code'] not in ['NoSuchCORSConfiguration', 'NoSuchCORS']:
                raise
            rules = []
        if rule not in rules:
            client.put_bucket_cors(Bucket=os.environ['R2_BUCKET'], CORSConfiguration={'CORSRules': rules + [rule]})
        print('Browser CORS configured for the current website.')
    except ClientError:
        print('Object credentials cannot manage bucket CORS. Check public response; dashboard configuration may be needed.')
    request = urllib.request.Request(PUBLIC + '/weather/data/radar-tiles.json', headers={
        'Origin': ORIGIN, 'User-Agent': 'NorthernWeather-R2-Migration/1.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
        cors = response.headers.get('Access-Control-Allow-Origin')
    if cors not in [ORIGIN, '*']:
        raise RuntimeError('Public files exist but browser CORS is missing. Add GET/HEAD CORS for https://snowblind54.github.io in the R2 bucket Settings.')
    if data.get('version') != 1 or not isinstance(data.get('frames'), list):
        raise RuntimeError('Public radar manifest failed validation')
    print('Public R2 radar manifest verified; frames:', len(data['frames']))


if __name__ == '__main__':
    main()
