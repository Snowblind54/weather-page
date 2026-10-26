const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Austrian and Swiss temperatures validate and respect country selection',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['AT',48.2,16.3],['AT',46.6,14.3],['AT',47.2,9.6],['CH',46.2,6.1],['CH',45.9,8.9],['CH',47.6,8.6]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:country==='AT'?'GeoSphere Austria':'MeteoSwiss',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{AT:{ok:true,count:3},CH:{ok:true,count:3}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,6);
 c.NorthernCountryFocus={key:()=> 'AT',allowsStation:s=>s.country==='AT'};assert.equal(c.officialStationsNearTime(now).length,3);
 assert(c.officialStationsNearTime(now).every(s=>s.country==='AT'));assert.equal(c.officialTempValid(59,24,5,'AT'),false);
});

test('Alpine station heatmaps cover both countries with missing gaps preserved',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const api=c.NorthernUSTemperature;
 for(const [id,country,lat,lon] of [['austria','AT',48.2,16.3],['switzerland','CH',46.9,7.4]]){
  const spec=api.regions.find(r=>r.id===id);assert(spec);const raster=await api.raster(spec,[{country,lat,lon,temp:0,time:now}],now);
  assert(raster.alpha.some(a=>a>0));assert([...raster.values].filter(Number.isFinite).every(v=>v===0));
 }
});
