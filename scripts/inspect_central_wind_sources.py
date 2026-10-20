import sys,json,re,datetime as dt,urllib.parse
sys.path.insert(0,'scripts')
import update_official_wind as w
base='http://opendata.shmu.sk/meteorology/climate/now/'
def show(k,v):print('PROBE_JSON '+json.dumps({'key':k,'value':v}),flush=True)
for name in ['aws1min-metadata.txt','aws1min_metadata.json']:
 try:show(name,w.download(base+'metadata/'+name).decode('utf8','replace'))
 except Exception as e:show(name,'ERROR '+str(e))
url=base+'data/'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'/'
try:
 raw=w.download(url).decode('utf8')
 files=re.findall(r'href="(aws1min[^"]+\\.json)"',raw)
 show('latest-files',files[-3:])
 for i,name in enumerate(files[-2:]):
  p=json.loads(w.download(url+name))
  if isinstance(p,list):show('sample-'+str(i),{'url':url+name,'count':len(p),'rows':p[:3],'last':p[-1:]})
  else:show('sample-'+str(i),{'url':url+name,'data':str(p)[:18000]})
except Exception as e:show('sample-error',str(e))
