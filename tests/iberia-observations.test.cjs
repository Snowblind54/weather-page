const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Spanish and Portuguese mainland/island temperatures validate and respect country selection',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['ES',40.4,-3.7],['ES',28.3,-16.5],['ES',39.5,2.7],['PT',38.7,-9.1],['PT',32.7,-16.9],['PT',39.4,-31.1]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:country==='ES'?'AEMET':'IPMA',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{ES:{ok:true,count:3},PT:{ok:true,count:3}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,6);assert.equal(c.officialTemperatureMaxAge({country:'PT',code:'1'}),7200);
 c.NorthernCountryFocus={key:()=> 'ES',allowsStation:s=>s.country==='ES'};assert.equal(c.officialStationsNearTime(now).length,3);
 assert(c.officialStationsNearTime(now).every(s=>s.country==='ES'));assert.equal(c.officialTempValid(59,24,5,'ES'),false);
});

test('Iberian station heatmaps cover the mainland, Canaries, Azores and Madeira with missing gaps preserved',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const api=c.NorthernUSTemperature;
 for(const [id,country,lat,lon] of [['iberia','ES',40.4,-3.7],['iberia','PT',38.7,-9.1],['spain-canaries','ES',28.3,-16.5],['portugal-azores','PT',39.4,-31.1],['portugal-madeira','PT',32.7,-16.9]]){
  const spec=api.regions.find(r=>r.id===id);assert(spec);const raster=await api.raster(spec,[{country,lat,lon,temp:0,time:now}],now);
  assert(raster.alpha.some(a=>a>0));assert([...raster.values].filter(Number.isFinite).every(v=>v===0));
 }
});
