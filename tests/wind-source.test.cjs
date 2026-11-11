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

test('a legacy snapshot is rechecked promptly while hemispheric coverage is being published',async()=>{
 const h=harness();h.run('windData={version:3,savedAt:Date.now()-61000,times:[0,200],grids:[]};');
 await h.run('loadWind()');assert.equal(h.calls.length,1);
});

test('an expired HTTP-200 primary tries the independent snapshot without re-dating old data',async()=>{
 const h=harness();h.c.weatherGithubDataUrl=()=> 'https://backup.example/model-wind.json';
 h.c.fetch=async url=>{h.calls.push(url);return {ok:true,json:async()=>({version:3,savedAt:1,times:url.startsWith('https://backup')?[0,200]:[-9000,-8000],grids:[[[[2,3,4]]]]})};};
 await h.run('loadWind()');
 assert.equal(h.calls.length,2);assert.match(h.calls[1],/^https:\/\/backup/);
 assert.equal(h.run('windData.times.at(-1)'),200);
 h.run('windData=null');h.c.weatherGithubDataUrl=undefined;
 await assert.rejects(h.run('loadWind()'),/temporarily unavailable/);
 assert.equal(h.run('windData'),null);
});
test('heatmap-only load errors replace the loading message and keep any usable cache visible',()=>{
 const h=harness();h.elements.windOn.checked=false;h.elements.windHeatmapOn.checked=true;h.elements.windHeatmapStatus={textContent:'Loading wind heatmap…'};
 vm.runInContext(source.slice(source.indexOf('function reportWindError('),source.indexOf('async function loadWind(')),h.c);
 h.c.console={warn(){}};
 h.c.renderWindHeatmap=()=>false;h.c.error=new Error('Model update unavailable.');
 h.run('reportWindError(error)');
 assert.match(h.elements.windHeatmapStatus.textContent,/Wind heatmap unavailable/);
 h.c.renderWindHeatmap=()=>true;h.run('reportWindError(error)');
 assert.match(h.elements.windHeatmapStatus.textContent,/Showing cached wind heatmap/);
});
test('visible wind periodically refreshes and returning to the tab rechecks it',()=>{
 const h=harness();let tick,visibility,loads=0;h.c.document={hidden:false,addEventListener:(name,fn)=>{assert.equal(name,'visibilitychange');visibility=fn;}};
 h.c.setInterval=(fn,ms)=>{assert.equal(ms,300000);tick=fn;};
 h.c.loadWind=async()=>{loads++;};h.c.reportWindError=()=>{};
 vm.runInContext(source.slice(source.indexOf('function refreshVisibleWind(')),h.c);
 tick();assert.equal(loads,1);
 h.c.document.hidden=true;tick();assert.equal(loads,1);
 h.c.document.hidden=false;visibility();assert.equal(loads,2);
 h.elements.windOn.checked=false;tick();assert.equal(loads,2);
});
