import json,sys,subprocess,re
sys.path.insert(0,'scripts')
import update_official_wind as w
base='http://opendata.shmu.sk/meteorology/climate/now/'
for key,url in [('sk-http-metadata',base+'metadata/'),('sk-http-data',base+'data/20261020/')]:
 try:raw=w.download(url);value=raw.decode('utf8','replace')[:14000]
 except Exception as e:value='ERROR '+str(e)
 print('PROBE_JSON '+json.dumps({'key':key,'url':url,'value':value}),flush=True)
try:
 p=subprocess.run(['openssl','s_client','-connect','opendata.shmu.sk:443','-servername','opendata.shmu.sk','-showcerts','-verify_return_error'],input='',text=True,capture_output=True,timeout=20)
 print('TLS_INFO '+p.stderr[-3000:],flush=True)
 cert=re.search(r'-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----',p.stdout)
 if cert:
  q=subprocess.run(['openssl','x509','-noout','-issuer','-subject','-ext','authorityInfoAccess'],input=cert[0],text=True,capture_output=True)
  print('TLS_CERT '+q.stdout,flush=True)
except Exception as e:print('TLS_INFO '+str(e),flush=True)
