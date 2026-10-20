import sys,json
sys.path.insert(0,'scripts')
import update_official_wind as w
urls={'poi_sample':'https://opendata.dwd.de/weather/weather_reports/poi/03044-BEOB.csv','lu_wind_metadata':'https://metapi.ana.lu/api/v1/hvd/observations/metadata'}
for key,url in urls.items():
 try:
  raw=w.download(url)
  if key=='poi_sample':value='\n'.join(raw.decode('latin1').splitlines()[:15])
  else:value=json.dumps([p for p in json.loads(raw)['data'] if p.get('category')=='Wind'])
  print('PROBE_JSON '+json.dumps({'key':key,'value':value}),flush=True)
 except Exception as e:print('PROBE_JSON '+json.dumps({'key':key,'value':'ERROR '+str(e)}),flush=True)
