const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('France, Corsica and Andorra display official readings with country scope and native report age',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['FR',48.73,2.4,now-3*3600],['FR',41.92,8.8,now-3*3600],['AD',42.5,1.53,now-1800]].map(([country,lat,lon,time],i)=>({country,lat,lon,code:String(i),name:country,source:'Official service',rows:[[time,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,generatedAt:now,stations,sources:{FR:{ok:true,count:2},AD:{ok:true,count:1}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);
 await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,3);
 assert.equal(vm.runInContext('officialTempValid(48.8,2.3,10,"AD")',c),false);
 assert.equal(vm.runInContext('officialTempValid(41.92,8.8,0,"FR")',c),true);
 c.NorthernCountryFocus={key:()=> 'AD',allowsStation:s=>s.country==='AD'};
 assert.equal(c.officialStationsNearTime(now).length,1);assert.equal(c.officialStationsNearTime(now)[0].country,'AD');
 c.frames=[{time:now+5*3600}];assert.equal(c.officialStationsNearTime(now+5*3600).length,0);
});

test('Andorran wind labels at other sensor heights do not bias the 10 m field',()=>{
 const source=fs.readFileSync('js/wind.js','utf8');const start=source.indexOf('function windHeatmapCorrections('),end=source.indexOf('function windHeatmapCorrectionIndex(',start);
 const c={Date,Number,Math,officialWindData:{stations:[{lat:42.5,lon:1.5,heatmapEligible:false},{lat:42.6,lon:1.6,heatmapEligible:true}]},officialWindReading:()=>[1000,5,null,0],windAt:()=>[1,0],windGustAt:()=>null,WindObservationBlend:{makeCorrection:(lat,lon,observed,model)=>({lat,lon,observed,model})}};
 vm.createContext(c);vm.runInContext(source.slice(start,end),c);const corrections=c.windHeatmapCorrections(1000,{},'sustained');
 assert.equal(corrections.length,1);assert.equal(corrections[0].lat,42.6);assert.equal(c.windHeatmapCorrections(1000,{},'gust').length,0);
});

test('French and Andorran official temperatures produce country-clipped station heatmaps',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);
 const api=c.NorthernUSTemperature;
 for(const [id,country,lat,lon,age] of [['france','FR',43.6,1.4,3*3600],['andorra','AD',42.53,1.55,1800]]){
  const spec=api.regions.find(r=>r.id===id);assert(spec);const raster=await api.raster(spec,[{country,lat,lon,temp:0,time:now-age}],now);
  assert(raster.alpha.some(a=>a>0));assert([...raster.values].filter(Number.isFinite).every(v=>v===0));
 }
});


test('six-minute national French stations expire separately from three-hourly SYNOP backup',()=>{
 const c={Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},localStorage:{getItem:()=>null,setItem(){}},loadTemperatures(){},buildTemperatureOverlay(){}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);
 assert.equal(c.officialTemperatureMaxAge({country:'FR',code:'MF-01014002'}),95*60);
 assert.equal(c.officialTemperatureMaxAge({country:'FR',code:'SYNOP-07149'}),4*3600);
});
