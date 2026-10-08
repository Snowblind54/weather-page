const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');const D=require('../js/forecast-map-data.js');
const now=Date.parse('2026-10-07T21:30:00Z'),first=Date.parse('2026-10-07T21:00:00Z');
const manifest={delivery:'static-regional-images',endpoint:'https://thredds.met.no/thredds/wms/metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc',reference_time:'2026-10-07T21:00:00Z',bounds:[-11,52,42,74],time_dimension:'2026-10-07T21:00:00Z/2026-10-10T07:00:00Z/PT1H',layers:Object.fromEntries(Object.entries(D.layers).map(([key,l])=>[key,l.name]))};
manifest.cached_times=D.expandTimes(manifest.time_dimension).slice(0,-1).map(t=>new Date(t).toISOString());
manifest.images={};manifest.legends={};
for(const kind of Object.keys(D.layers)){manifest.images[kind]={};manifest.legends[kind]='data/forecast-cache/20261007T21Z/'+kind+'-legend.webp';for(const t of manifest.cached_times)manifest.images[kind][t]='data/forecast-cache/20261007T21Z/'+kind+'-'+t.replace(/[-:]/g,'').slice(0,11)+'Z.webp';}
test('source hourly intervals are expanded exactly and corrupt dimensions are rejected',()=>{
  assert.equal(D.expandTimes(manifest.time_dimension).length,59);assert.deepEqual(D.expandTimes('bad/bad/PT0H'),[]);assert.deepEqual(D.expandTimes('2026-10-07T21:00:00Z,2026-10-07T21:00:00Z'),[first]);
});
test('only forecast runs are selected, latest first; analysis and moving latest paths are excluded',()=>{
  const paths=['metpplatest/met_forecast_1_0km_nordic_latest.nc','metpplatest/met_analysis_1_0km_nordic_20261007T22Z.nc','metpplatest/met_forecast_1_0km_nordic_20261007T20Z.nc','metpplatest/met_forecast_1_0km_nordic_20261007T21Z.nc'];
  assert.equal(D.runs(paths).length,2);assert.equal(D.reference(D.runs(paths)[0]),first);
});
test('a next-hour rain selection requests the source ending hour, unlike temperature',()=>{
  assert.equal(D.params('rain',first).time,'2026-10-07T22:00:00.000Z');assert.equal(D.params('temperature',first).time,'2026-10-07T21:00:00.000Z');assert.equal(D.params('rain',first).belowmincolor,'transparent');
});
test('all layers share available times that leave room for the next-hour rain period',()=>{
  const times=D.availableTimes(D.expandTimes(manifest.time_dimension),now);assert.equal(times.at(-1),Date.parse('2026-10-10T06:00:00Z'));assert(!times.includes(Date.parse('2026-10-10T07:00:00Z')));
});
test('shared image URLs stay on the website and reject external images',()=>{
  assert.equal(D.assetUrl(manifest,'wind',first),'data/forecast-cache/20261007T21Z/wind-20261007T21Z.webp');
  assert.equal(D.assetUrl(manifest,'rain'),'data/forecast-cache/20261007T21Z/rain-legend.webp');
  const bad=structuredClone(manifest);bad.images.wind[new Date(first).toISOString()]='https://thredds.met.no/image.png';assert.throws(()=>D.assetUrl(bad,'wind',first));
});
test('expanded Atlantic assets have immutable versioned URLs and reject unknown versions',()=>{
  const m=structuredClone(iceManifest);m.asset_version='atlantic-v1';
  for(const kind of Object.keys(m.layers)){
    m.legends[kind]=m.legends[kind].replace('20261007T21Z/','20261007T21Z-atlantic-v1/');
    for(const time of m.cached_times)m.images[kind][time]=m.images[kind][time].replace('20261007T21Z/','20261007T21Z-atlantic-v1/');
  }
  assert.match(D.assetUrl(m,'wind',first),/20261007T21Z-atlantic-v1\/wind/);
  m.asset_version='../../other';assert.throws(()=>D.assetUrl(m,'wind',first));
});
test('timeline only exposes complete shared frames and does not discard the final cached hour',()=>{
  assert.equal(D.cachedTimes(manifest,now).at(-1),Date.parse('2026-10-10T06:00:00Z'));
  const missing=structuredClone(manifest);delete missing.images.clouds[new Date(first).toISOString()];assert(!D.cachedTimes(missing,now).includes(first));
});
const iceManifest=structuredClone(manifest);iceManifest.asset_root='forecast-iceland-cache';iceManifest.bounds=[-28,61,-12,69];iceManifest.periods={};
for(const kind of Object.keys(D.layers)){iceManifest.legends[kind]=iceManifest.legends[kind].replace('forecast-cache','forecast-iceland-cache');for(const time of iceManifest.cached_times)iceManifest.images[kind][time]=iceManifest.images[kind][time].replace('forecast-cache','forecast-iceland-cache');}
for(const time of iceManifest.cached_times)iceManifest.periods[time]={start:time,end:new Date(Date.parse(time)+3*3600000).toISOString(),interpolated:false};
const flush=()=>new Promise(r=>setImmediate(r));
function harness({iceland=false,wide=false}={}){
  const ids={},classes=new Set(),images=[],overlays=[],timers=new Map(),listeners={};let tid=0,observer;
  class Element{
    constructor(){this.children=[];this.options=[];this.value='0';this.events={};this.hidden=false;this.dataset={};this.classList={toggle:(name,on)=>on?classes.add(name):classes.delete(name)};}
    set innerHTML(s){for(const m of s.matchAll(/id="([^"]+)"/g))ids[m[1]]=new Element();if(ids.forecastMapLayer)ids.forecastMapLayer.value='temperature';if(ids.forecastMapOpacity)ids.forecastMapOpacity.value='55';}
    append(...xs){this.children.push(...xs);}before(){}setAttribute(k,v){this[k]=v;}addEventListener(k,f){this.events[k]=f;}replaceChildren(...xs){this.children=xs;}
  }
  for(const id of ['forecastSection','forecastLocation','nav-forecastSection','forecastRetry'])ids[id]=new Element();ids.forecastSection.hidden=true;
  const body=new Element(),c={document:{body,hidden:false,createElement:()=>new Element(),addEventListener:(k,f)=>listeners[k]=f,dispatchEvent:e=>listeners[e.type]?.(e)},window:{},$:id=>ids[id],
    ForecastMapData:{...D,cachedTimes:meta=>D.cachedTimes(meta,now)},Date:class extends Date{static now(){return now;}},URLSearchParams,AbortController,CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},console:{warn(){}},
    setTimeout:(f,n)=>{const id=++tid;timers.set(id,{f,n});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},
    MutationObserver:class{constructor(f){observer=f;}observe(){}},fetch:async url=>({ok:true,json:async()=>url.includes('forecast-iceland')&&iceland?iceManifest:manifest}),
    Image:class{constructor(){images.push(this);this.dataset={};}set src(v){this.url=v;}cloneNode(){return {dataset:{},url:this.url};}},
    L:{DomEvent:{disableClickPropagation(){},disableScrollPropagation(){}},latLng:(lat,lng)=>({lat,lng}),CRS:{EPSG3857:{project:p=>({x:p.lng*100000,y:p.lat*100000})}},imageOverlay:(img,bounds,options)=>{const l={img,bounds,options,active:false,setOpacity(){},addTo(){this.active=true;img.attached=true;overlays.push(this);return this;}};return l;}},
    map:{createPane(){},getPane:()=>({style:{}}),getBounds:()=>({getEast:()=>30,getWest:()=>wide?-30:10,getNorth:()=>wide?74:62,getSouth:()=>52}),getSize:()=>({x:800,y:600}),removeLayer:l=>{l.active=false;l.img.attached=false;},on(events,f){for(const name of events.split(' '))listeners['map:'+name]=f;}}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/forecast-map.js','utf8'),c);
  const run=async()=>{for(const[id,t]of [...timers])if(t.n<1000){timers.delete(id);t.f();}await flush();};
  return {c,ids,classes,images,overlays,run,view:value=>{wide=value;listeners['map:moveend']();},open:()=>{ids.forecastSection.hidden=false;observer();},close:()=>{ids.forecastSection.hidden=true;observer();},time:t=>c.window.NorthernForecastMap.setTime(t),loaded:async i=>{images[i].onload();await flush();}};
}
test('late old map images cannot replace a newer forecast selection',async()=>{
  const h=harness();h.open();await h.run();h.time(first+3600000);await h.run();assert.equal(h.images.length,2);await h.loaded(1);await h.loaded(0);const active=h.overlays.filter(l=>l.active);assert.equal(active.length,1);assert.equal(active[0].img.dataset.forecastTime,'2026-10-07T22:00:00.000Z');
});
test('recent loaded frames are reused without creating another image request',async()=>{
  const h=harness();h.open();await h.run();await h.loaded(0);h.time(first+3600000);await h.run();await h.loaded(1);h.time(first);await h.run();assert.equal(h.images.length,2);assert.equal(h.overlays.filter(l=>l.active)[0].img.dataset.forecastTime,'2026-10-07T21:00:00.000Z');
});
test('leaving forecast mode prevents late maps from appearing and restores the normal view',async()=>{
  const h=harness();h.open();await h.run();h.c.window.NorthernForecastMap.setActive(false);h.close();await h.loaded(0);assert.equal(h.overlays.filter(l=>l.active).length,0);assert(!h.classes.has('forecast-model-view'));assert(h.ids.forecastMapLegend.hidden);
});

test('loaded map and legend only request shared website assets',async()=>{
  const h=harness();h.open();await h.run();await h.loaded(0);
  assert.match(h.images[0].url,/^data\/forecast-cache\//);assert.match(h.ids.forecastMapColorbar.src,/^data\/forecast-cache\//);
  assert.deepEqual(JSON.parse(JSON.stringify(h.overlays[0].bounds)),[[52,-11],[74,42]]);
});

test('Iceland uses the same hour and colour layer alongside the Nordic maps',async()=>{
  const h=harness({iceland:true,wide:true});h.open();await h.run();assert.equal(h.images.length,2);await h.loaded(0);await h.loaded(1);
  const maps=h.overlays.filter(l=>l.active);assert.equal(maps.length,2);assert.equal(maps[0].img.dataset.forecastTime,maps[1].img.dataset.forecastTime);assert.equal(maps[1].img.dataset.forecastRegion,'Iceland');assert.match(maps[1].img.url,/forecast-iceland-cache/);
  assert(maps[0].options.zIndex>maps[1].options.zIndex); // MET Nordic keeps priority.
  h.time(first+3600000);await h.run();assert.equal(h.images.length,4);await h.loaded(3);assert.equal(h.overlays.filter(l=>l.active)[0].img.dataset.forecastTime,'2026-10-07T21:00:00.000Z');await h.loaded(2);assert(h.overlays.filter(l=>l.active).every(l=>l.img.dataset.forecastTime==='2026-10-07T22:00:00.000Z'));
});
test('visible-region selection does not download Iceland frames when outside the viewport',()=>{
  const bounds={getEast:()=>30,getWest:()=>20,getNorth:()=>65,getSouth:()=>55};assert.equal(D.visibleRegions([manifest,iceManifest],bounds,'wind',first).length,1);
});

test('adding Iceland keeps the reused Nordic image attached after old overlays are removed',async()=>{
  const h=harness({iceland:true});h.open();await h.run();await h.loaded(0);
  const old=h.overlays[0].img;h.view(true);await h.run();await h.loaded(1);
  const active=h.overlays.filter(l=>l.active);assert.equal(active.length,2);
  assert(active.every(l=>l.img.attached));assert.notEqual(active[0].img,old);
  assert.equal(h.images.length,2); // Nordic source image was reused from cache.
});

test('closing the forecast menu keeps images and timeline active and allows changing hours',async()=>{
  const h=harness();h.open();await h.run();await h.loaded(0);h.close();
  assert(h.classes.has('forecast-model-view'));assert(h.classes.has('forecast-view'));
  assert(h.c.window.NorthernForecastMap.isActive());assert.equal(h.overlays.filter(l=>l.active).length,1);
  assert.equal(h.c.document.body.children[0].hidden,false);
  h.time(first+3600000);await h.run();await h.loaded(1);
  assert.equal(h.overlays.filter(l=>l.active)[0].img.dataset.forecastTime,'2026-10-07T22:00:00.000Z');
  h.c.window.NorthernForecastMap.setActive(false);
  assert(!h.classes.has('forecast-view'));assert(!h.classes.has('forecast-model-view'));
  assert.equal(h.c.document.body.children[0].hidden,true);assert.equal(h.overlays.filter(l=>l.active).length,0);
});
