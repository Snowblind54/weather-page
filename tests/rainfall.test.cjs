const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.join(__dirname,'..');

function harness(){
  const elements={},layers=new Set(),canvases=[],events={},storage=new Map(),panes=new Map();
  for(const id of ['rain1h','rain24h','rain48h','rainAccumOpacity','rainAccumOpacityVal','rainAccumStatus','radarSection','windOn']){
    elements[id]={checked:false,value:'65',classList:{toggle(){}},listeners:{},addEventListener(n,f){this.listeners[n]=f;}};
  }
  const map={on(n,f){events[n]=f;},createPane(n){panes.set(n,{style:{}});},getPane:n=>panes.get(n),
    hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l)};
  function layer(extra={}){return {...extra,addTo(){layers.add(this);return this;}};}
  const context={console,Date,Math,JSON,Number,Map,Set,WeakMap,AbortController,URL,setTimeout,clearTimeout,
    setInterval:()=>0,requestAnimationFrame:f=>setImmediate(f),window:{},map,$:id=>elements[id],
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    selectedWindTime:()=>context.frameTime,frameTime:Math.floor(Date.now()/3600000)*3600,
    fmt:t=>new Date(t*1000).toISOString(),htmlEscape:s=>String(s),windPopupContent:(p,t)=>'Wind at '+t,
    document:{createElement(){
      const canvas={width:0,height:0,maskFills:0,toDataURL:()=>`data:image/png;test,${canvases.length}`};
      const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){canvas.maskFills++;},
        createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>canvas.pixels=image.data};
      canvas.getContext=()=>ctx;canvases.push(canvas);return canvas;
    }},L:{imageOverlay:(dataUrl,bounds,options)=>layer({dataUrl,bounds,options,setOpacity(v){this.options.opacity=v;}}),
      layerGroup:children=>layer({children,eachLayer:f=>children.forEach(f)}),
      popup:()=>layer({setContent(v){this.content=v;return this;},setLatLng(v){this.point=v;return this;},openOn(){layers.add(this);return this;}})}
  };
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(root,'js/temperature.js'),'utf8'));
  // Small grids exercise the complete renderer and loader without costly fixture images.
  run(`TEMP_GRID_SPECS.splice(0,TEMP_GRID_SPECS.length,...TEMP_REGIONS.map(r=>makeStructuredGrid(r.id,r.bounds,
    r.bounds[1][0]-r.bounds[0][0],r.bounds[1][1]-r.bounds[0][1])));TEMP_REGIONS.forEach(r=>{r.w=8;r.h=6;});sleep=async()=>{};`);
  const features=run(`TEMP_REGIONS.flatMap(r=>[...TEMP_REGION_COUNTRY_IDS[r.id]].map(id=>({id,
    geometry:{type:'Polygon',coordinates:[[[r.bounds[0][1],r.bounds[0][0]],[r.bounds[1][1],r.bounds[0][0]],
    [r.bounds[1][1],r.bounds[1][0]],[r.bounds[0][1],r.bounds[1][0]],[r.bounds[0][1],r.bounds[0][0]]]]}})))`);
  context.fixtureFeatures=features;
  run('loadTemperatureCountryFeatures=async()=>fixtureFeatures;');
  run(fs.readFileSync(path.join(root,'js/rainfall.js'),'utf8'));
  function seed(amount=2){
    context.amount=amount;
    run(`rainData={version:1,savedAt:Date.now(),grids:Object.fromEntries(TEMP_GRID_SPECS.map(spec=>[spec.id,
      spec.points.map(([lat,lon])=>({lat,lon,times:Array.from({length:55},(_,i)=>rainWindowEnd()-(54-i)*3600),
      amounts:Array(55).fill(amount)}))]))};rainCountryFeatures=fixtureFeatures;`);
  }
  return {context,run,elements,layers,canvases,events,storage,seed};
}

test('completed rolling windows: correct boundaries, midnight/DST, missing and future hours',()=>{
  const h=harness();h.seed();
  assert.equal(h.run('rollingRainTotal(rainData.grids.poland[0],rainWindowEnd(),1)'),2);
  assert.equal(h.run('rollingRainTotal(rainData.grids.poland[0],rainWindowEnd(),24)'),48);
  assert.equal(h.run('rollingRainTotal(rainData.grids.poland[0],rainWindowEnd(),48)'),96);
  h.run('rainData.grids.poland[0].amounts[6]=999;');
  assert.equal(h.run('rollingRainTotal(rainData.grids.poland[0],rainWindowEnd(),48)'),96,'hour before window excluded');
  h.context.frameTime+=1800;
  assert.equal(h.run('rainWindowEnd()'),Math.floor(h.context.frameTime/3600)*3600);
  h.context.frameTime+=36000;
  assert(h.run('rainWindowEnd()<=Date.now()/1000'),'future timeline capped at present');
  h.run('rainData.grids.poland[0].amounts[54]=null;');
  assert(h.run('Number.isNaN(rollingRainTotal(rainData.grids.poland[0],rainWindowEnd(),24))'));
  assert(h.run('Number.isNaN(rollingRainTotal(rainData.grids.poland[0],rainWindowEnd()+3600,1))'));
  // Epoch-based summation stays at exactly 24 hours across local clock changes.
  for(const end of [Date.parse('2026-03-29T12:00:00Z')/1000,Date.parse('2026-10-25T12:00:00Z')/1000]){
    h.context.endFixture=end;
    assert.equal(h.run('rollingRainTotal({times:Array.from({length:49},(_,i)=>endFixture-(48-i)*3600),amounts:Array(49).fill(1)},endFixture,24)'),24);
  }
});

test('hourly source adds rain and showers, excludes snow, and preserves nulls',()=>{
  const h=harness();
  h.context.payload={hourly_units:{rain:'mm',showers:'mm'},hourly:{
    time:Array.from({length:55},(_,i)=>h.context.frameTime-(54-i)*3600),
    rain:Array(55).fill(1.2),showers:Array(55).fill(0.3),snowfall:Array(55).fill(8)}};
  assert.equal(h.run('normalizeRainSeries(payload,[59,25]).amounts[0]'),1.5);
  h.context.payload.hourly.rain[0]=null;
  assert.equal(h.run('normalizeRainSeries(payload,[59,25]).amounts[0]'),null);
  h.context.payload.hourly_units.rain='inch';
  assert.throws(()=>h.run('normalizeRainSeries(payload,[59,25])'),/Incomplete/);
});

test('coverage and click totals use the same masks, including islands and holes',()=>{
  const h=harness();h.seed();
  for(const [lat,lon] of [[58,25],[52,19],[55,12],[65,20],[65,-20]]){
    h.context.point=[lat,lon];
    assert(Math.abs(h.run('rainTotalsAt(...point,rainWindowEnd())[48]')-96)<1e-8);
  }
  assert.equal(h.run('rainTotalsAt(0,0,rainWindowEnd())'),null);
  h.context.feature={geometry:{type:'MultiPolygon',coordinates:[
    [[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[3,1],[3,3],[1,3],[1,1]]],
    [[[8,8],[9,8],[9,9],[8,9],[8,8]]]]}};
  assert(h.run('weatherPointInFeature(0.5,0.5,feature)'));
  assert(!h.run('weatherPointInFeature(2,2,feature)'),'interior hole excluded');
  assert(h.run('weatherPointInFeature(8.5,8.5,feature)'),'island included');
  h.run('rainData.grids.poland[0].amounts[54]=null;');
  assert(h.run('Number.isNaN(rainTotalsAt(52,19,rainWindowEnd())[24])'),'missing weighted neighbour not filled as zero');
  assert(h.run('rainfallPopupContent({lat:52,lng:19},rainWindowEnd()).includes("Unavailable")'));
});

test('renderer masks all five regions, leaves dry pixels transparent and cancels obsolete renders',async()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  await h.run('renderRainfall()');
  assert.equal(h.layers.size,1);
  const group=[...h.layers][0];assert.equal(group.children.length,5);
  assert(h.canvases.every(c=>c.maskFills===1),'all regional country masks applied');
  assert(h.canvases.some(c=>c.pixels.some((v,i)=>i%4===3&&v>0)),'wet pixels coloured');
  assert.equal(group.children[0].options.pane,'rainAccumulationPane');
  h.seed(0);h.run('rainImageCache.clear();');h.canvases.length=0;
  await h.run('renderRainfall()');
  assert(h.canvases.every(c=>!c.pixels.some((v,i)=>i%4===3&&v>0)),'dry regions transparent');
  h.seed();h.run('rainImageCache.clear();');
  const pending=h.run('renderRainfall()');
  h.elements.rain24h.checked=false;h.run('changeRainfallPeriod(24)');await pending;
  assert.equal(h.layers.size,0,'turning off during rendering cannot resurrect image');
  h.elements.rain1h.checked=true;h.run('loadTemperatureCountryFeatures=async()=>fixtureFeatures.filter(f=>f.id!=="233");rainImageCache.clear();');
  await assert.rejects(h.run('renderRainfall()'),/coastline missing/,'missing coastline never draws rectangle');
});

test('popup has all totals and keeps wind readings; radar and period controls stay independent',async()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  await h.run('renderRainfall()');
  h.events.click({latlng:{lat:52,lng:19}});
  const content=h.run('rainPopup.content');
  for(const value of ['1 h','24 h','48 h','2.0','48.0','96.0','mm','model estimate']) assert(content.includes(value),value);
  h.elements.windOn.checked=true;h.run('updateAccumulationPopup()');assert(h.run('rainPopup.content.includes("Wind at")'));
  h.elements.rain48h.checked=true;h.run('changeRainfallPeriod(48)');
  assert(!h.elements.rain24h.checked);assert.equal(h.run('activeAccumulationHours()'),48);
  h.elements.rain48h.checked=false;h.run('changeRainfallPeriod(48)');assert.equal(h.layers.size,0);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert(html.indexOf('id="rain1h"')>html.indexOf('id="radarSection"'));
  assert(html.indexOf('id="rain48h"')<html.indexOf('id="warningSection"'));
  assert(html.includes('js/rainfall.js?v=8.14'));
});

test('loader requests past hours once, validates cache coverage, and respects disable while fetching',async()=>{
  const h=harness();h.elements.rain1h.checked=true;let requests=0;
  h.context.fetch=async url=>{
    requests++;
    const query=new URL(url).searchParams;
    assert.equal(query.get('hourly'),'rain,showers');assert.equal(query.get('past_hours'),'54');
    assert.equal(query.get('timeformat'),'unixtime');assert.equal(query.get('precipitation_unit'),'mm');
    const rows=query.get('latitude').split(',').map(()=>({hourly_units:{rain:'mm',showers:'mm'},hourly:{
      time:Array.from({length:55},(_,i)=>h.context.frameTime-(54-i)*3600),rain:Array(55).fill(1),showers:Array(55).fill(0.5)}}));
    return {ok:true,json:async()=>rows};
  };
  await Promise.all([h.run('loadRainfall()'),h.run('loadRainfall()')]);
  assert.equal(requests,5,'concurrent toggles share one load');
  await h.run('loadRainfall()');assert.equal(requests,5,'mode switch reuses source cache');
  assert(h.run('validRainData(rainData,rainWindowEnd())'));
  assert(!h.run('validRainData(rainData,rainWindowEnd()+3600)'),'next missing hour invalidates cache');
  h.run('rainData.savedAt=Date.now()-31*60000;');assert(!h.run('validRainData(rainData,rainWindowEnd())'));
  h.elements.rain1h.checked=false;h.run('changeRainfallPeriod(1)');
  const race=harness();race.elements.rain24h.checked=true;let release;
  race.context.fetch=async()=>{await new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>
    Array(4).fill({hourly_units:{rain:'mm',showers:'mm'},hourly:{time:Array.from({length:55},(_,i)=>race.context.frameTime-(54-i)*3600),rain:Array(55).fill(0),showers:Array(55).fill(0)}})};};
  const pending=race.run('loadRainfall()');race.elements.rain24h.checked=false;release();await pending;
  assert.equal(race.layers.size,0);
});

test('rate-limit cooldown prevents repeated requests on period switches',async()=>{
  const h=harness();h.elements.rain1h.checked=true;let calls=0;
  h.context.fetch=async()=>{calls++;return {ok:false,status:429};};
  await assert.rejects(h.run('loadRainfall()'),/busy/);
  await assert.rejects(h.run('loadRainfall()'),/cooling down/);
  assert.equal(calls,1);
});
