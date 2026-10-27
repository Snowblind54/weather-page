const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../js/temperature-us.js','utf8');
function harness(){const c={Date,Math,Number,Float32Array,Uint8Array,Promise};vm.createContext(c);vm.runInContext(source,c);return c;}
const now=1791806400;
const station=(lat,lon,temp,time=now)=>({country:'US',lat,lon,temp,time});
const region={id:'usa',bounds:[[39,-101],[41,-99]],w:101,h:101,stationBased:true};
test('station shading preserves measured zero, blends nearby values and leaves gaps transparent',async()=>{
 const {NorthernUSTemperature:us}=harness();
 const zero=await us.raster(region,[station(40,-100,0)],now);
 assert.equal(zero.values[50*101+50],0);assert.equal(zero.alpha[50*101+50],205);
 assert(Number.isNaN(zero.values[0]));assert.equal(zero.alpha[0],0);
 const blend=await us.raster(region,[station(40,-100.2,10),station(40,-99.8,20)],now);
 assert(Math.abs(blend.values[50*101+50]-15)<.1);
 assert(blend.values[50*101+40]<11);assert(blend.values[50*101+60]>19);
});
test('stale, missing and canceled data never produce false heatmap values',async()=>{
 const {NorthernUSTemperature:us}=harness();
 const r=await us.raster(region,[station(40,-100,5,now-6000),station(40,-100,NaN),{...station(40,-100,30,now-6000),country:'CA'}],now);
 assert(r.values.every(Number.isNaN));assert(r.alpha.every(a=>a===0));
 let valid=true,yields=0;
 const canceled=await us.raster(region,Array.from({length:32},()=>station(40,-100,5)),now,()=>valid,async()=>{valid=false;yields++});
 assert.equal(canceled,null);assert.equal(yields,1);
});
test('Alaska, Hawaii and both sides of the Aleutian date line have bounded raster coverage',async()=>{
 const {NorthernUSTemperature:us}=harness();
 for(const [id,lat,lon] of [['usa-alaska',61,-150],['usa-hawaii',21.3,-157.9],['usa-aleutians',52.7,174.1]]){
  const spec=us.regions.find(r=>r.id===id);assert(spec.w*spec.h<=125000);
  const r=await us.raster(spec,[station(lat,lon,7)],now);assert(r.alpha.some(a=>a>0));
 }
});
test('Atlantic shading uses nearby official stations and excludes geographically remote US stations',async()=>{
 const {NorthernUSTemperature:us}=harness();
 for(const [id,country,lat,lon] of [['british-isles','GB',52,-2],['british-isles','IE',53,-8],['faroes','FO',62,-6.8]]){
  const spec=us.regions.find(r=>r.id===id);
  const measured={country,lat,lon,temp:9,time:now};
  const r=await us.raster(spec,[measured,station(40,-100,40)],now);
  assert(r.alpha.some(a=>a>0));
  for(const value of r.values)if(Number.isFinite(value))assert(Math.abs(value-9)<.001);
 }
});
test('the existing renderer can draw NOAA US heatmaps with all model sources unavailable',async()=>{
 const c=harness();Object.assign(c,{console,Map,Set,JSON,AbortController,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),map:{on(){}},temperatureImageCache:new Map(),temperatureStatsCache:new Map(),temperatureSeries:[],temperatureLoadedAt:0,temperatureRenderToken:1,TEMP_CACHE_LIMIT:6,localStorage:{getItem:()=>null}});
 c.officialStationsNearTime=()=>[station(40,-100,15)];
 let maskCalls=0;
 c.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}}),toDataURL:()=> 'data:image/png;test'})};
 vm.runInContext(fs.readFileSync(__dirname+'/../js/temperature.js','utf8'),c);
 vm.runInContext('loadTemperatureCountryFeatures=async()=>[];clipTemperatureToCountries=()=>{maskCalls++;return true;};',Object.assign(c,{maskCalls:0}));
 const result=await vm.runInContext(`createTemperatureImage(${now},1)`,c);
 assert(result.regions.some(r=>r.id==='usa'&&r.stationBased&&r.coastlineClipped));assert(Math.abs(result.minT-15)<.001);assert(Math.abs(result.maxT-15)<.001);assert.equal(c.maskCalls,1);
});



test('Latest heatmaps use fresh station time when the radar timeline lags, while history stays historical',async()=>{
 const c=harness(),live=Math.floor(Date.now()/1000),radar=live-7200;
 Object.assign(c,{console,Map,Set,JSON,AbortController,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),map:{on(){}},temperatureImageCache:new Map(),temperatureStatsCache:new Map(),temperatureSeries:[],temperatureLoadedAt:0,temperatureRenderToken:1,TEMP_CACHE_LIMIT:6,localStorage:{getItem:()=>null},frames:[{time:radar}]});
 c.officialStationsNearTime=()=>[station(40,-100,15,live-600)];
 c.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}}),toDataURL:()=> 'data:image/png;test'})};
 vm.runInContext(fs.readFileSync(__dirname+'/../js/temperature.js','utf8'),c);
 vm.runInContext('loadTemperatureCountryFeatures=async()=>[];clipTemperatureToCountries=()=>true;',c);
 const current=await vm.runInContext(`createTemperatureImage(${radar},1)`,c);assert(Math.abs(current.minT-15)<.001);assert(current.observationTime>=live);
 const old=await vm.runInContext(`createTemperatureImage(${radar-3600},1)`,c);assert.equal(old.minT,Infinity);
});
