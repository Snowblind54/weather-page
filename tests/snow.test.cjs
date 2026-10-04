const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(fetch){
  const els=new Map();
  const get=id=>{
    if(!els.has(id))els.set(id,{checked:false,hidden:true,value:'85',classList:{add(){},remove(){}},addEventListener(){},dispatchEvent(e){this.changes=(this.changes||0)+1;},textContent:''});
    return els.get(id);
  };
  const layers=new Set(),events={};
  function Layer(url,options){this.options=options;this.rasterId=null;}
  Layer.prototype={on(type,fn){events[type]=fn;return this;},addTo(){layers.add(this);return this;},redraw(){this.redraws=(this.redraws||0)+1;},setOpacity(n){this.opacity=n;},getTileSize(){return {x:256,y:256};}};
  const ctx={console:{warn(){}},URLSearchParams,AbortSignal,Event,Date,Number,JSON,
    document:{body:{classList:{add(){},remove(){}}}},$:get,
    fetch:fetch|| (async()=>({ok:true,json:async()=>({features:[{attributes:{objectid:7,idp_filedate:Date.UTC(2026,9,3)}}]})})),
    setInterval:()=>1,clearInterval(){},stop(){},closeWeatherPanel(){},
    map:{options:{crs:{project:p=>({x:p.lng,y:p.lat})}},unproject:(p,z)=>({lng:p.x,lat:p.y}),createPane(){},getPane:()=>({style:{}}),
      getCenter:()=>({lat:57,lng:24}),getZoom:()=>6,fitBounds(b){this.bounds=b;},setView(c,z){this.center=c;this.zoom=z;},closePopup(){},removeLayer:l=>layers.delete(l)},
    L:{point:(x,y)=>({x,y}),TileLayer:{extend:methods=>{function Sub(...args){Layer.apply(this,args);}Sub.prototype={...Layer.prototype,...methods};return Sub;}}}
  };
  vm.createContext(ctx);const run=s=>vm.runInContext(s,ctx);
  run(fs.readFileSync('js/snow.js','utf8'));
  return {ctx,get,run,layers,events};
}
test('snow switches off conflicting layers and restores prior view and selected layers on exit',()=>{
  const h=harness();h.get('cloudOn').checked=true;h.get('heatmapOn').checked=true;
  h.run('enterSnowView()');assert.equal(h.get('cloudOn').checked,false);assert.equal(h.get('heatmapOn').checked,false);
  assert.equal(h.get('snowOn').checked,true);assert.equal(h.layers.size,1);
  h.run('exitSnowView()');assert.equal(h.get('cloudOn').checked,true);assert.equal(h.get('heatmapOn').checked,true);
  assert.equal(h.get('radarOn').checked,false);assert.equal(h.layers.size,0);assert.equal(h.ctx.map.zoom,6);
});
test('source date comes from NOAA metadata and tiles pin the same source raster',async()=>{
  const h=harness();h.run('snowMode=true');await h.run('refreshSnowCoverage()');
  assert.match(h.get('snowDate').textContent,/2026-10-03/);
  const url=new URL(h.run('snowLayer.getTileUrl({x:1,y:1,z:2})'));
  assert.equal(url.searchParams.get('bboxSR'),'3857');assert.equal(url.searchParams.get('format'),'png32');
  assert.deepEqual(JSON.parse(url.searchParams.get('mosaicRule')).lockRasterIds,[7]);
  const rule=JSON.parse(url.searchParams.get('renderingRule'));
  assert.deepEqual(rule.rasterFunctionArguments.Raster.rasterFunctionArguments.NoDataRanges,[0,3]);
});
test('late metadata cannot resurrect snow after switching categories',async()=>{
  let release;const h=harness(()=>new Promise(r=>release=r));
  h.run('snowMode=true');const request=h.run('refreshSnowCoverage()');h.run('exitSnowView()');
  release({ok:true,json:async()=>({features:[{attributes:{objectid:9,idp_filedate:1234}}]})});
  await request;assert.equal(h.layers.size,0);assert.equal(h.run('snowLayer.redraws'),undefined);
});
test('tile errors are reported as unavailable, not as snow-free coverage',()=>{
  const h=harness();h.run('snowMode=true');h.events.loading();h.events.tileerror();h.events.load();
  assert.match(h.get('snowStatus').textContent,/could not load/);assert.match(h.get('snowStatus').className,/bad/);
});
test('metadata failure keeps imagery usable without inventing a date',async()=>{
  const h=harness(async()=>{throw new Error('offline');});h.run('snowMode=true');await h.run('refreshSnowCoverage()');
  assert.match(h.get('snowDate').textContent,/date unavailable/);assert.equal(h.run('snowLayer.redraws'),1);
});
test('Snow navigation activates automatically; another weather category restores the weather view',()=>{
  const source=fs.readFileSync('js/ui.js','utf8');
  const snippet=source.slice(source.indexOf('function openWeatherPanel'),source.indexOf('for(const button'));
  let entered=0,exited=0;
  const elements=new Map(),get=id=>{
    if(!elements.has(id))elements.set(id,{hidden:true,setAttribute(){}});
    return elements.get(id);
  };
  const context={$:get,openedWeatherPanel:null,snowMode:false,
    enterSnowView(){entered++;context.snowMode=true;},
    exitSnowView(){exited++;context.snowMode=false;},
    closeWeatherPanel(){context.openedWeatherPanel=null;},positionWeatherPanel(){},syncTimelineCadence(){}};
  vm.createContext(context);vm.runInContext(snippet,context);
  vm.runInContext("openWeatherPanel('snowSection')",context);
  assert.equal(entered,1);assert.equal(get('snowSection').hidden,false);
  vm.runInContext("openWeatherPanel('tempSection')",context);
  assert.equal(exited,1);assert.equal(get('tempSection').hidden,false);
});
