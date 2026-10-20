import concurrent.futures as f, urllib.request as u, json, re, io, zipfile, datetime as dt
urls={
'catalogue':'https://opendata.dwd.de/weather/lib/MOSMIX_L_Stationskatalog.cfg',
'poi':'https://opendata.dwd.de/weather/weather_reports/poi/',
'poi_sample':'https://opendata.dwd.de/weather/weather_reports/poi/03044-BEOB.csv',
'poi_description':'https://opendata.dwd.de/weather/weather_reports/poi/description.csv',
'wind_list':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/wind/now/',
'gust_list':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/extreme_wind/now/',
'wind_metadata':'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/wind/recent/zehn_min_ff_Beschreibung_Stationen.txt',
'lu':'https://metapi.ana.lu/api/v1/hvd/observations',
'lu_metadata':'https://metapi.ana.lu/api/v1/hvd/stations/LUX0000001',
'lu_openapi':'https://metapi.ana.lu/api/v1/openapi.json',
'be':'https://opendata.meteo.be/service/aws/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=aws:aws_10min&outputFormat=application/json&srsName=EPSG:4326&count=2&sortBy=timestamp%20D'
}
def download(url):
 with u.urlopen(u.Request(url,headers={'User-Agent':'NorthernWeather official wind integration'}),timeout=45) as r:return r.read()
def collect(pair):
 key,url=pair
 try:
  raw=download(url);text=raw.decode('latin1' if key in ('poi_sample','poi_description','wind_metadata') else 'utf8')
  if key=='catalogue':out='\n'.join(text.splitlines()[:3]+[s for s in text.splitlines() if re.match(r'^03[01][0-9]{2} ',s)])
  elif key=='poi':out=' '.join(re.findall(r'href="(03[01][0-9]{2}-BEOB.csv)"',text))
  elif key.endswith('_list'):
   files=re.findall(r'href="([^"]+_now.zip)"',text);out=json.dumps(files[:3])+f' COUNT={len(files)}'
   if files:
    b=download(url+files[0]);z=zipfile.ZipFile(io.BytesIO(b));name=next(n for n in z.namelist() if n.startswith('produkt_'));out+='\n'+'\n'.join(z.read(name).decode('latin1').splitlines()[:5])
  elif key=='wind_metadata':out='\n'.join(text.splitlines()[:5])
  elif key=='lu_openapi':
   p=json.loads(text);out=json.dumps({'paths':list(p.get('paths',{})),'schemas':p.get('components',{}).get('schemas',{})})[:16000]
  else:out=text[:14000]
  return key,out
 except Exception as e:return key,'ERROR '+str(e)
with f.ThreadPoolExecutor(max_workers=8) as p:
 for key,out in p.map(collect,urls.items()):print('PROBE_JSON '+json.dumps({'key':key,'value':out}),flush=True)
