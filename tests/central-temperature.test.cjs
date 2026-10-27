const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('Czechia, Slovakia and Luxembourg use one shared official snapshot and strict country bounds',async()=>{
 const now=Math.floor(Date.now()/1000),calls=[];
 const stations=[['CZ',50,15],['SK',47.8,18],['LU',49.63,6.23]].map(([country,lat,lon])=>({country,lat,lon,code:'1',name:country,source:'National service',rows:[[now-60,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},
  loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},
  fetch:async url=>{calls.push(url);return {ok:true,json:async()=>({version:1,stations,sources:Object.fromEntries(stations.map(s=>[s.country,{ok:true,count:1}]))})};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);
 const rows=await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(rows.length,3);assert(rows.every(r=>r.temp===0));assert.equal(calls.length,1);
 assert.equal(vm.runInContext('officialTempValid(47.8,18,0,"SK")',c),true);
 assert.equal(vm.runInContext('officialTempValid(47.8,18,0,"CZ")',c),false);
 assert.equal(vm.runInContext('officialTempValid(50,15,0,"LU")',c),false);
});
test('all three countries support measured station shading and current extremes',async()=>{
 const c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 const api=c.NorthernUSTemperature,now=Math.floor(Date.now()/1000);
 for(const [country,lat,lon,id] of [['CZ',50,15,'central-europe'],['SK',48.7,19.5,'central-europe'],['LU',49.63,6.23,'western-europe']]){
  const region=api.regions.find(r=>r.id===id);assert(region.countries.includes(country));assert(region.w*region.h<125000);
  const result=await api.raster(region,[{country,lat,lon,temp:0,time:now},{country:'PL',lat,lon,temp:40,time:now}],now);
  assert(result.alpha.some(a=>a>0));assert([...result.values].filter(Number.isFinite).every(v=>Math.abs(v-20)<1e-4));
 }
 const {names,summarize}=require('../js/weather-extremes-data.js');
 assert.equal(names.CZ,'Czechia');assert.equal(names.SK,'Slovakia');assert.equal(names.LU,'Luxembourg');
 const stations=['CZ','SK','LU'].map((country,i)=>({country,name:country,code:country,lat:49,lon:15,rows:[[now-60,i]]}));
 assert.equal(summarize({temperature:{stations}},{now}).find(m=>m.id==='cold').count,3);
});
