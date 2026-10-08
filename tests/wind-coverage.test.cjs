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
 assert.equal(h.run('windTimeSlice(201)'),null);
 assert.equal(h.run('windAt(57,25,windTimeSlice(150))[0]'),7);
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
