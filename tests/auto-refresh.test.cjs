const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
function harness(){
  let now=0,tick;
  const listeners={},calls=[],els={timeline:{value:2,max:2},cloudOn:{checked:true},radarOn:{checked:true}};
  const c={playing:false,frames:[{time:0},{time:600},{time:1200}],Date:{now:()=>now},Math,Promise,console:{warn(){}},
    $:id=>els[id]||{checked:false},document:{hidden:false,addEventListener:(n,f)=>listeners[n]=f},window:{addEventListener:(n,f)=>listeners[n]=f},
    setInterval:f=>tick=f,temperatureEnabled:()=>false,windVisualEnabled:()=>false,activeAccumulationHours:()=>0,
    loadOfficialRadarList:async o=>calls.push(['radar',o]),cloudEnsureMetadata:async f=>calls.push(['metadata',f]),drawCloud:async f=>calls.push(['cloud',f]),
    loadTemperatures:async()=>{},loadWind:async()=>{},loadWarnings:async()=>{},loadCyclones:async()=>{},loadRainfall:async()=>{}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/auto-refresh.js','utf8'),c);
  return {c,els,calls,listeners,tick:()=>tick(),advance:n=>now+=n};
}
test('Latest refresh discovers satellite times and redraws without a manual click',async()=>{
  const h=harness();h.advance(120000);h.tick();await flush();
  assert.deepEqual(h.calls.map(c=>c[0]),['radar','metadata','cloud']);
  assert.equal(h.calls[0][1].preserveSelection,true);assert.equal(h.calls[0][1].skipCloud,true);
  assert.equal(h.calls[2][1].time,120);
});
test('historical selection refreshes the frame list without drawing latest satellite imagery',async()=>{
  const h=harness();h.els.timeline.value=0;h.advance(120000);h.tick();await flush();
  assert.deepEqual(h.calls.map(c=>c[0]),['radar']);
});
test('history chosen during satellite discovery cannot be overwritten by its response',async()=>{
  const h=harness();let release;h.c.cloudEnsureMetadata=()=>new Promise(r=>release=r);
  h.advance(120000);h.tick();await flush();h.els.timeline.value=0;release();await flush();
  assert(!h.calls.some(c=>c[0]==='cloud'));
});
test('hidden tabs pause, returning triggers a check, and in-flight refreshes are deduplicated',async()=>{
  const h=harness();let release;h.c.cloudEnsureMetadata=()=>new Promise(r=>release=r);
  h.c.document.hidden=true;h.advance(120000);h.tick();await flush();assert.equal(h.calls.length,0);
  h.c.document.hidden=false;h.listeners.visibilitychange();await flush();h.listeners.online();await flush();
  assert.equal(h.calls.filter(c=>c[0]==='radar').length,2);release();await flush();
  assert.equal(h.calls.filter(c=>c[0]==='cloud').length,1);
});
test('a radar failure does not prevent the satellite refresh',async()=>{
  const h=harness();h.c.loadOfficialRadarList=async()=>{throw Error('offline');};h.advance(120000);h.tick();await flush();
  assert(h.calls.some(c=>c[0]==='cloud'));
});
test('frame replacement follows Latest, retains history, and does not interrupt playback',()=>{
  const timeline={value:2,max:2};const c={playing:false,frames:[{time:0},{time:600},{time:1200}],Math,$:()=>timeline};
  vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/radar.js','utf8').split('// Radar fading belongs')[0],c);
  c.next=[{time:600},{time:1200},{time:1800}];vm.runInContext('replaceWeatherFrames(next,{preserveSelection:true,automatic:true})',c);
  assert.equal(c.frames[timeline.value].time,1800);
  timeline.value=0;c.next=[{time:600},{time:1200},{time:1800},{time:2400}];vm.runInContext('replaceWeatherFrames(next,{preserveSelection:true,automatic:true})',c);
  assert.equal(c.frames[timeline.value].time,600);
  c.playing=true;c.next=[{time:3000}];vm.runInContext('replaceWeatherFrames(next,{preserveSelection:true,automatic:true})',c);
  assert.equal(c.frames.length,4);assert.equal(c.frames[timeline.value].time,600);
});
