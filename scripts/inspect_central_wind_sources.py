import sys,json,re,datetime as dt
sys.path.insert(0,'scripts')
import update_official_wind as w
url='http://opendata.shmu.sk/meteorology/climate/now/data/'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')+'/'
raw=w.download(url).decode('utf8');names=re.findall(r'href="(aws1min[^"]+[.]json)"',raw)
print('PROBE_JSON '+json.dumps({'key':'latest-files','value':names[-3:]}),flush=True)
for i,name in enumerate(names[-2:]):
 p=json.loads(w.download(url+name))
 if isinstance(p,list):out={'url':url+name,'count':len(p),'rows':p[:3],'last':p[-1:]}
 else:out={'url':url+name,'data':str(p)[:18000]}
 print('PROBE_JSON '+json.dumps({'key':'sample-'+str(i),'value':out}),flush=True)
