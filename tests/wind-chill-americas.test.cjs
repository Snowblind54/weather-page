const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const context={console,Date,Map,Set,Math,Number,JSON,map:{on(){}},localStorage:{getItem(){return null;}}};
 vm.createContext(context);const run=s=>vm.runInContext(s,context);
 run(fs.readFileSync('js/temperature.js','utf8'));
 const source=fs.readFileSync('js/wind-chill.js','utf8');
 run(source.slice(source.indexOf('  const americasWindSlices='),source.indexOf('  function modelWindChillAt')));
 run('var windData=null;');
 const time=Math.floor(Date.now()/3600000)*3600;context.time=time;
 run("for(const spec of TEMP_GRID_SPECS.filter(s=>s.shared))temperatureGridData.set(spec.id,spec.points.map(([lat,lon])=>({lat,lon,times:[time-3600,time+3600],temps:[-5,-5],wind:[[3,4,20],[6,8,30]]})))");
 return {run,context,time};
}
test('Canada and Greenland interpolate shared sustained vectors, never use gusts for wind chill',()=>{
 const h=setup();assert.equal(h.run('modelWindSpeedAt(49,-123,time)'),7.5);
 assert.equal(h.run('modelWindSpeedAt(64,-51,time)'),7.5);
 assert(h.run('Number.isNaN(modelWindSpeedAt(64,-51,time+7200))'));
});
test('shared wind slices are reused until time or snapshot changes',()=>{
 const h=setup();h.run('modelWindSpeedAt(49,-123,time)');const first=h.run("americasWindSlices.get('canada')");
 h.run('modelWindSpeedAt(50,-120,time)');assert.equal(h.run("americasWindSlices.get('canada')"),first);
 h.run("temperatureGridData.set('canada',temperatureGridData.get('canada').map(p=>({...p,wind:[[0,0,null],[0,0,null]]})))");
 assert.equal(h.run('modelWindSpeedAt(49,-123,time)'),0);
});
test('missing shared winds remain unavailable instead of borrowing a distant model',()=>{
 const h=setup();h.run("temperatureGridData.get('greenland').forEach(p=>p.wind=[[null,null,null],[null,null,null]])");
 assert(h.run('Number.isNaN(modelWindSpeedAt(64,-51,time))'));
});
