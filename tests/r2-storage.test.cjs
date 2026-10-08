const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('js/r2-storage.js','utf8');
function setup(fail=false){const calls=[];const window={WEATHER_R2_BASE:'https://example.r2.dev',location:{href:'https://snowblind54.github.io/weather-page/'},fetch:async(url,opts)=>{calls.push([url,opts]);return {ok:!fail||calls.length>1};}};vm.runInNewContext(code,{window,URL,Request});return {window,calls};}
(async()=>{
 let {window,calls}=setup();
 await window.fetch('data/cyclones.json?v=1',{cache:'no-store'});
 assert.equal(calls[0][0],'https://example.r2.dev/weather/data/cyclones.json?v=1');
 assert.equal(calls[0][1].cache,'no-store');assert.equal(calls[0][1].credentials,'omit');
 assert.equal(window.weatherDataUrl('data/radar-tiles/frame/3/1/2.png'),'https://example.r2.dev/weather/data/radar-tiles/frame/3/1/2.png');
 await window.fetch('https://official.example/data/file.json');assert.equal(calls[1][0],'https://official.example/data/file.json');
 await window.fetch('data/estonia-marine-warning-zones.geojson');assert.equal(calls[2][0],'data/estonia-marine-warning-zones.geojson');
 ({window,calls}=setup(true));await window.fetch('data/official-wind.json');assert.equal(calls.length,2);assert.equal(calls[1][0],'data/official-wind.json');
 ({window,calls}=setup());await window.fetch(new Request('https://snowblind54.github.io/weather-page/data/model-wind.json',{headers:{Range:'bytes=0-1023'}}));assert.equal(calls[0][0].headers.get('Range'),'bytes=0-1023');
 const images=[];
 class MockImage {
  constructor(){this.naturalWidth=256;this.naturalHeight=256;images.push(this);}
  set src(value){this.url=value;if(value)queueMicrotask(()=>this.onload?.());}
 }
 const imageContext={window,weatherDataUrl:window.weatherDataUrl,Image:MockImage,Map,Promise,setTimeout,clearTimeout,queueMicrotask};
 const native=fs.readFileSync('js/radar-images.js','utf8');
 const tile=await vm.runInNewContext(native+"\nloadRadarNativeImage('data/radar-tiles/frame/3/1/2.png',{pixels:true})",imageContext);
 assert.equal(tile.image.url,'https://example.r2.dev/weather/data/radar-tiles/frame/3/1/2.png');
 assert.equal(tile.image.crossOrigin,'anonymous');
 vm.runInNewContext(fs.readFileSync('js/forecast-map-data.js','utf8'),{window});
 const asset='data/forecast-cache/20261008T12Z/temperature-legend.webp';
 assert.equal(window.ForecastMapData.assetUrl({delivery:'static-regional-images',reference_time:'2026-10-08T12:00:00Z',legends:{temperature:asset}},'temperature'),'https://example.r2.dev/weather/'+asset);
 console.log('R2 routing, official feeds, static geometry, range headers and fallback checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
