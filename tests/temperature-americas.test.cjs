const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../js/temperature.js'),'utf8');
function harness(){
  const c={console,Date,Map,Set,Math,Number,JSON,AbortController,setTimeout,clearTimeout,
    map:{on(){}},temperatureImageCache:new Map(),temperatureStatsCache:new Map(),
    localStorage:{getItem:()=>null},temperatureSeries:[],temperatureLoadedAt:0};
  vm.createContext(c);const run=s=>vm.runInContext(s,c);run(source);
  const specs=run('TEMP_GRID_SPECS.filter(s=>s.shared)');
  const time=Math.floor(Date.now()/3600000)*3600;
  const data={version:1,generatedAt:Date.now()/1000,grids:Object.fromEntries(specs.map(s=>[s.id,
    {latitudes:Array.from(s.latitudes),longitudes:Array.from(s.longitudes),series:Array.from(s.points,([lat,lon])=>({lat,lon,times:[time-3600,time+3600],temps:[-5,-3]}))}]))};
  c.data=data;return {c,run,data,time,specs};
}
test('Canada and Greenland grids match the shared collector, masks, and timeline interpolation',()=>{
  const h=harness();assert.equal(h.specs.reduce((n,s)=>n+s.points.length,0),706);
  assert(h.run('validateAmericasTemperatureSnapshot(data)'));
  assert(h.run("TEMP_REGION_COUNTRY_IDS.canada.has('124')&&TEMP_REGION_COUNTRY_IDS.greenland.has('304')"));
  h.run("temperatureGridData.set('greenland',data.grids.greenland.series)");
  h.c.time=h.time;assert.equal(h.run("sampleGridTemperature(TEMP_GRID_SPECS.find(s=>s.id==='greenland'),64,-51,time)"),-4);
  assert(h.run("Number.isNaN(sampleTemperatureGridPoint(TEMP_GRID_SPECS.find(s=>s.id==='greenland'),data.grids.greenland.series[0],time+7200))"));
});
test('model validation rejects corrupt geometry, future or stale snapshots and missing temperatures',()=>{
  const h=harness();h.data.grids.canada.series[0].lon=0;assert(!h.run('validateAmericasTemperatureSnapshot(data)'));
  const a=harness();a.data.generatedAt+=3600;assert(!a.run('validateAmericasTemperatureSnapshot(data)'));
  a.data.generatedAt=Date.now()/1000-13*3600;assert(!a.run('validateAmericasTemperatureSnapshot(data)'));
  const b=harness();b.data.grids.greenland.series[0].temps=[null,null];assert(!b.run('validateAmericasTemperatureSnapshot(data)'));
});
test('shared heatmap loads deduplicate concurrent requests and retain usable data after a failed refresh',async()=>{
  const h=harness();let requests=0;h.c.fetch=async url=>{requests++;assert.match(url,/^data\/temperature-americas-model.json/);return {ok:true,json:async()=>h.data};};
  await Promise.all([h.run('loadAmericasTemperatureData()'),h.run('loadAmericasTemperatureData()')]);
  assert.equal(requests,1);await h.run('loadAmericasTemperatureData()');assert.equal(requests,1);
  h.c.fetch=async()=>({ok:false,status:503});await assert.rejects(h.run('loadAmericasTemperatureData(true)'),/HTTP 503/);
  assert.equal(h.run('americasTemperaturePromise'),null);assert.equal(h.run("temperatureGridData.get('canada').length"),h.data.grids.canada.series.length);
});
test('official station bounds accept the new countries without relaxing European station bounds',()=>{
  const h=harness();const s=fs.readFileSync(path.join(__dirname,'../js/stations.js'),'utf8');
  h.run(s.slice(s.indexOf('function officialTempValid('),s.indexOf('function officialTempRecord(')));
  assert(h.run("officialTempValid(64,-51,-12,'GL')"));assert(h.run("officialTempValid(49,-123,7,'CA')"));
  assert(!h.run("officialTempValid(49,-123,7,'EE')"));assert(!h.run("officialTempValid(20,-123,7,'CA')"));
  assert(!h.run("officialTempValid(64,-51,null,'GL')"));
});

test('shared regions render while the European temperature request is still pending',async()=>{
  const h=harness();let release,draws=0;
  h.c.pending=new Promise(resolve=>release=resolve);h.c.frames=[{time:h.time}];
  h.c.$=()=>({value:'0',checked:true});h.c.queueTemperatureRender=()=>draws++;
  h.c.fetch=async()=>({ok:true,json:async()=>h.data});
  h.run('ensureTemperatureData=()=>pending;');const loading=h.run('loadTemperatures()');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(draws,1);
  assert(h.run('temperatureSeries.length')>0);release();await loading;assert.equal(draws,2);
});
