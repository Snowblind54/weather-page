const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const locations=[['MT',35.858,14.477],['CY',34.915,33.016],['TR',39.9,32.8]];

test('Malta Cyprus and Turkish measured zero temperatures load and respect the country filter',async()=>{
 const now=Math.floor(Date.now()/1000),stations=locations.map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:Object.fromEntries(locations.map(([country])=>[country,{ok:true,count:1}]))})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);assert.equal(c.officialStationsNearTime(now).length,3);
 for(const [country] of locations){c.NorthernCountryFocus={key:()=>country,allowsStation:s=>s.country===country};const points=c.officialStationsNearTime(now);assert.equal(points.length,1);assert.equal(points[0].temp,0);assert.equal(points[0].country,country);assert.equal(c.officialTempValid(59,24,5,country),false);}
});
test('All three station rasters render measured zero and leave missing data transparent',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 for(const [id,country,lat,lon] of [['malta',...locations[0]],['cyprus',...locations[1]],['turkey',...locations[2]]]){
  const spec=c.NorthernUSTemperature.regions.find(r=>r.id===id);assert(spec);const r=await c.NorthernUSTemperature.raster(spec,[{country,lat,lon,temp:0,time:now}],now);assert(r.alpha.some(a=>a>0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));if(country==='TR')assert(r.alpha.some(a=>a===0));const empty=await c.NorthernUSTemperature.raster(spec,[],now);assert(empty.alpha.every(a=>a===0));
 }
});
test('Mediterranean observations use the short freshness window',()=>{
 const now=1800000000,rows=locations.flatMap(([country,lat,lon])=>[1,3].map(h=>({country,lat,lon,temp:h,time:now-h*3600}))),c={Date,Math,Number,Float32Array,Uint8Array,Promise,officialStationsNearTime:()=>rows};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const points=c.NorthernUSTemperature.stations(now);assert.equal(points.length,3);assert(points.every(s=>s.temp===1));
});
test('Each new country has its own coastline mask and searchable country identifier',()=>{
 const source=fs.readFileSync('js/temperature.js','utf8'),c={Set};vm.createContext(c);vm.runInContext(source.match(/const TEMP_REGION_COUNTRY_IDS=\{[\s\S]*?\n\};/)[0]+';this.ids=TEMP_REGION_COUNTRY_IDS;',c);const catalogue=JSON.parse(fs.readFileSync('assets/country-search.json','utf8')).countries;
 for(const [region,iso,id] of [['malta','MT','470'],['cyprus','CY','196'],['turkey','TR','792']]){assert(c.ids[region].has(id));assert.equal(catalogue.find(x=>x.iso2===iso).id,id);}
});
