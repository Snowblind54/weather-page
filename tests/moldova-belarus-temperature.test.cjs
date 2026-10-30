const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Moldovan and Belarusian zero measurements load through shared snapshot and country filter',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['MD',47,28.85],['BY',53.86,27.53]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{MD:{ok:true,count:1},BY:{ok:true,count:1}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,2);assert(c.officialStationsNearTime(now).every(s=>s.temp===0));
 for(const country of ['MD','BY']){c.NorthernCountryFocus={key:()=>country,allowsStation:s=>s.country===country};const points=c.officialStationsNearTime(now);assert.equal(points.length,1);assert.equal(points[0].country,country);assert.equal(c.officialTempValid(59,24,5,country),false);}
});
test('Both country rasters render fresh measurements and keep unsupported gaps transparent',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 for(const [id,country,lat,lon] of [['moldova','MD',47,28.85],['belarus','BY',53.86,27.53]]){
  const spec=c.NorthernUSTemperature.regions.find(r=>r.id===id);assert(spec);const r=await c.NorthernUSTemperature.raster(spec,[{country,lat,lon,temp:0,time:now}],now);assert(r.alpha.some(a=>a>0));assert(r.alpha.some(a=>a===0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));
 }
});
test('Belarus three-hourly reports remain available but old observations expire',()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise,officialStationsNearTime:()=>[3,5].map(h=>({country:'BY',lat:53.86,lon:27.53,temp:h,time:now-h*3600}))};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const points=c.NorthernUSTemperature.stations(now);assert.equal(points.length,1);assert.equal(points[0].temp,3);
});
test('Moldova and Belarus country masks are registered',()=>{
 const src=fs.readFileSync('js/temperature.js','utf8'),c={Set};vm.createContext(c);vm.runInContext(src.match(/const TEMP_REGION_COUNTRY_IDS=\{[\s\S]*?\n\};/)[0]+';this.ids=TEMP_REGION_COUNTRY_IDS;',c);assert(c.ids.moldova.has('498'));assert(c.ids.belarus.has('112'));
});
