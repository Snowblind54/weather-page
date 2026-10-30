const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Ukraine and Romania measured temperatures preserve zero, islands and country filtering',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['UA',50.4,30.5],['UA',49.8,24],['UA',46.5,30.7],['RO',44.1,28],['RO',47,26]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official test observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{UA:{ok:true,count:3},RO:{ok:true,count:2}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,5);assert(c.officialStationsNearTime(now).every(s=>s.temp===0));
 c.NorthernCountryFocus={key:()=> 'UA',allowsStation:s=>s.country==='UA'};assert.equal(c.officialStationsNearTime(now).length,3);
 assert.equal(c.officialTempValid(59,24,5,'UA'),false);assert.equal(c.officialTempValid(41,12,5,'RO'),false);
});

test('Ukraine and Romania heatmaps use their own station measurements with missing gaps clear',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const api=c.NorthernUSTemperature;
 for(const [id,country,lat,lon] of [['ukraine','UA',50.4,30.5],['romania','RO',44.1,28]]){
  const spec=api.regions.find(r=>r.id===id);assert(spec);const r=await api.raster(spec,[{country,lat,lon,temp:0,time:now}],now);
  assert(r.alpha.some(a=>a>0));assert(r.alpha.some(a=>a===0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));
  const empty=await api.raster(spec,[{country:'FR',lat,lon,temp:20,time:now}],now);assert(empty.alpha.some(a=>a>0));
 }
});

test('Ukrainian three-hour observations remain usable without admitting stale readings',()=>{
 const unix=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise,officialStationsNearTime:()=>[{country:'UA',lat:50.4,lon:30.5,temp:0,time:unix-3*3600},{country:'UA',lat:50.4,lon:30.5,temp:99,time:unix-5*3600}]};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const points=c.NorthernUSTemperature.stations(unix);assert.equal(points.length,1);assert.equal(points[0].temp,0);
});
test('Both country masks are registered for selected-country heatmaps',()=>{
 const src=fs.readFileSync('js/temperature.js','utf8'),c={Set};vm.createContext(c);vm.runInContext(src.match(/const TEMP_REGION_COUNTRY_IDS=\{[\s\S]*?\n\};/)[0]+';this.ids=TEMP_REGION_COUNTRY_IDS;',c);
 assert(c.ids.ukraine.has('804'));assert(c.ids.romania.has('642'));
});
