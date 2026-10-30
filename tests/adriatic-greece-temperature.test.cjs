const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Montenegrin Greek and expanded Albanian zero measurements load through shared snapshot and country filter',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['ME',42.43,19.28],['GR',37.9,23.73],['AL',42.1,19.53]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{ME:{ok:true,count:1},GR:{ok:true,count:1},AL:{ok:true,count:1}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,3);assert(c.officialStationsNearTime(now).every(s=>s.temp===0));
 for(const country of ['ME','GR','AL']){c.NorthernCountryFocus={key:()=>country,allowsStation:s=>s.country===country};const points=c.officialStationsNearTime(now);assert.equal(points.length,1);assert.equal(points[0].country,country);assert.equal(c.officialTempValid(59,24,5,country),false);}
});
test('New and expanded country rasters render fresh measurements and keep unsupported gaps transparent',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 for(const [id,country,lat,lon] of [['montenegro','ME',42.43,19.28],['greece','GR',37.9,23.73],['albania','AL',42.1,19.53]]){
  const spec=c.NorthernUSTemperature.regions.find(r=>r.id===id);assert(spec);const r=await c.NorthernUSTemperature.raster(spec,[{country,lat,lon,temp:0,time:now}],now);assert(r.alpha.some(a=>a>0));if(country==='GR')assert(r.alpha.some(a=>a===0));const empty=await c.NorthernUSTemperature.raster(spec,[],now);assert(empty.alpha.every(a=>a===0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));
 }
});
test('Six-hourly land reports remain available while airport observations use their shorter window',()=>{
 const now=1800000000,rows=[{country:'ME',code:'SYNOP-13463',lat:42.43,lon:19.28,temp:1,time:now-6*3600},{country:'GR',code:'SYNOP-16716',lat:37.9,lon:23.73,temp:2,time:now-6*3600},{country:'GR',code:'AIRPORT-LGAV',lat:37.94,lon:23.94,temp:3,time:now-6*3600},{country:'ME',code:'SYNOP-13459',lat:42.76,lon:18.95,temp:4,time:now-8*3600}];
 const c={Date,Math,Number,Float32Array,Uint8Array,Promise,officialStationsNearTime:()=>rows};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const points=c.NorthernUSTemperature.stations(now);assert.equal(points.length,2);assert.deepEqual(Array.from(points,p=>p.temp),[1,2]);
});
test('Montenegrin and Greek country masks are registered',()=>{
 const src=fs.readFileSync('js/temperature.js','utf8'),c={Set};vm.createContext(c);vm.runInContext(src.match(/const TEMP_REGION_COUNTRY_IDS=\{[\s\S]*?\n\};/)[0]+';this.ids=TEMP_REGION_COUNTRY_IDS;',c);assert(c.ids.montenegro.has('499'));assert(c.ids.greece.has('300'));
});

test('Manual refresh obtains newly published observations even when the ordinary CDN key is cached',async()=>{
 const now=1800000000,cdn=new Map();let published=16;class Clock extends Date{static now(){return now*1000;}}
 const c={console,Date:Clock,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async url=>{if(!cdn.has(url))cdn.set(url,{version:1,stations:[{country:'AL',lat:42.1,lon:19.53,code:'SYNOP-13600',name:'Shkoder',source:'Official SYNOP',rows:[[now,published]]}],sources:{AL:{ok:true,count:1}}});return {ok:true,json:async()=>cdn.get(url)};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(false)',c);assert.equal(c.officialStationsNearTime(now)[0].temp,16);published=19.2;await vm.runInContext('loadOfficialTemperatureStations(true)',c);assert.equal(c.officialStationsNearTime(now)[0].temp,19.2);
});
