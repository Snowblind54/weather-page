const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
function harness(){
  const context={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,
    localStorage:{getItem:()=>null,setItem(){}},loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/stations.js'),'utf8'));
  return {context,run};
}
test('identical in-flight official station requests share a download; later calls still fetch fresh data',async()=>{
  const h=harness();let release,calls=0;
  h.context.pending=new Promise(resolve=>release=resolve);
  h.context.fetch=async()=>{calls++;return h.context.pending;};
  const a=h.run('officialTempFetch("https://official.example/observations",{json:true})');
  const b=h.run('officialTempFetch("https://official.example/observations",{json:true})');
  assert.equal(calls,1);
  release({ok:true,json:async()=>({temperature:8})});
  assert.equal((await a).temperature,8);assert.equal((await b).temperature,8);
  await h.run('officialTempFetch("https://official.example/observations",{json:true})');
  assert.equal(calls,2,'completed responses are not reused as stale readings');
});
test('shared station failure is cleared and the next refresh can recover',async()=>{
  const h=harness();let calls=0;
  h.context.fetch=async()=>{calls++;throw new Error('offline');};
  const a=h.run('officialTempFetch("https://official.example/observations")');
  const b=h.run('officialTempFetch("https://official.example/observations")');
  const result=await Promise.allSettled([a,b]);assert(result.every(r=>r.status==='rejected'));
  assert.equal(calls,2,'one direct attempt and one existing fallback for both callers');
  h.context.fetch=async()=>{calls++;return {ok:true,text:async()=>'<observations/>'};};
  assert.equal(await h.run('officialTempFetch("https://official.example/observations")'),'<observations/>');
  assert.equal(calls,3);
});
test('manual temperature refresh joins the active collection and retains the ten-minute cadence',async()=>{
  const h=harness();let release,calls=0;
  h.context.pending=new Promise(resolve=>release=resolve);
  h.context.loader=async()=>{calls++;return h.context.pending;};
  h.run('OFFICIAL_TEMP_LOADERS.splice(0,OFFICIAL_TEMP_LOADERS.length,["EE",loader]);');
  const a=h.run('loadOfficialTemperatureStations()');
  const b=h.run('loadOfficialTemperatureStations(true)');assert.equal(calls,1);
  release([{country:'EE',code:'1',name:'A',lat:59,lon:25,temp:8,time:Date.now()/1000,source:'Official'}]);
  await Promise.all([a,b]);assert.equal(calls,1);
  await h.run('loadOfficialTemperatureStations()');assert.equal(calls,1);
  await h.run('loadOfficialTemperatureStations(true)');assert.equal(calls,2,'a subsequent manual refresh stays immediate');
  h.run('officialTemperatureLoadedAt=Date.now()-10*60*1000;');
  await h.run('loadOfficialTemperatureStations()');assert.equal(calls,3);
});
