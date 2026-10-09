const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('js/wind.js','utf8');
function harness(){
 const c={Math,Number,Array,Date};vm.createContext(c);const run=s=>vm.runInContext(s,c);
 run(source.slice(source.indexOf('const WIND_GRIDS='),source.indexOf('let windLoadPromise')));
 run(source.slice(source.indexOf('function validWindData('),source.indexOf('function restoreWind(')));
 run(source.slice(source.indexOf('function windTimeSlice('),source.indexOf('const WindCanvasLayer=')));
 run('windData={version:6,savedAt:Date.now(),times:[100,200],grids:WIND_GRIDS.map((g,i)=>Array.from({length:g.rows*g.cols},()=>[[i+3,4,8],[i+3,4,12]]))}');
 return {run,c};
}
test('shared snapshot geometry matches the collector and retains European detail',()=>{
 const h=harness();assert(h.run('validWindData(windData)'));
 const python=fs.readFileSync('scripts/update_model_wind.py','utf8');
 const grids=JSON.parse(python.slice(python.indexOf('WIND_GRIDS = [')+13,python.indexOf('\n]\n',python.indexOf('WIND_GRIDS = ['))+2).replace(/,\s*]/g,']'));
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(WIND_GRIDS)')),grids);
 assert.equal(h.run('WIND_GRIDS[1].rows*WIND_GRIDS[1].cols'),713);
 assert.equal(h.run('(WIND_GRIDS[1].north-WIND_GRIDS[1].south)/(WIND_GRIDS[1].rows-1)'),2);
 assert.equal(h.run('(WIND_GRIDS[3].north-WIND_GRIDS[3].south)/(WIND_GRIDS[3].rows-1)'),2);
 assert.equal(h.run('WIND_GRIDS[3].rows*WIND_GRIDS[3].cols'),693);assert.equal(h.run('WIND_GRIDS[4].rows*WIND_GRIDS[4].cols'),81);
 h.run('windData.version=5');assert(!h.run('validWindData(windData)'));
});
test('sustained vectors and native hourly gusts cover both countries and Arctic boundaries',()=>{
 const h=harness();
 for(const [lat,lon] of [[83.6,-30],[25,-142]]){
  h.c.lat=lat;h.c.lon=lon;
  const v=h.run('windAt(lat,lon,windTimeSlice(150))');assert(Math.abs(v[0]-3)<1e-10);assert(Math.abs(v[1]-4)<1e-10);
  assert(Math.abs(h.run('windGustAt(lat,lon,windTimeSlice(150))')-12)<1e-10);
 }
 assert.equal(h.run('windAt(60,-145,windTimeSlice(150))'),null);
 assert.equal(h.run('windAt(85,-51,windTimeSlice(150))'),null);
 assert.equal(h.run('windTimeSlice(201).cached'),true);
 assert.equal(h.run('windAt(57,25,windTimeSlice(150))[0]'),7);
});
test('delayed updates retain the last model hour for at most two hours and never invent past history',()=>{
 const h=harness();
 assert.equal(h.run('windTimeSlice(99)'),null);
 assert.equal(h.run('windTimeSlice(7401)'),null);
 assert.equal(h.run('windTimeSlice(7400).time'),200);
 assert.equal(h.run('windTimeSlice(7400).f'),1);
 assert.equal(h.run('windGustAt(57,25,windTimeSlice(201))'),12);
 assert.equal(h.run('windTimeSlice(150).f'),0.5);
});
test('missing gusts remain unavailable without hiding valid sustained wind',()=>{
 const h=harness();h.run('windData.grids.forEach(g=>g.forEach(p=>p[1][2]=null))');
 assert.equal(h.run('windGustAt(64,-51,windTimeSlice(150))'),null);
 assert(h.run('windAt(64,-51,windTimeSlice(150))'));
});

test('North Atlantic and Iceland use denser grids before the broad fallback',()=>{
 const h=harness();
 for(const [lat,lon,expected] of [[64,-51,5],[58,-40,5],[63.525,-22.143,8],[67,-14,8],[70,20,6],[49,-123,4],[62,-135,4],[73,-110,4],[84,-142,4]]){
  h.c.lat=lat;h.c.lon=lon;
  assert(Math.abs(h.run('windAt(lat,lon,windTimeSlice(150))[0]')-expected)<1e-10);
  assert.equal(h.run('windGustAt(lat,lon,windTimeSlice(150))'),12);
 }
 assert.equal(h.run('(WIND_GRIDS[5].north-WIND_GRIDS[5].south)/(WIND_GRIDS[5].rows-1)'),0.5);
 assert.equal(h.run('(WIND_GRIDS[5].east-WIND_GRIDS[5].west)/(WIND_GRIDS[5].cols-1)'),0.5);
});

function withExtraGrids(){
 const h=harness(),python=fs.readFileSync('scripts/update_model_wind.py','utf8');
 const start=python.indexOf('WIND_EXTRA_GRIDS = [')+19;
 const specs=JSON.parse(python.slice(start,python.indexOf('\n]\n',start)+2).replace(/,\s*]/g,']'));
 h.c.specs=specs;
 h.run('windData={...windData,extraGrids:specs.map((g,i)=>({...g,series:Array.from({length:g.rows*g.cols},()=>[[20+i,4,30+i],[20+i,4,40+i]])}))}');
 return h;
}
test('equator, USA, offshore waters, Alaska and Hawaii use matching sustained and gust grids',()=>{
 const h=withExtraGrids();assert(h.run('validWindData(windData)'));
 for(const [lat,lon,expected] of [[0,0,20],[0,-180,20],[0,180,20],[10,175,20],[10,535,20],
   [30,-100,21],[25,-80,21],[40,-70,21],[51,-170,22],[70,-150,22],[21,-157,23]]){
  h.c.lat=lat;h.c.lon=lon;
  assert.equal(h.run('windAt(lat,lon,windTimeSlice(150))[0]'),expected);
  assert.equal(h.run('windGustAt(lat,lon,windTimeSlice(150))'),expected+20);
 }
 assert.equal(h.run('windAt(-0.01,-100,windTimeSlice(150))'),null);
 assert.equal(h.run('windAt(85,20,windTimeSlice(150))'),null);
 assert.equal(h.run('windAt(57,25,windTimeSlice(150))[0]'),7);
 assert.equal(h.run('windAt(63.525,-22.143,windTimeSlice(150))[0]'),8);
 assert.equal(h.run('windSamplingGrids()===windSamplingGrids()'),true);
});
test('missing USA cells fall back to existing coverage and invalid dimensions are rejected',()=>{
 const h=withExtraGrids();
 h.run('windData.extraGrids.find(g=>g.id==="usa").series.forEach(s=>s[0]=null)');
 assert(Math.abs(h.run('windAt(30,-100,windTimeSlice(150))[0]')-20)<1e-10);
 h.run('windData.extraGrids[0].series.pop()');
 assert.equal(h.run('validWindData(windData)'),false);
 h.run('windData.extraGrids=[null]');
 assert.equal(h.run('validWindData(windData)'),false);
 h.run('windData.times="invalid"');
 assert.equal(h.run('validWindData(windData)'),false);
});

test('NOAA instantaneous gusts use the nearest hour; regional hourly peaks retain their interval',()=>{
 const h=withExtraGrids();
 assert.equal(h.run('windGustAt(30,-100,windTimeSlice(125))'),31);
 assert.equal(h.run('windGustAt(30,-100,windTimeSlice(125),true).hour'),0);
 assert.equal(h.run('windGustAt(57,25,windTimeSlice(125))'),12);
 h.run('windData={...windData,legacyGustTiming:"instant"}');
 assert.equal(h.run('windGustAt(57,25,windTimeSlice(125))'),8);
});
