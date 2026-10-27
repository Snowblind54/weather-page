const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('Italy and Hungary measured temperatures preserve zero, islands and country filtering',async()=>{
 const now=Math.floor(Date.now()/1000),stations=[['IT',35.5,12.6],['IT',39,8.5],['IT',46.7,12],['HU',47.5,19],['HU',48.5,21.5]].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country,source:'Official test observation',rows:[[now-600,0]]}));
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,AbortController,setTimeout,clearTimeout,window:{},frames:[{time:now}],loadTemperatures:async()=>{},buildTemperatureOverlay:async()=>{},localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({version:1,stations,sources:{IT:{ok:true,count:3},HU:{ok:true,count:2}}})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/stations.js','utf8'),c);await vm.runInContext('loadOfficialTemperatureStations(true)',c);
 assert.equal(c.officialStationsNearTime(now).length,5);assert(c.officialStationsNearTime(now).every(s=>s.temp===0));
 c.NorthernCountryFocus={key:()=> 'IT',allowsStation:s=>s.country==='IT'};assert.equal(c.officialStationsNearTime(now).length,3);
 assert.equal(c.officialTempValid(59,24,5,'IT'),false);assert.equal(c.officialTempValid(41,12,5,'HU'),false);
});

test('Italy and Hungary heatmaps use their own station measurements with missing gaps clear',async()=>{
 const now=1800000000,c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(fs.readFileSync('js/temperature-us.js','utf8'),c);const api=c.NorthernUSTemperature;
 for(const [id,country,lat,lon] of [['italy','IT',41.8,12.2],['hungary','HU',47.5,19]]){
  const spec=api.regions.find(r=>r.id===id);assert(spec);const r=await api.raster(spec,[{country,lat,lon,temp:0,time:now}],now);
  assert(r.alpha.some(a=>a>0));assert(r.alpha.some(a=>a===0));assert([...r.values].filter(Number.isFinite).every(v=>v===0));
  const empty=await api.raster(spec,[{country:'FR',lat,lon,temp:20,time:now}],now);assert(empty.alpha.some(a=>a>0));
 }
});

test('Official wind validator accepts Italian and Hungarian speeds and rejects foreign coordinates',()=>{
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,setTimeout,clearTimeout,$:()=>null,document:{title:''},L:{layerGroup:()=>({})},map:{createPane(){},getPane:()=>({style:{}})},window:{},globalThis:null};c.globalThis=c;
 vm.createContext(c);let code=fs.readFileSync('js/official-wind.js','utf8');code=code.slice(0,code.indexOf('function officialWindReading'));
 vm.runInContext(code,c);const now=Math.floor(Date.now()/1000),p={version:1,units:"m/s",refreshMinutes:10,generatedAt:now,stations:[{country:'IT',code:'SYNOP-16080',name:'Milano',lat:45.4,lon:9.2,rows:[[now,0,null,0]]},{country:'HU',code:'44527',name:'Budapest',lat:47.4,lon:19.2,rows:[[now,1,3,180]]}],sources:{IT:{status:'ok',timeKind:'observation'},HU:{status:'ok',timeKind:'observation'}}};
 assert.doesNotThrow(()=>c.validateOfficialWind(p));p.stations[0].lat=59;assert.throws(()=>c.validateOfficialWind(p));
});
