"""Inspect public official rainfall formats from the deployment network."""
import urllib.request,json,concurrent.futures,datetime as dt,re
URLS={
'poi-sk':'https://opendata.dwd.de/weather/weather_reports/poi/11934-BEOB.csv',
'poi-lu':'https://opendata.dwd.de/weather/weather_reports/poi/06590-BEOB.csv',
'lib':'https://opendata.dwd.de/weather/lib/',
'catalogue':'https://opendata.dwd.de/weather/lib/MOSMIX_station_catalogue.cfg',
'dwd-hour-list':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/recent/',
'dwd-ten-list':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/precipitation/now/',
'poi-list':'https://opendata.dwd.de/weather/weather_reports/poi/',
'mosmix':'https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/',
'mosmix-meta':'https://opendata.dwd.de/weather/lib/poi.cfg',
'mosmix-catalogue':'https://opendata.dwd.de/weather/lib/mosmix_stationskatalog.cfg',
'dwd-rain-meta':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/recent/RR_Stundenwerte_Beschreibung_Stationen.txt',
'dwd-rain-list':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/hourly/precipitation/now/',
'lu-openapi':'https://metapi.ana.lu/api/v1/openapi.json',
'lu-meta':'https://metapi.ana.lu/api/v1/hvd/observations/metadata',
'lu-obs':'https://metapi.ana.lu/api/v1/hvd/observations',
'sk-directory':'http://opendata.shmu.sk/meteorology/climate/now/',
}
def get(pair):
 k,u=pair
 try:
  with urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'NorthernWeather/1.0'}),timeout=30) as r:b=r.read()
  t=b.decode('utf8',errors='replace')
  if k=='lu-openapi':
   p=json.loads(t);t=json.dumps({'paths':p.get('paths'),'schemas':p.get('components',{}).get('schemas')},ensure_ascii=False)
  if k=='lu-meta':
   p=json.loads(t);t=json.dumps([x for x in p.get('data',[]) if any(s in str(x).lower() for s in ['rain','precip','rr'])],ensure_ascii=False)
  if k=='poi-list':t=json.dumps(re.findall(r'href="([0-9]{5}-BEOB.csv)"',t))
  if k in ('mosmix-catalogue','catalogue'):t='\n'.join(l for l in t.splitlines() if l[:5].strip().isdigit() and (l[:2] in ('03','12','11','06') or l[:3]=='039'))
  return k,len(b),t[:26000]
 except Exception as e:return k,str(e)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
 for r in pool.map(get,URLS.items()):print('RAIN_SOURCE_PROBE '+json.dumps(r,ensure_ascii=False),flush=True)
