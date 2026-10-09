const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/wind.js'),'utf8');
function harness(){
  const elements={windOn:{checked:true},windHeatmapOn:{checked:false},windStatus:{}};
  const calls=[],draws=[],stored=[];
  const c={AbortController,Date,console,setTimeout,clearTimeout,
    $:id=>elements[id],windVisualEnabled:()=>elements.windOn.checked||elements.windHeatmapOn.checked,
    selectedWindTime:()=>100,renderWind:t=>draws.push(['wind',t]),renderWindHeatmap:t=>draws.push(['heatmap',t]),
    validWindData:d=>d.version===3,localStorage:{setItem:(...args)=>stored.push(args)},
    fetch:async(url)=>{calls.push(url);return {ok:true,json:async()=>({version:3,savedAt:1,times:[0,200],grids:[[[[2,3,4]]]]})};}};
  vm.createContext(c);
  vm.runInContext("const SHARED_WIND_URL='data/model-wind.json',WIND_CACHE_KEY='wind',WIND_CACHE_MS=2700000;let windData=null,windLoadPromise=null,windRetryAt=0;",c);
  vm.runInContext(source.slice(source.indexOf('async function fetchWindData(){'),source.indexOf('function selectedWindTime')),c);
  vm.runInContext(source.slice(source.indexOf('async function loadWind(){'),source.indexOf('function windTimeSlice')),c);
  return {c,elements,calls,draws,stored,run:s=>vm.runInContext(s,c)};
}
test('wind uses the shared snapshot immediately and reuses its receipt-time cache',async()=>{
  const h=harness();await h.run('loadWind()');await h.run('loadWind()');
  assert.equal(h.calls.length,1);assert.match(h.calls[0],/^data\/model-wind\.json\?v=\d+$/);
  assert.equal(h.run('windData.generatedAt'),1);assert(h.run('windData.savedAt')>1);assert.equal(h.stored.length,1);
});
test('concurrent wind and heatmap loads share one request and switching off cannot restore either layer',async()=>{
  const h=harness();let release;h.elements.windHeatmapOn.checked=true;
  h.c.fetch=async url=>{h.calls.push(url);await new Promise(r=>release=r);return {ok:true,json:async()=>({version:3,savedAt:1,times:[0,200],grids:[[[[2,3,4]]]]})};};
  const a=h.run('loadWind()'),b=h.run('loadWind()');assert.equal(h.calls.length,1);
  h.elements.windOn.checked=false;h.elements.windHeatmapOn.checked=false;
  const before=h.draws.length;release();await Promise.all([a,b]);assert.equal(h.draws.length,before);assert.equal(h.stored.length,1);
});
test('heatmap-only mode draws its cached field without enabling animation',async()=>{
  const h=harness();h.elements.windOn.checked=false;h.elements.windHeatmapOn.checked=true;
  await h.run('loadWind()');h.draws.length=0;await h.run('loadWind()');
  assert.deepEqual(h.draws,[['heatmap',100]]);assert.equal(h.calls.length,1);
});
test('failed or invalid snapshots clear the pending request and preserve cached wind',async()=>{
  const h=harness();h.run('windData={version:3,savedAt:1,times:[0,200]};');
  h.c.fetch=async()=>({ok:false,status:503});await assert.rejects(h.run('loadWind()'),/temporarily unavailable/);
  assert.equal(h.run('windLoadPromise'),null);assert.equal(h.run('windData.savedAt'),1);
  h.c.fetch=async()=>({ok:true,json:async()=>({version:0})});await assert.rejects(h.run('loadWind()'),/temporarily unavailable/);
  assert.equal(h.run('windLoadPromise'),null);assert.equal(h.stored.length,0);
});
test('a recently downloaded snapshot is refreshed if it no longer covers the selected time',async()=>{
 const h=harness();h.run('windData={version:3,savedAt:Date.now(),times:[0,99]};');
 await h.run('loadWind()');assert.equal(h.calls.length,1);
 assert.equal(h.run('windData.times.at(-1)'),200);
});
