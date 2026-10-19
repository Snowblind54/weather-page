const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Germany including Bavaria, Netherlands and Belgium load from one shared snapshot',async()=>{
 const now=Math.floor(Date.now()/1000),calls=[];
 const stations=[['DE',47.5,10],['NL',52,5],['BE',50,4]].map(([country,lat,lon])=>
  ({country,lat,lon,code:'1',name:country,source:'Official national service',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},
  loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},
  localStorage:{getItem:()=>null,setItem(){}},fetch:async url=>{calls.push(url);return {ok:true,json:async()=>({version:1,generatedAt:now,
   stations,sources:Object.fromEntries(['DE','NL','BE'].map(code=>[code,{ok:true,count:1}]))})};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);
 const records=await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(records.length,3);assert(records.every(s=>s.temp===0));
 assert.equal(calls.length,1);assert.match(calls[0],/^data\/official-temperature.json/);
 assert.deepEqual(Array.from(vm.runInContext('officialStationSourceSummary().good',c)),['DE','NL','BE']);
 assert.equal(vm.runInContext('officialTempValid(48,-120,5,"DE")',c),false);
 assert.equal(vm.runInContext('officialTempValid(47.5,10,5,"EE")',c),false);
});

test('Western European station shading uses national measurements and bounded coverage',async()=>{
 const c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);
 vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 const api=c.NorthernUSTemperature,spec=api.regions.find(r=>r.id==='western-europe'),now=1800000000;
 assert(spec);assert(spec.w*spec.h<=125000);
 for(const [country,lat,lon] of [['DE',48,10],['NL',52,5],['BE',50.8,4.3]]){
  const s={country,lat,lon,temp:0,time:now};
  const raster=await api.raster(spec,[s,{...s,country:'PL',temp:40}],now);
  assert(raster.alpha.some(a=>a>0));
  assert([...raster.values].filter(Number.isFinite).every(v=>v===0));
 }
});

test('Current extremes includes all three countries and respects its area filter',()=>{
 const {summarize,names}=require('../js/weather-extremes-data.js'),now=1800000000;
 assert.equal(names.DE,'Germany');assert.equal(names.NL,'Netherlands');assert.equal(names.BE,'Belgium');
 const stations=['DE','NL','BE'].map((country,i)=>({country,code:country,name:country,lat:51,lon:5+i,rows:[[now-60,i]]}));
 const metric=summarize({temperature:{stations}},{now}).find(m=>m.id==='cold');
 assert.equal(metric.count,3);assert.equal(metric.winner.country,'DE');
 assert.equal(summarize({temperature:{stations}},{now,country:'BE'}).find(m=>m.id==='cold').winner.country,'BE');
});
