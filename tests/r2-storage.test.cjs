const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('js/r2-storage.js','utf8');
const R2='https://example.r2.dev/weather/',GH='https://raw.githubusercontent.com/Snowblind54/weather-page/weather-fallback/';
function setup({fail=false,active=false}={}){
 const calls=[];let now=Date.now();
 const window={WEATHER_R2_BASE:'https://example.r2.dev',location:{href:'https://snowblind54.github.io/weather-page/'},fetch:async(input,opts)=>{
  const url=input instanceof Request?input.url:String(input);calls.push([input,opts]);
  if(opts?.signal?.aborted)throw opts.signal.reason;
  if(url.includes('_fallback/status'))return new Response(JSON.stringify({version:1,mode:active?'active':'standby',until:active?now/1000+120:0}));
  return new Response(url,{status:fail&&url.startsWith(R2)?503:200});
 }};
 vm.runInNewContext(code,{window,URL,Request,Response,AbortController,DOMException,setTimeout,clearTimeout,Date:class extends Date{static now(){return now;}}});
 return {window,calls,advance:ms=>now+=ms};
}
const address=input=>input instanceof Request?input.url:String(input);
(async()=>{
 let {window,calls}=setup();
 let result=await window.fetch('data/cyclones.json?v=1',{cache:'no-store'});
 assert.equal(await result.text(),R2+'data/cyclones.json?v=1');
 assert.equal(calls[0][1].cache,'no-store');assert.equal(calls[0][1].credentials,'omit');
 assert.equal(window.weatherDataUrl('data/radar-tiles/frame/3/1/2.png'),R2+'data/radar-tiles/frame/3/1/2.png');
 await window.fetch('https://official.example/data/file.json');assert.equal(address(calls.at(-1)[0]),'https://official.example/data/file.json');
 await window.fetch('data/estonia-marine-warning-zones.geojson');assert.equal(address(calls.at(-1)[0]),'data/estonia-marine-warning-zones.geojson');
 ({window,calls}=setup({fail:true}));result=await window.fetch('data/official-wind.json');
 assert.equal(await result.text(),GH+'data/official-wind.json');
 assert.equal(window.weatherDataUrl('data/forecast-cache/run/temperature.webp'),GH+'data/forecast-cache/run/temperature.webp');
 await window.fetch('data/official-temperature.json');assert.equal(address(calls.at(-1)[0]),GH+'data/official-temperature.json');
 ({window,calls}=setup({active:true}));result=await window.fetch('data/model-wind.json');
 assert.equal(await result.text(),GH+'data/model-wind.json'); // Even stale HTTP-200 R2 responses are bypassed during a publishing pause.
 ({window,calls}=setup({fail:true}));const request=new Request('https://snowblind54.github.io/weather-page/data/model-wind.json',{headers:{Range:'bytes=0-1023'}});
 await window.fetch(request);assert.equal(calls[0][0].headers.get('Range'),'bytes=0-1023');
 const retry=calls.find(([input])=>address(input).startsWith(GH+'data/'));assert.equal(retry[0].headers.get('Range'),'bytes=0-1023');
 ({window,calls}=setup({fail:true}));result=await window.fetch('data/radar-tiles.json');assert.equal(result.status,503);
 assert(!calls.some(([input])=>address(input).startsWith(GH+'data/radar-tiles')));
 assert.equal(window.weatherDataUrl('data/official-wind.json'),R2+'data/official-wind.json'); // Missing optional tiles alone must not divert all snapshots.
 ({window,calls}=setup());const abort=new AbortController();abort.abort();
 await assert.rejects(window.fetch('data/model-wind.json',{signal:abort.signal}));
 assert(!calls.some(([input])=>address(input).startsWith(GH+'data/')));
 const recovery=setup({active:true});await recovery.window.fetch('data/model-wind.json');recovery.advance(180000);
 assert.equal(recovery.window.weatherDataUrl('data/model-wind.json'),R2+'data/model-wind.json');
 ({window,calls}=setup());await window.fetch('data/model-wind.json');
 const images=[];class MockImage{constructor(){this.naturalWidth=256;this.naturalHeight=256;images.push(this);}set src(value){this.url=value;if(value)queueMicrotask(()=>this.onload?.());}}
 const imageContext={window,weatherDataUrl:window.weatherDataUrl,Image:MockImage,Map,Promise,setTimeout,clearTimeout,queueMicrotask};
 const native=fs.readFileSync('js/radar-images.js','utf8');
 const tile=await vm.runInNewContext(native+"\nloadRadarNativeImage('data/radar-tiles/frame/3/1/2.png',{pixels:true})",imageContext);
 assert.equal(tile.image.url,R2+'data/radar-tiles/frame/3/1/2.png');assert.equal(tile.image.crossOrigin,'anonymous');
 const backupTile=await vm.runInNewContext("loadRadarNativeImage('"+GH+"data/radar-cache/iceland/frame.png',{pixels:true})",imageContext);assert.equal(backupTile.image.crossOrigin,'anonymous');
 vm.runInNewContext(fs.readFileSync('js/forecast-map-data.js','utf8'),{window});
 const asset='data/forecast-cache/20261008T12Z/temperature-legend.webp';
 assert.equal(window.ForecastMapData.assetUrl({delivery:'static-regional-images',reference_time:'2026-10-08T12:00:00Z',legends:{temperature:asset}},'temperature'),R2+asset);
 console.log('R2 healthy, outage, pause, recovery, cancellation, asset/CORS and direct-provider fallback checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
