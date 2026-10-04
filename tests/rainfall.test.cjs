const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.join(__dirname,'..');

function harness(){
  const elements={},layers=new Set(),canvases=[],events={},storage=new Map(),panes=new Map();
  for(const id of ['rain1h','rain24h','rain48h','rainAccumOpacity','rainAccumOpacityVal','rainAccumStatus','rainSourceStatus','rainGaugeStatus','radarSection','windOn']){
    elements[id]={checked:false,value:'65',classList:{toggle(){}},listeners:{},addEventListener(n,f){this.listeners[n]=f;}};
  }
  const map={on(n,f){events[n]=f;},createPane(n){panes.set(n,{style:{}});},getPane:n=>panes.get(n),
    hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),getZoom:()=>5,
    getBounds:()=>({contains:p=>p.every(Number.isFinite)}),getContainer:()=>({getBoundingClientRect:()=>({x:0,y:0})}),
    latLngToContainerPoint:p=>({x:(p[1]+26)*20,y:(72-p[0])*20})};
  function layer(extra={}){return {...extra,addTo(){layers.add(this);return this;}};}
  const context={console,Date,Math,JSON,Number,Map,Set,WeakMap,AbortController,URL,setTimeout,clearTimeout,
    setInterval:()=>0,requestAnimationFrame:f=>setImmediate(f),window:{},map,$:id=>elements[id],
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    selectedWindTime:()=>context.frameTime,frameTime:Math.floor(Date.now()/3600000)*3600,
    fmt:t=>new Date(t*1000).toISOString(),htmlEscape:s=>String(s),windPopupContent:(p,t)=>'Wind at '+t,
    document:{querySelector:()=>null,createElement(){
      const canvas={width:0,height:0,maskFills:0,toDataURL:()=>`data:image/png;test,${canvases.length}`};
      const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){canvas.maskFills++;},
        createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>canvas.pixels=image.data};
      canvas.getContext=()=>ctx;canvases.push(canvas);return canvas;
    }},L:{divIcon:options=>options,marker:(point,options)=>layer({point,options,events:{},on(n,f){this.events[n]=f;return this;}}),
      imageOverlay:(dataUrl,bounds,options)=>layer({dataUrl,bounds,options,setOpacity(v){this.options.opacity=v;}}),
      layerGroup:children=>layer({children,eachLayer:f=>children.forEach(f)}),
      popup:options=>layer({options,setContent(v){this.content=v;return this;},setLatLng(v){this.point=v;return this;},openOn(){layers.add(this);return this;}})}
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
  run(fs.readFileSync(path.join(root,'js/official-rainfall.js'),'utf8'));
  run(fs.readFileSync(path.join(root,'js/rainfall.js'),'utf8'));
  run('officialRainLoadedAt=Date.now();');
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
  assert.equal(h.run('rainPopup.options.autoPan'),false,'timeline popup updates preserve the map view');
  assert.equal(h.run('rainPopup.options.keepInView'),false);
  for(const value of ['1 h','24 h','48 h','2.0','48.0','96.0','mm','Open-Meteo · model']) assert(content.includes(value),value);
  h.elements.windOn.checked=true;h.run('updateAccumulationPopup()');assert(h.run('rainPopup.content.includes("Wind at")'));
  h.elements.rain48h.checked=true;h.run('changeRainfallPeriod(48)');
  assert(!h.elements.rain24h.checked);assert.equal(h.run('activeAccumulationHours()'),48);
  h.elements.rain48h.checked=false;h.run('changeRainfallPeriod(48)');assert.equal(h.layers.size,0);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert(html.indexOf('id="rain1h"')>html.indexOf('id="radarSection"'));
  assert(html.indexOf('id="rain48h"')<html.indexOf('id="warningSection"'));
  assert.match(html,/script src="js\/rainfall\.js\?v=[\d.]+"/);
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
  const pending=race.run('loadRainfall()');await new Promise(setImmediate);race.elements.rain24h.checked=false;release();await pending;
  assert.equal(race.layers.size,0);
});

test('rate-limit cooldown prevents repeated requests on period switches',async()=>{
  const h=harness();h.elements.rain1h.checked=true;let calls=0;
  h.context.fetch=async()=>{calls++;return {ok:false,status:429};};
  await assert.rejects(h.run('loadRainfall()'),/busy/);
  await assert.rejects(h.run('loadRainfall()'),/cooling down/);
  assert.equal(calls,1);
});


test('official windows retain true timestamps, exclude missing hours and never cross countries',()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{PL:{name:'Test national source'},LT:{name:'Meteo.lt'}},
    stations:[0,1,2].map(i=>({country:'PL',code:String(i),name:'Gauge '+i,lat:52+i*.01,lon:19,
    times:Array.from({length:54},(_,j)=>rainWindowEnd()-(54-j)*3600),amounts:Array(54).fill(3),traces:[]}))};`);
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"PL").value'),72);
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"PL").end'),h.context.frameTime-3600,'lag reported explicitly');
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"LT")'),null,'no foreign gauges');
  assert.equal(h.run('officialRainAt(54,19,24,rainWindowEnd(),"PL")'),null,'beyond radius uses model');
  h.run('officialRainData.stations.forEach(s=>s.amounts[30]=null);officialRainWindows.clear();');
  assert.equal(h.run('officialRainAt(52,19,48,rainWindowEnd(),"PL")'),null,'gaps cannot become dry hours');
  const popup=h.run('rainfallPopupContent({lat:52,lng:19},rainWindowEnd())');
  assert(popup.includes('Test national source'));assert(popup.includes('Open-Meteo · model'));
  assert(popup.includes('Ending'));assert(popup.includes('snow water equivalent'));
  h.run('officialRainData.generatedAt=Date.now()/1000-4*3600;officialRainWindows.clear();');
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"PL")'),null,'stale snapshot falls back');
});

test('snapshot validation rejects null, negative, unsorted and mismatched gauge hours',()=>{
  const h=harness();
  h.run(`sample={version:1,generatedAt:Date.now()/1000,sources:{DK:{name:'DMI'}},stations:[{country:'DK',code:'1',lat:56,lon:10,times:[3600,7200],amounts:[0,2]}]};`);
  assert(h.run('validOfficialRainSnapshot(sample)'));
  h.run('sample.stations[0].amounts[0]=null;');assert(!h.run('validOfficialRainSnapshot(sample)'));
  h.run('sample.stations[0].amounts[0]=-0.1;');assert(!h.run('validOfficialRainSnapshot(sample)'));
  h.run('sample.stations[0].amounts[0]=0;sample.stations[0].times.reverse();');assert(!h.run('validOfficialRainSnapshot(sample)'));
});


test('model outage preserves official rendering and respects rate-limit cooldown',async()=>{
  const h=harness();h.elements.rain24h.checked=true;let calls=0;
  h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{},stations:[{country:'DK',times:[],amounts:[]}]};`);
  h.context.fetch=async()=>{calls++;return {ok:false,status:429};};
  await h.run('loadRainfall()');
  assert(h.run('rainModelError.includes("busy")'));
  assert.equal(h.run('rainData.version'),0,'missing model grid remains missing');
  await h.run('loadRainfall()');assert.equal(calls,1,'no rate-limit retry storm');
  h.elements.rain24h.checked=false;h.run('changeRainfallPeriod(24)');
});


test('stale snapshot cannot reuse a cached official heatmap',async()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  h.run(`officialRainData={generatedAt:Date.now()/1000-4*3600};rainImageCache.set('24|'+rainWindowEnd()+'|'+officialRainData.generatedAt,[{dataUrl:'stale'}]);`);
  const images=await h.run('createRainfallImages(24,rainWindowEnd(),rainRenderGeneration)');
  assert.equal(images.length,5);assert.notEqual(images[0].dataUrl,'stale');
});

function seedGauge(h,{lag=0,amount=2}={}){
 h.context.gaugeLag=lag;h.context.gaugeAmount=amount;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000-gaugeLag,sources:{EE:{name:'Estonian Environment Agency'}},
 stations:[{country:'EE',code:'1',name:'Test gauge',lat:59,lon:25,
 times:Array.from({length:72},(_,i)=>rainWindowEnd()-gaugeLag-(71-i)*3600),amounts:Array(72).fill(gaugeAmount)}]};`);
}

test('one real gauge produces mm numbers at wide zooms without a model grid or interpolation neighbours',()=>{
 const h=harness();h.elements.rain24h.checked=true;seedGauge(h,{amount:0});
 for(const zoom of [2,5,6]){
  h.context.map.getZoom=()=>zoom;h.run('renderOfficialRainLabels()');
  assert.equal(h.run('officialRainLabels.children.length'),1);
  assert.match(h.run('officialRainLabels.children[0].options.icon.html'),/>0\.0 mm</);
 }
 assert.equal(h.run('officialRainAt(59,25,24,rainWindowEnd(),"EE")'),null,'a single gauge is insufficient for the heatmap but remains measured');
 assert.match(h.elements.rainGaugeStatus.textContent,/1 in view/);
 h.elements.rain24h.checked=false;h.run('renderOfficialRainLabels()');assert.equal(h.run('officialRainLabels'),null);
});

test('delayed station numbers retain their actual window and never masquerade as a current heatmap',()=>{
 const h=harness();h.elements.rain24h.checked=true;seedGauge(h,{lag:4*3600});h.run('renderOfficialRainLabels()');
 assert.match(h.run('officialRainLabels.children[0].options.icon.html'),/48\.0 mm/);
 assert.match(h.run('officialRainLabels.children[0].options.icon.html'),/rain-station-delayed/);
 assert.match(h.elements.rainGaugeStatus.textContent,/delayed readings/);
 assert.equal(h.run('officialRainWindow("EE",24,rainWindowEnd())'),null);
 h.run('officialRainLabels.children[0].events.click()');
 const popup=h.run('rainPopup.content');assert.match(popup,/measured · delayed reading/);
 assert(popup.includes('Ending '+new Date((h.context.frameTime-4*3600)*1000).toISOString()));
 assert(popup.includes('48.0 <small>mm</small>'));
 seedGauge(h,{lag:25*3600});h.run('renderOfficialRainLabels()');assert.equal(h.run('officialRainLabels.children.length'),0,'measurements older than a day are not drawn');
});

test('station windows exclude future readings and require every hour of the selected period',()=>{
 const h=harness();seedGauge(h);h.run('officialRainData.stations[0].times.push(rainWindowEnd()+3600);officialRainData.stations[0].amounts.push(999);');
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd()).value'),48);
 h.run('officialRainData.stations[0].amounts.fill(null)');
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd())'),null);
});

test('station labels appear before model loading finishes and survive model errors',async()=>{
 const h=harness();h.elements.rain24h.checked=true;seedGauge(h);let release;
 h.context.waitTemperature=new Promise(resolve=>release=resolve);h.run('temperatureLoadPromise=waitTemperature');
 h.context.fetch=async()=>({ok:false,status:429});
 const loading=h.run('loadRainfall()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.run('officialRainLabels.children.length'),1,'labels already rendered while model loading is waiting');
 release();await loading;h.run("reportRainfallError(new Error('model offline'))");
 assert.equal(h.run('officialRainLabels.children.length'),1,'an unrelated model outage cannot erase measured numbers');
 h.elements.rain24h.checked=false;h.run('changeRainfallPeriod(24)');
});


test('Iceland published accumulations validate and display without inventing hourly history',()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{IS:{name:'Icelandic Meteorological Office (IMO)'}},
    stations:[{country:'IS',code:'1485',name:'Bláfjöll',lat:64,lon:-21,times:[rainWindowEnd()],amounts:[0.6],
      accumulations:[{end:rainWindowEnd(),hours:24,value:65.2},{end:rainWindowEnd(),hours:48,value:78}]}]};`);
  assert(h.run('validOfficialRainSnapshot(officialRainData)'));
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd()).value'),65.2);
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],48,rainWindowEnd()).value'),78);
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],1,rainWindowEnd()).value'),0.6);
  assert(h.run('Number.isNaN(rollingRainTotal(officialRainData.stations[0],rainWindowEnd(),24))'),'no manufactured hours');
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd()-3600)'),null,'no future total on earlier timeline');
  h.run('renderOfficialRainLabels()');
  const group=[...h.layers][0];assert.equal(group.children.length,1);
  assert.match(group.children[0].options.icon.html,/65.2 mm/);
  group.children[0].events.click();
  const popup=h.run('rainPopup.content').replace(/<[^>]*>/g,'');
  assert.match(popup,/65.2 mm/);assert.match(popup,/78.0 mm/);assert.match(popup,/0.6 mm/);
  assert.match(popup,/Icelandic Meteorological Office/);
  h.run('officialRainData.stations[0].accumulations[0].value=9999;');
  assert(!h.run('validOfficialRainSnapshot(officialRainData)'));
  h.run('officialRainData.stations[0].accumulations[0].value=65.2;officialRainData.stations[0].times=[];officialRainData.stations[0].amounts=[];');
  assert(h.run('validOfficialRainSnapshot(officialRainData)'),'24/48 totals can exist without 1h reading');
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd()).value'),65.2);
  assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],1,rainWindowEnd())'),null);
});
