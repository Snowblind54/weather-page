const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../js/clouds.js'),'utf8');
function harness(){
  const elements={cloudOn:{checked:true},cloudOpacity:{value:'60'},cloudStatus:{},timeline:{value:'0'}};
  const layers=new Set(),events={},timeouts=[];
  const canvas=()=>({dataset:{},width:256,height:256,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(data){this.data=data;},drawImage(){},clearRect(){}})});
  const context={console,Map,Set,Date,Math,Promise,Array,Uint8ClampedArray,Float32Array,URLSearchParams,AbortController,performance,
    document:{createElement:canvas},$:(id)=>elements[id],CLOUD_BOUNDS:[[25,-85],[82,42]],cloudLayer:null,
    frames:[{time:10000},{time:10300}],fmt:t=>String(t),weatherFront(){},
    map:{on:(name,cb)=>events[name]=cb,removeLayer:layer=>layers.delete(layer)},
    L:{GridLayer:{extend:methods=>function(){Object.assign(this,methods);this.setOpacity=()=>{};}}},
    setTimeout:(fn,delay)=>{timeouts.push({fn,delay});return timeouts.length;},clearTimeout(){},
    requestAnimationFrame:fn=>fn(performance.now()+1000)};
  vm.createContext(context);
  vm.runInContext(source,context);
  vm.runInContext(`for(const p of Object.values(cloudProducts))p.latest={[p.day]:9000,[p.night]:9000,'msg_fes:clm':9000}`,context);
  return {context,elements,layers,events,timeouts,run:s=>vm.runInContext(s,context)};
}
test('coverage matches wind, includes land and sea, and fades beyond satellite visibility',()=>{
  const h=harness();
  for(const [lat,lon] of [[40,-74],[35,-60],[60,-30],[57,25],[71,26],[55.75,37.6]]){
    assert(h.run(`Object.values(cloudSourceWeights(${lat},${lon})).reduce((a,b)=>a+b,0)`)>0,`${lat},${lon}`);
  }
  assert.equal(h.run('Object.values(cloudSourceWeights(83,20)).reduce((a,b)=>a+b,0)'),0);
  assert.equal(h.run('Object.values(cloudSourceWeights(60,50)).reduce((a,b)=>a+b,0)'),0);
  assert.equal(h.run('Object.values(cloudSourceWeights(82,0)).reduce((a,b)=>a+b,0)'),0);
});
test('day/night follows local longitude and excludes city-light imagery after sunset',()=>{
  const h=harness(),time=Date.parse('2026-09-22T18:00:00Z')/1000;
  assert.equal(h.run(`cloudSolarMix(${time},40,30).mode`),'night');
  assert.equal(h.run(`cloudSolarMix(${time},40,-75).mode`),'day');
  const index=h.run(`solarElevationDegrees(${time},40,-75)`);
  assert.equal(h.run(`solarElevationDegrees(${time},40,-75)`),index,'cached ephemeris matches');
  h.run(`nightTest={id:'eumet',day:new Uint8ClampedArray([255,255,255,255]),night:new Uint8ClampedArray([0,0,0,255]),dayTime:${time},nightTime:${time}}`);
  assert.equal(h.run('cloudExtractPixel(nightTest,0,0,40,30).alpha'),0);
});
test('transparent cloud extraction respects image alpha and the soft mask',()=>{
  const h=harness(),time=Date.parse('2026-09-22T12:00:00Z')/1000;
  h.run(`pixel={id:'eumet',day:new Uint8ClampedArray([255,255,255,0]),night:null,dayTime:${time},nightTime:${time}}`);
  assert.equal(h.run('cloudExtractPixel(pixel,0,0,40,0).alpha'),0);
  h.run('pixel.day[3]=255;pixel.guide=new Float32Array([0])');
  assert.equal(h.run('cloudExtractPixel(pixel,0,0,40,0).alpha'),0);
  h.run('pixel.guide[0]=1');
  assert(h.run('cloudExtractPixel(pixel,0,0,40,0).alpha')>.7);
});
test('NASA enhanced infrared palette maps cold coloured clouds to cloud brightness',()=>{
  const h=harness();
  assert(h.run('cloudInfraredLuminance(127,0,127)')>230);
  assert.equal(h.run('cloudInfraredLuminance(1,1,1)'),0);
});
test('tile requests have exact observation times, Mercator boxes, transparent backgrounds and blur padding',()=>{
  const h=harness();
  const url=new URL(h.run("cloudMapUrl(cloudProducts.eumet,'mtg_fd:ir105_hrfi',1791034200,{z:5,x:17,y:9})"));
  assert.equal(url.searchParams.get('srs'),'EPSG:3857');
  assert.equal(url.searchParams.get('time'),new Date(1791034200000).toISOString().replace('.000Z','Z'));
  assert.equal(url.searchParams.get('width'),'272');assert.equal(url.searchParams.get('transparent'),'true');
  const b=url.searchParams.get('bbox').split(',').map(Number);
  assert(Math.abs(b[2]-b[0]-40075016.68557849/32*272/256)<.0001);
});
test('historical frames never select a future observation; availability changes invalidate cache keys',()=>{
  const h=harness();
  assert.equal(h.run("cloudAvailableTime({cadence:300,times:{a:[100,400,700]}},'a',600)"),400);
  assert.throws(()=>h.run("cloudAvailableTime({cadence:300,times:{a:[700]}},'a',600)"));
  h.run("cloudProducts.eumet.latest={'mtg_fd:rgb_geocolour':9000,'mtg_fd:ir105_hrfi':9000}");
  const old=h.run('cloudTileKey({z:6,x:36,y:19},10000)');
  h.run("cloudProducts.eumet.latest={'mtg_fd:rgb_geocolour':9600,'mtg_fd:ir105_hrfi':9600}");
  assert.notEqual(old,h.run('cloudTileKey({z:6,x:36,y:19},10000)'));
});
test('initial cloud view does not preload history; manual/play activation buffers just one visible frame',()=>{
  const h=harness();
  h.run('cloudLayer={_tileZoom:6,_tiles:{one:{current:true,coords:{z:6,x:36,y:19}}}};calls=[];cloudGetTile=(c,t,p)=>{calls.push({t,p});return Promise.resolve({});}');
  h.run('scheduleCloudPrecache()');assert.equal(h.timeouts.length,0);
  h.run('requestCloudHistory();scheduleCloudPrecache()');assert.equal(h.timeouts.length,1);
  h.timeouts[0].fn();assert.equal(h.run('calls.length'),1);assert.equal(h.run('calls[0].t'),10300);assert.equal(h.run('calls[0].p'),1);
});
test('tile jobs are deduplicated, concurrency is bounded and cache memory is limited',async()=>{
  const h=harness();h.run('cloudLoadSource=async(id)=>({id,dayTime:0,nightTime:0});cloudProcessTile=()=>({canvas:{},times:[]});');
  const a=h.run('cloudGetTile({z:6,x:36,y:19},10000)'),b=h.run('cloudGetTile({z:6,x:36,y:19},10000)');
  assert.equal(a,b);await a;
  assert.equal(h.run('cloudTileCache.size'),1);
  await h.run('Promise.all(Array.from({length:160},(_,x)=>cloudGetTile({z:8,x:x+80,y:60},10000)))');
  assert(h.run('cloudTileCache.size')<=128);assert(h.run('cloudActiveJobs')<=4);
});
test('turning off clouds invalidates pending work and releases tiles and history',async()=>{
  const h=harness();let aborted=0;
  h.context.abortSpy={abort:()=>aborted++};
  h.run('cloudControllers.add(abortSpy);cloudTileCache.set("a",{});cloudLayer={};requestCloudHistory()');
  h.elements.cloudOn.checked=false;await h.run('drawCloud(null)');
  assert.equal(h.run('cloudLayer'),null);assert.equal(h.run('cloudTileCache.size'),0);
  assert.equal(h.run('cloudHistoryRequested'),false);assert.equal(aborted,1);
});
test('a delayed frame cannot repaint after the user disables clouds',async()=>{
  const h=harness();let release;
  h.context.blocker=new Promise(resolve=>release=resolve);
  h.run('cloudEnsureMetadata=()=>blocker');
  const drawing=h.run('drawCloud({time:10000})');
  h.elements.cloudOn.checked=false;await h.run('drawCloud(null)');release();await drawing;
  assert.equal(h.run('cloudLayer'),null);assert.equal(h.elements.cloudStatus.textContent,'Cloud layer is off.');
});
test('playback waits for the displayed frame and does not overlap asynchronous steps',async()=>{
  const h=harness();let release;
  h.elements.play={};h.elements.timeline={value:'0',min:'0',max:'2'};
  h.context.blocker=new Promise(resolve=>release=resolve);h.context.applyFrame=()=>h.context.blocker;
  h.run('let playing=false,timer=null;');
  const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
  h.run(app.slice(0,app.indexOf("$('locateBtn')")));
  h.run('start()');const first=h.timeouts.at(-1);const step=first.fn();
  assert.equal(h.elements.timeline.value,1);assert.equal(h.timeouts.at(-1),first,'no scheduled next step until ready');
  release();await step;assert(h.timeouts.length>1);
  h.run('stop()');const count=h.timeouts.length;await h.timeouts.at(-1).fn();assert.equal(h.timeouts.length,count);
});
