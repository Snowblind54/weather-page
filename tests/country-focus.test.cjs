const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const focus=require('../js/country-focus.js');
const read=name=>fs.readFileSync(__dirname+'/../js/'+name,'utf8');
const feature={type:'Feature',geometry:{type:'MultiPolygon',coordinates:[[
 [[10,50],[14,50],[14,54],[10,54],[10,50]],
 [[11,51],[12,51],[12,52],[11,52],[11,51]]
],[[[15,55],[16,55],[16,56],[15,56],[15,55]]]]}};
test('country containment retains islands and excludes neighbours and interior holes',()=>{
 assert.equal(focus.contains(feature,50.5,10.5),true);
 assert.equal(focus.contains(feature,51.5,11.5),false);
 assert.equal(focus.contains(feature,55.5,15.5),true);
 assert.equal(focus.contains(feature,50.5,14.5),false);
 assert.equal(focus.contains(feature,50.5,370.5),true);
 assert.equal(focus.contains(feature,NaN,10),false);
});
test('countries crossing the date line stay local in point selection and map clipping',()=>{
 const f={geometry:{type:'Polygon',coordinates:[[[179,50],[-179,50],[-179,52],[179,52],[179,50]]]}};
 assert.equal(focus.contains(f,51,180),true);assert.equal(focus.contains(f,51,-180),true);assert.equal(focus.contains(f,51,0),false);
 const project=(lat,lon)=>({x:lon,y:lat}),path=focus.path(f,project,180);
 assert.match(path,/M179\.0 50\.0L181\.0/);
 for(const ring of path.split('Z').filter(Boolean)){const xs=[...ring.matchAll(/[ML](-?\d+\.\d+) /g)].map(m=>Number(m[1]));assert.equal(Math.max(...xs)-Math.min(...xs),2);}
 assert.deepEqual(focus.bounds(f),[[50,179],[52,181]]);
});
test('projected clipping retains holes and every disconnected island',()=>{
 const path=focus.path(feature,(lat,lon)=>({x:lon*10,y:lat*10}));
 assert.equal((path.match(/M/g)||[]).length,9);assert.equal((path.match(/Z/g)||[]).length,9);
 assert.match(path,/M110\.0 510\.0/);assert.match(path,/M150\.0 550\.0/);
});
test('switching country at the same playback time cannot reuse foreign station readings',()=>{
 const source=read('stations.js'),selection=source.slice(source.indexOf('function officialStationsNearTime('),source.indexOf('function officialStationSourceSummary('));
 const now=1900000000,c={frames:[{time:now}],OFFICIAL_TEMP_LABEL_MAX_OFFSET:5700,OFFICIAL_TEMP_LABEL_MAX_OFFSET_BY_COUNTRY:{},OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC:600,
  officialTempStationKey:s=>s.country+'|'+s.code,rows:[{country:'NO',code:'1',temp:2,time:now},{country:'SE',code:'2',temp:4,time:now}]};
 vm.createContext(c);vm.runInContext('let officialTemperatureStations=rows,officialTemperatureSelectionSource=null;const officialTemperatureSelectionCache=new Map();'+selection,c);
 let selected='NO';c.NorthernCountryFocus={key:()=>selected,allowsStation:s=>s.country===selected};
 assert.equal(vm.runInContext('officialStationsNearTime('+now+')[0].country',c),'NO');
 selected='SE';assert.equal(vm.runInContext('officialStationsNearTime('+now+')[0].country',c),'SE');
 c.NorthernCountryFocus=null;assert.equal(vm.runInContext('officialStationsNearTime('+now+').length',c),2);assert.equal(c.rows.length,2);
});
test('temperature masks use the selected country within a shared multi-country raster',()=>{
 const source=read('temperature.js'),code=source.slice(source.indexOf('function clipTemperatureToCountries('),source.indexOf('function temperatureCoordKey('));
 // Evaluate just the clipping function; later source declarations are unrelated.
 const end=code.indexOf('\n}',code.indexOf('return matched>0;'))+2;
 const added=[],ctx={save(){},restore(){},beginPath(){},fill(){},globalCompositeOperation:'',fillStyle:''};
 const c={TEMP_REGION_COUNTRY_IDS:{scandinavia:new Set(['578','752','246'])},addMaskGeometry:(_,g)=>added.push(g.id),NorthernCountryFocus:{matchesCountry:id=>id==='578'}};
 vm.createContext(c);vm.runInContext(code.slice(0,end),c);c.ctx=ctx;c.features=['578','752','246'].map(id=>({id,geometry:{id}}));
 assert.equal(vm.runInContext("clipTemperatureToCountries(ctx,{id:'scandinavia'},100,100,features)",c),true);assert.deepEqual(added,['578']);
 added.length=0;c.NorthernCountryFocus=null;vm.runInContext("clipTemperatureToCountries(ctx,{id:'scandinavia'},100,100,features)",c);assert.deepEqual(added,['578','752','246']);
});
test('country catalogue supports existing observation countries and common search aliases',()=>{
 const data=JSON.parse(fs.readFileSync(__dirname+'/../assets/country-search.json','utf8'));
 for(const [iso2,id] of [['EE','233'],['NO','578'],['DE','276'],['CZ','203'],['SK','703'],['GB','826'],['US','840'],['CA','124']])assert.equal(data.countries.find(c=>c.iso2===iso2).id,id);
 assert.equal(focus.normal('Česká republika'),'ceskarepublika');
});

test('country warning lists exclude foreign records without altering the source snapshot',()=>{
 const s=read('warning-filters.js');const code=s.slice(s.indexOf('function warningsForTodayAndTomorrow('),s.indexOf('// Filter Estonia'));
 const c={warningIsTodayOrTomorrow:()=>true,warningCountry:r=>r.country,NorthernCountryFocus:{matchesCountry:n=>n==='Norway'},records:[{country:'Norway'},{country:'Sweden'},{country:'Germany'}]};
 vm.createContext(c);vm.runInContext(code,c);assert.equal(vm.runInContext('warningsForTodayAndTomorrow(records).length',c),1);assert.equal(c.records.length,3);
 c.NorthernCountryFocus=null;assert.equal(vm.runInContext('warningsForTodayAndTomorrow(records).length',c),3);
});

test('country heatmap statistics ignore pixels outside its mask, including extreme foreign values',()=>{
 const values=new Float32Array([-80,0,7,50,NaN]);const rgba=new Uint8ClampedArray(20);rgba[7]=255;rgba[11]=128;rgba[19]=255;
 assert.deepEqual(focus.range(values,rgba),{min:0,max:7});
});
