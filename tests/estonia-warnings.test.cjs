const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../',name),'utf8');
const fixture=read('tests/fixtures/estonia-warnings.xml');

// A DOM fixture for the official, flat XML rows. Production XML parsing is
// supplied by the browser; these nodes exercise warning extraction itself.
function fixtureDocument(){
 function node(name,children=[],value=''){
  const el={tagName:name,localName:name,attributes:[],children,textContent:value||children.map(c=>c.textContent).join('')};
  el.getElementsByTagName=name=>children.flatMap(c=>[...(name==='*'||c.tagName===name?[c]:[]),...c.getElementsByTagName(name)]);
  for(const child of children)child.parentElement=el;return el;
 }
 const entries=[...fixture.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>node('entry',[...m[1].matchAll(/<([A-Za-z_]+)>([^<]*)<\/\1>/g)].map(f=>node(f[1],[],f[2]))));
 const root=node('entries',entries);return {querySelector:()=>null,getElementsByTagName:name=>[...(name==='*'||name==='entries'?[root]:[]),...root.getElementsByTagName(name)]};
}
function harness(){
 let now=Date.parse('2026-10-04T19:19:15Z');
 const Clock=class extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}};
 const elements={warningOn:{checked:true,addEventListener(){}},warningList:{innerHTML:'',children:[],appendChild(card){this.children.push(card)}},warningStatus:{textContent:''}};
 const c={Date:Clock,Intl,Map,Set,Promise,Object,Array,console,DOMParser:class{parseFromString(){return fixtureDocument()}},
 setTimeout:()=>1,clearTimeout(){},$:id=>elements[id],document:{addEventListener(){},createElement(){return {style:{},addEventListener(){}}}},
 warningRecords:[],lithuaniaWarnings:[],renderLithuaniaWarnings:async()=>{},latviaWarningSnapshotUpdatedAt:null,nationalWarningSnapshot:null};
 vm.createContext(c);vm.runInContext(read('js/estonia-warning-data.js')+read('js/warnings.js')+read('js/warning-filters.js'),c);
 c.setNow=value=>{now=Date.parse(value)};c.elements=elements;return c;
}
test('official XML retains all six warnings, including sea names containing Lääne',()=>{
 const c=harness();c.fixture=fixture;const records=vm.runInContext('parseEstoniaWarnings(fixture)',c);
 assert.equal(records.length,6);
 assert.equal(records.find(w=>w.area==='Soome lahe lääneosa').effective,'2026-10-05T09:00:00.000Z');
 assert.equal(records.find(w=>w.area==='Läänemere põhjaosa').expires,'2026-10-06T00:00:00.000Z');
 assert.equal(records.find(w=>w.area==='Peipsi järv').expires,'2026-10-04T21:00:00.000Z');
 c.records=records;assert.equal(vm.runInContext('warningsForTodayAndTomorrow(records).length',c),6);
 assert.equal(records.filter(w=>w.effective.startsWith('2026-10-05')).length,4);
});
test('exact local hours preserve same-day warnings until the actual expiry',()=>{
 const c=harness();c.fields=['2026-10-05','2026-10-05','Tuul 16 m/s. 2026-10-05 12:00 – 2026-10-05 21:00'];
 c.record=vm.runInContext('estoniaWarningValidity(...fields)',c);
 c.setNow('2026-10-05T12:00Z');assert.equal(vm.runInContext('warningIsTodayOrTomorrow(record)',c),true);
 c.setNow('2026-10-05T18:00Z');assert.equal(vm.runInContext('warningIsTodayOrTomorrow(record)',c),false);
});
test('date-only fallback covers the full local expiry day, including DST days',()=>{
 const c=harness();
 for(const [value,expected] of [['2026-10-05','2026-10-05T21:00:00.000Z'],['2026-01-05','2026-01-05T22:00:00.000Z'],['2026-03-29','2026-03-29T21:00:00.000Z'],['2026-10-25','2026-10-25T22:00:00.000Z']]){
  c.value=value;assert.equal(vm.runInContext('estoniaWarningTime(value,{endOfDay:true})',c),expected);
 }
 assert.equal(vm.runInContext("estoniaWarningTime('2026-02-30')",c),'');
 assert.equal(vm.runInContext("estoniaWarningTime('2026-03-29 03:30')",c),'');
});
test('structured timestamps take priority; Tallinn conversion ignores visitor timezone',()=>{
 const c=harness();
 c.fields=['2026-10-05T14:00:00+03:00','2026-10-05T23:00:00+03:00','2026-10-05 12:00 - 2026-10-05 21:00'];
 const result=vm.runInContext('estoniaWarningValidity(...fields)',c);
 assert.equal(result.effective,'2026-10-05T11:00:00.000Z');assert.equal(result.expires,'2026-10-05T20:00:00.000Z');
 assert.equal(vm.runInContext("estoniaWarningTime('2026-01-05 12:00')",c),'2026-01-05T10:00:00.000Z');
});
test('today/tomorrow follows the local day and forecast onset, excludes later and expired warnings',()=>{
 const c=harness();c.setNow('2026-10-04T21:15Z'); // Already 5 October in Estonia.
 c.records=[{effective:'2026-10-05T09:00Z',expires:'2026-10-05T18:00Z'},{effective:'2026-10-06T09:00Z',expires:'2026-10-06T18:00Z'},
 {effective:'2026-10-04T12:00Z',onset:'2026-10-07T09:00Z',expires:'2026-10-07T18:00Z'},{effective:'2026-10-04T12:00Z',expires:'2026-10-04T21:00Z'}];
 assert.equal(vm.runInContext('warningsForTodayAndTomorrow(records).length',c),2);
});
test('marine renderer uses only water GeoJSON, never Lääne County or an unclipped fallback',async()=>{
 const c=harness();const added=[],geo=[];
 c.map={hasLayer:()=>false};c.weatherFront=()=>{};
 c.warningLayerGroup={clearLayers(){},addLayer(layer){added.push(layer)},addTo(){},eachLayer(){}};
 c.L={geoJSON(feature,options){geo.push({feature,options});return {bindPopup(){},getBounds(){}}},polygon(){assert.fail('Unclipped marine polygon was used')}};
 c.county={features:[{properties:{name:'Lääne maakond'},geometry:{type:'Polygon',coordinates:[]}}]};
 c.zones=new Map(JSON.parse(read('data/estonia-marine-warning-zones.geojson')).features.map(f=>[f.properties.area,f]));
 vm.runInContext('loadCountyGeometry=async()=>county;loadEstoniaMarineWarningGeometry=async()=>zones',c);
 c.fixture=fixture;vm.runInContext('warningRecords=parseEstoniaWarnings(fixture)',c);await vm.runInContext('renderWarnings()',c);
 assert.equal(added.length,6);assert(geo.every(item=>item.feature.properties.water));assert(geo.every(item=>item.options.style.fillRule==='evenodd'));
 assert.equal(c.elements.warningList.children.filter(card=>card.innerHTML.includes('starts tomorrow')).length,4);
 added.length=0;geo.length=0;c.console={warn(){}};vm.runInContext("loadEstoniaMarineWarningGeometry=async()=>{throw new Error('offline')}",c);await vm.runInContext('renderWarnings()',c);
 assert.equal(added.length,0);assert.equal(geo.length,0);
});
test('marine geometry download is shared and a failed request can be retried',async()=>{
 const c=harness();let calls=0;c.fetch=async()=>{calls++;return {ok:false,status:404}};
 const a=vm.runInContext('loadEstoniaMarineWarningGeometry()',c),b=vm.runInContext('loadEstoniaMarineWarningGeometry()',c);assert.equal(a,b);await assert.rejects(a,/HTTP 404/);
 c.fetch=async()=>{calls++;return {ok:true,json:async()=>JSON.parse(read('data/estonia-marine-warning-zones.geojson'))}};
 assert.equal((await vm.runInContext('loadEstoniaMarineWarningGeometry()',c)).size,6);await vm.runInContext('loadEstoniaMarineWarningGeometry()',c);assert.equal(calls,2);
});
test('full official forecast paints the five tomorrow counties and keeps marine regions offshore',async()=>{
 const c=harness();const snapshot=JSON.parse(read('data/estonia-warnings.json'));
 snapshot.fetchedAt='2026-10-04T19:19:15Z';c.fetch=async()=>({ok:true,json:async()=>snapshot});
 const records=await vm.runInContext('fetchEstoniaWarningForecast()',c);c.records=records;
 vm.runInContext('warningRecords=warningsForTodayAndTomorrow(records)',c);
 assert.deepEqual(Array.from(c.warningRecords.filter(w=>w.id==='5111'),w=>w.area).sort(),['Harju maakond','Hiiu maakond','Lääne maakond','Pärnu maakond','Saare maakond'].sort());
 assert.equal(c.warningRecords.filter(w=>w.id==='5129').length,0); // Tuesday is outside the window.
 const painted=[];c.map={hasLayer:()=>false};c.weatherFront=()=>{};
 c.warningLayerGroup={clearLayers(){},addLayer(){},addTo(){},eachLayer(){}};
 c.L={geoJSON(feature){painted.push(feature);return {bindPopup(){}}}};
 c.county={features:Object.values({37:'Harju',39:'Hiiu',56:'Lääne',68:'Pärnu',74:'Saare',79:'Tartu'}).map(name=>({properties:{name:name+' maakond'},geometry:{type:'Polygon',coordinates:[]}}))};
 c.zones=new Map(JSON.parse(read('data/estonia-marine-warning-zones.geojson')).features.map(f=>[f.properties.area,f]));
 vm.runInContext('loadCountyGeometry=async()=>county;loadEstoniaMarineWarningGeometry=async()=>zones',c);
 await vm.runInContext('renderWarnings()',c);
 assert.equal(painted.filter(f=>!f.properties.water).length,5);
 assert(!painted.some(f=>f.properties.name==='Tartu maakond'));
 assert.equal(c.elements.warningList.children.filter(card=>card.warningRecord.id==='5111'&&card.innerHTML.includes('starts tomorrow')).length,5);
});
test('forecast snapshot rejects stale and malformed data, accepts a current official all-clear',async()=>{
 const c=harness();let snapshot={schemaVersion:1,fetchedAt:'2026-10-04T19:19:15Z',forecastDays:['2026-10-04'],records:[]};
 c.fetch=async()=>({ok:true,json:async()=>snapshot});assert.equal((await vm.runInContext('fetchEstoniaWarningForecast()',c)).length,0);
 snapshot={...snapshot,fetchedAt:'2026-10-04T12:00Z'};await assert.rejects(vm.runInContext('fetchEstoniaWarningForecast()',c),/out of date/);
 snapshot={...snapshot,fetchedAt:'2026-10-04T19:19:15Z',records:[{area:'Harju',event:'Wind',level:1,effective:'invalid',expires:'invalid'}]};
 await assert.rejects(vm.runInContext('fetchEstoniaWarningForecast()',c),/Invalid Estonia forecast warning/);
});
