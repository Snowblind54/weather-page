const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Southeastern Balkan zero measurements load through shared snapshot and country filter',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['BG',42.18,23.58],['MK',41.72,22.85],['AL',42.034,20.416],['XK',42.576,21.03]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{BG:{ok:true,count:1},MK:{ok:true,count:1},AL:{ok:true,count:1},XK:{ok:true,count:1}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,4);assert(c.officialStationsNearTime(now).every(s=>s.temp===0));
 for(const country of ['BG','MK','AL','XK']){c.NorthernCountryFocus={key:()=>country,allowsStation:s=>s.country===country};const points=c.officialStationsNearTime(now);assert.equal(points.length,1);assert.equal(points[0].country,country);assert.equal(c.officialTempValid(59,24,5,country),false);}
});
test('All four country rasters render fresh measurements and keep unsupported gaps transparent',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 for(const [id,country,lat,lon] of [['bulgaria','BG',42.18,23.58],['north-macedonia','MK',41.72,22.85],['albania','AL',42.034,20.416],['kosovo','XK',42.576,21.03]]){
  const spec=c.NorthernUSTemperature.regions.find(r=>r.id===id);assert(spec);const r=await c.NorthernUSTemperature.raster(spec,[{country,lat,lon,temp:0,time:now}],now);assert(r.alpha.some(a=>a>0));if(country==='BG'||country==='AL')assert(r.alpha.some(a=>a===0));const empty=await c.NorthernUSTemperature.raster(spec,[],now);assert(empty.alpha.every(a=>a===0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));
 }
});
test('Albanian three-hourly SYNOP reports remain current while old readings expire',()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise,officialStationsNearTime:()=>[3,5].map(h=>({country:'AL',lat:42.034,lon:20.416,temp:h,time:now-h*3600}))};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const points=c.NorthernUSTemperature.stations(now);assert.equal(points.length,1);assert.equal(points[0].temp,3);
});
test('All four southeastern country masks are registered',()=>{
 const src=fs.readFileSync('js/temperature.js','utf8'),c={Set};vm.createContext(c);vm.runInContext(src.match(/const TEMP_REGION_COUNTRY_IDS=\{[\s\S]*?\n\};/)[0]+';this.ids=TEMP_REGION_COUNTRY_IDS;',c);assert(c.ids.bulgaria.has('100'));assert(c.ids['north-macedonia'].has('807'));assert(c.ids.albania.has('008'));assert(c.ids.kosovo.has('000'));
});

test('Kosovo missing Natural Earth ID is normalized to its country-search key without changing other territories',async()=>{
 const source=fs.readFileSync('js/temperature.js','utf8'),start=source.indexOf('async function loadTemperatureCountryFeatures()'),end=source.indexOf('function addMaskRing(',start),geo=[{properties:{name:'Kosovo'}},{id:'807',properties:{name:'Macedonia'}},{properties:{name:'N. Cyprus'}}],topojson={feature:()=>({features:geo})};
 const c={window:{topojson},topojson,fetch:async()=>({ok:true,json:async()=>({objects:{countries:{}}})})};vm.createContext(c);vm.runInContext("let temperatureCountryFeaturesPromise=null;const TEMP_COUNTRIES_URL='countries';"+source.slice(start,end),c);const result=await c.loadTemperatureCountryFeatures();assert.equal(result[0].id,'000');assert.equal(result[1].id,'807');assert.equal(result[2].id,undefined);assert.equal(geo[0].id,undefined);
 const catalogue=JSON.parse(fs.readFileSync('assets/country-search.json','utf8')).countries;assert.equal(catalogue.find(x=>x.iso2==='XK').id,result[0].id);
});
