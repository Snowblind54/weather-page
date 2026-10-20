import concurrent.futures as f,datetime as dt,json,re,sys,urllib.parse
sys.path.insert(0,'scripts')
import update_official_wind as w
base='https://opendata.shmu.sk/meteorology/climate/now/'
def links(raw,url):
 return [urllib.parse.urljoin(url,h) for h in re.findall(r'href="([^"]+)"',raw.decode('utf8','replace')) if h not in ('../','./') and not h.startswith('?') and not h.startswith('/icons') and not h.startswith('/manual')]
def inspect(name,url):
 try:
  raw=w.download(url);print('PROBE_JSON '+json.dumps({'key':name,'url':url,'value':raw.decode('utf8','replace')[:18000]}),flush=True);return raw
 except Exception as e:print('PROBE_JSON '+json.dumps({'key':name,'url':url,'value':'ERROR '+str(e)}),flush=True)
def metadata():
 url=base+'metadata/';raw=inspect('sk-metadata-list',url)
 if raw:
  for i,child in enumerate([u for u in links(raw,url) if u.endswith(('.json','.csv','.txt','.xml'))][:5]):inspect('sk-metadata-'+str(i),child)
def data():
 url=base+'data/'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'/'
 raw=inspect('sk-data-list',url)
 if raw:
  children=links(raw,url)
  if children:
   child=children[-1];body=inspect('sk-data-latest',child)
   if child.endswith('/') and body:
    grand=links(body,child)
    if grand:inspect('sk-data-sample',grand[-1])
with f.ThreadPoolExecutor(max_workers=2) as p:
 for r in p.map(lambda fn:fn(),[metadata,data]):pass
