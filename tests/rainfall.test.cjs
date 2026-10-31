const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.join(__dirname,'..');

function harness(europe=false){
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
  if(europe){run(fs.readFileSync(path.join(root,'js/temperature-us.js'),'utf8'));context.NorthernUSTemperature=context.window.NorthernUSTemperature;}
  // Small grids exercise the complete renderer and loader without costly fixture images.
  run(`TEMP_GRID_SPECS.splice(0,TEMP_GRID_SPECS.length,...TEMP_REGIONS.map(r=>makeStructuredGrid(r.id,r.bounds,
    r.bounds[1][0]-r.bounds[0][0],r.bounds[1][1]-r.bounds[0][1])));TEMP_REGIONS.forEach(r=>{r.w=8;r.h=6;});sleep=async()=>{};`);
  const features=run(`([...TEMP_REGIONS,...(globalThis.NorthernUSTemperature?[{id:'portugal-rain',bounds:[[36.8,-9.6],[42.2,-6]]}]:[]),...(globalThis.NorthernUSTemperature?.regions||[]).filter(r=>['british-isles','western-europe','central-europe'].includes(r.id))]).flatMap(r=>[...TEMP_REGION_COUNTRY_IDS[r.id]].map(id=>({id,
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

test('renderer masks European and Canadian regions, leaves dry pixels transparent and cancels obsolete renders',async()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  await h.run('renderRainfall()');
  assert.equal(h.layers.size,1);
  const group=[...h.layers][0];assert.equal(group.children.length,6);
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
  assert.match(html,/script src="js\/rainfall\.js\?v=[\w.-]+"/);
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


test('official cross-border windows retain true timestamps and exclude missing hours',()=>{
  const h=harness();h.seed();h.elements.rain24h.checked=true;
  h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{PL:{name:'Test national source'},LT:{name:'Meteo.lt'}},
    stations:[0,1,2].map(i=>({country:'PL',code:String(i),name:'Gauge '+i,lat:52+i*.01,lon:19,
    times:Array.from({length:54},(_,j)=>rainWindowEnd()-(54-j)*3600),amounts:Array(54).fill(3),traces:[]}))};`);
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"PL").value'),72);
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"PL").end'),h.context.frameTime-3600,'lag reported explicitly');
  assert.equal(h.run('officialRainAt(52,19,24,rainWindowEnd(),"LT").value'),72,'nearby foreign gauges inform shading');
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
  assert.equal(images.length,6);assert.notEqual(images[0].dataUrl,'stale');
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

test('Canadian station totals validate, render and retain missing hours without model substitution',()=>{
 const h=harness();h.elements.rain48h.checked=true;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{CA:{name:'ECCC / MSC'}},stations:[{
 country:'CA',code:'123',name:'Vancouver gauge',lat:49,lon:-123,
 times:Array.from({length:49},(_,i)=>rainWindowEnd()-(48-i)*3600),amounts:Array(49).fill(0.5),traces:[]}]};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],48,rainWindowEnd()).value'),24);
 h.run('renderOfficialRainLabels()');assert.equal(h.run('officialRainLabels.children.length'),1);
 const popup=h.run('rainfallPopupContent({lat:49,lng:-123,station:officialRainData.stations[0]},rainWindowEnd())');
 assert(popup.includes('ECCC / MSC'));assert(popup.includes('24.0'));
 h.run('officialRainData.stations[0].times.splice(10,1);officialRainData.stations[0].amounts.splice(10,1)');
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],48,rainWindowEnd())'),null);
});

test('Canadian heatmap uses official totals, stays transparent beyond gauges and ignores Canadian model data',async()=>{
 const h=harness();h.seed();h.elements.rain24h.checked=true;
 h.run(`const caRegion=TEMP_REGIONS.find(r=>r.id==='canada');
 const caLat=rasterLatitudeForRow(caRegion,3,caRegion.h),caLon=-142+3/7*90;
 officialRainData={version:1,generatedAt:Date.now()/1000,sources:{CA:{name:'ECCC'}},stations:[0,.1,.2].map((offset,i)=>({
 country:'CA',code:String(i),name:'Gauge '+i,lat:caLat,lon:caLon+offset,
 times:Array.from({length:49},(_,i)=>rainWindowEnd()-(48-i)*3600),amounts:Array(49).fill(.5)}))};
 rainCountryMask=region=>({ids:[...TEMP_REGION_COUNTRY_IDS[region.id]],pixels:new Uint8ClampedArray(region.w*region.h*4).fill(1)});
 rainData.grids.canada.forEach(s=>s.amounts.fill(999));`);
 await h.run('renderRainfall()');
 const image=h.canvases.find(c=>c.pixels&&c.pixels[(3*8+3)*4+3]>0&&c.pixels[3]===0);
 assert(image,'Canadian rain is shaded near its gauges with distant corners transparent');
 assert.equal(h.run('officialRainAt(caLat,caLon,24,rainWindowEnd(),"CA").value'),12);
 assert.equal(h.run('officialRainAt(42,-140,24,rainWindowEnd(),"CA")'),null);
 assert.equal(h.run('RAIN_GRID_SPECS.some(s=>s.id==="canada")'),false,'no additional visitor model requests');
 h.run('officialRainData.generatedAt-=4*3600;rainImageCache.clear()');h.canvases.length=0;
 await h.run('renderRainfall()');
 assert(!h.canvases.at(-1).pixels.some((v,i)=>i%4===3&&v>0),'stale Canadian observations never become model shading');
});
test('Canadian nearby-station index matches full interpolation at southern and Arctic latitudes',()=>{
 const h=harness();
 h.run(`crossBorderRainWindows=()=>[testWindow];`);
 for(const lat of [45,60,83]){
  h.context.testWindow={rows:Array.from({length:100},(_,i)=>({station:{lat:lat+(i%10-5)*.3,lon:-100+(Math.floor(i/10)-5)*1.5},value:i/10})),end:h.context.frameTime,source:'ECCC'};
  h.context.probeLat=lat;
  const indexed=h.run('officialRainAt(probeLat,-100,24,rainWindowEnd(),"CA")');
  const neighbours=h.context.testWindow.rows.map(r=>({...r,d2:((r.station.lat-lat)*111.2)**2+((r.station.lon+100)*111.2*Math.cos(lat*Math.PI/180))**2})).filter(r=>r.d2<=100**2).sort((a,b)=>a.d2-b.d2).slice(0,6);
  const nearest=neighbours[0],full=nearest.d2<=.01?nearest.value:neighbours.reduce((s,r)=>s+r.value*(1-r.d2/10000)**2/Math.max(.01,r.d2),0)/neighbours.reduce((s,r)=>s+(1-r.d2/10000)**2/Math.max(.01,r.d2),0);
  assert(Math.abs(indexed.value-full)<1e-12);assert.equal(indexed.count,neighbours.length);
 }
});


test('all nine European countries validate and country search isolates measured station labels',()=>{
 const h=harness(true);h.elements.rain24h.checked=true;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{},stations:[
 ['GB',55,-3],['IE',53,-8],['PL',52,19],['DE',50,10],['NL',52,5],['BE',50.5,4.5],['LU',49.62,6.22],['SK',47.75,18.5],['CZ',50,15]
 ].map(([country,lat,lon])=>({country,lat,lon,name:country,code:country,times:[],amounts:[],
 accumulations:[{end:rainWindowEnd()-3*3600,hours:24,value:2}]}))};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 h.context.NorthernCountryFocus={allowsStation:s=>s.country==='SK',matchesCountry:c=>c==='SK'};
 h.run('renderOfficialRainLabels()');
 assert.equal(h.run('officialRainLabels.children.length'),1);
 assert.match(h.run('officialRainSourceSummary(24,rainWindowEnd())'),/Slovakia .*1 gauges.*delayed readings/);
 assert.match(h.run('officialRainLabels.children[0].options.title'),/^SK .*delayed reading/);
 const popup=h.run('rainfallPopupContent({lat:47.75,lng:18.5,station:officialRainData.stations[7]},rainWindowEnd())');
 assert.match(popup,/2.0/);assert.match(popup,/Unavailable/);assert(!popup.includes('Open-Meteo · model'));
});

test('European gauge-only regions render without model grids and never fall back to model data',async()=>{
 const h=harness(true);h.seed();h.elements.rain24h.checked=true;
 h.run(`RAIN_REGIONS.forEach(r=>{r.w=8;r.h=6;});
 officialRainData={version:1,generatedAt:Date.now()/1000,sources:{DE:{name:'DWD'}},stations:[]};
 rainCountryMask=region=>({ids:[...TEMP_REGION_COUNTRY_IDS[region.id]],pixels:new Uint8ClampedArray(region.w*region.h*4).fill(1)});`);
 h.context.NorthernCountryFocus={current:()=>({id:'276'}),key:()=> 'DE'};
 await h.run('renderRainfall()');
 assert.equal(h.run('rainLayer.children.length'),1);
 assert(!h.canvases.at(-1).pixels.some((v,i)=>i%4===3&&v>0));
 assert(!h.run('RAIN_GRID_SPECS.some(s=>s.id==="western-europe")'));
 assert(h.run('RAIN_REGIONS.some(s=>s.id==="central-europe")'));
 assert(h.run('RAIN_REGIONS.some(s=>s.id==="british-isles")'));
});

test('France, Andorra and Spain validate southern gauges, expose all periods and preserve delayed window ends',()=>{
 const h=harness(true);h.elements.rain48h.checked=true;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{FR:{name:'Météo-France'},AD:{name:'Servei Meteorològic Nacional'},ES:{name:'AEMET'}},stations:[
 ['FR',43.6,1.4],['AD',42.5,1.5],['ES',40.4,-3.7],['ES',28.3,-16.5]
 ].map(([country,lat,lon],i)=>({country,lat,lon,code:String(i),name:country+' gauge',times:[rainWindowEnd()-3600],amounts:[0],accumulations:[{end:rainWindowEnd()-4*3600,hours:24,value:2},{end:rainWindowEnd()-4*3600,hours:48,value:5}]}))};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 for(const country of ['FR','AD','ES']){
  h.context.NorthernCountryFocus={allowsStation:s=>s.country===country,matchesCountry:c=>c===country};
  h.run('renderOfficialRainLabels()');assert(h.run('officialRainLabels.children.length')>0);
  const s=h.run(`officialRainData.stations.find(s=>s.country==='${country}')`);h.context.probe=s;
  const html=h.run('rainfallPopupContent({lat:probe.lat,lng:probe.lon,station:probe},rainWindowEnd())');
  assert.match(html,/0.0/);assert.match(html,/2.0/);assert.match(html,/5.0/);assert.match(html,/delayed reading/);assert(!html.includes('Open-Meteo · model'));
 }
 h.run('officialRainData.stations[0].lat=59');assert.equal(h.run('validOfficialRainSnapshot(officialRainData)'),false);
});

test('southwestern rain retains measured regions and allows border estimates into Portugal',()=>{
 const h=harness(true);
 assert.deepEqual(Array.from(h.run("RAIN_REGIONS.filter(r=>['france','andorra','spain-rain','spain-canaries'].includes(r.id)).map(r=>r.id)")),['france','andorra','spain-rain','spain-canaries']);
 assert.deepEqual(Array.from(h.run("[...TEMP_REGION_COUNTRY_IDS['spain-rain']]")),['724']);
 assert.equal(h.run("RAIN_COUNTRY_CODES['620']"),"PT");
 assert(h.run("['FR','AD','ES'].every(c=>OFFICIAL_ONLY_RAIN_COUNTRIES.has(c))"));
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{ES:{name:'AEMET'}},stations:[0,.1,.2].map((d,i)=>({country:'ES',code:String(i),name:'Spain',lat:40+d,lon:-3,times:[],amounts:[],accumulations:[{end:rainWindowEnd()-8*3600,hours:48,value:5}]}))};`);
 assert.equal(h.run("officialRainWindow('ES',48,rainWindowEnd()).end"),h.context.frameTime-8*3600);
 assert.equal(h.run("officialRainWindow('ES',1,rainWindowEnd())"),null,'daily sums never produce an hourly map');
 h.run('officialRainData.stations.forEach(s=>s.accumulations[0].end=rainWindowEnd()-25*3600);officialRainWindows.clear()');
 assert.equal(h.run("officialRainWindow('ES',48,rainWindowEnd())"),null,'older totals cannot masquerade as recent shading');
});

test('Swiss and Austrian gauges support complete 1/24/48 hour windows with national filtering',()=>{
 const h=harness(true);
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{CH:{name:'Source: MeteoSwiss'},AT:{name:'GeoSphere Austria'}},stations:[['CH',46.2,6.1],['AT',46.6,14.3]].map(([country,lat,lon])=>({country,lat,lon,code:country,name:country,times:Array.from({length:49},(_,i)=>rainWindowEnd()-(48-i)*3600),amounts:Array(49).fill(1)}))};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 for(const country of ['AT','CH']){
  h.context.NorthernCountryFocus={allowsStation:s=>s.country===country,matchesCountry:c=>c===country};
  for(const hours of [1,24,48]){
   for(const n of [1,24,48])h.elements['rain'+n+'h'].checked=n===hours;
   h.run('renderOfficialRainLabels()');assert.equal(h.run('officialRainLabels.children.length'),1);
   assert(h.run('officialRainLabels.children[0].options.title').startsWith(country+' · '+hours+' h: '+hours+'.0 mm'));
  }
 }
 assert(h.run("RAIN_REGIONS.some(r=>r.id==='austria')&&RAIN_REGIONS.some(r=>r.id==='switzerland')"));
 assert(h.run("OFFICIAL_ONLY_RAIN_COUNTRIES.has('AT')&&OFFICIAL_ONLY_RAIN_COUNTRIES.has('CH')"));
 h.run('officialRainData.stations[0].lat=59');assert.equal(h.run('validOfficialRainSnapshot(officialRainData)'),false);
});

test('French hourly status explains the native three-hour report cadence without relabelling old measurements',()=>{
 const h=harness(true);h.context.NorthernCountryFocus={matchesCountry:c=>c==='FR'};
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{FR:{name:'Météo-France',period:'Official SYNOP precipitation'}},stations:[]};`);
 assert.match(h.run('officialRainSourceSummary(1,rainWindowEnd())'),/public SYNOP feed reports every three hours/);
 assert(!h.run('officialRainSourceSummary(24,rainWindowEnd())').includes('France 1 h:'));
});

test('rain crosses borders and country focus without mixing different ending hours',()=>{
 const h=harness();h.seed();const end=h.context.frameTime;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{FR:{name:'Meteo-France'},CH:{name:'MeteoSwiss'}},stations:
 [['FR',6.0,10],['CH',6.2,20]].flatMap(([country,lon,value])=>[0,.01,.02].map((d,i)=>({country,code:country+i,name:country,lat:46+d,lon,times:[],amounts:[],accumulations:[{end:rainWindowEnd(),hours:24,value}]})))};officialRainWindows.clear();`);
 h.context.NorthernCountryFocus={allowsStation:s=>s.country==='FR',matchesCountry:c=>c==='FR'};
 const value=h.run('officialRainAt(46.01,6.1,24,rainWindowEnd(),"FR")');assert(value.value>10&&value.value<20);assert.equal(value.countries.length,2);assert.equal(value.end,end);
 h.run('officialRainData.stations.filter(s=>s.country==="CH").forEach(s=>s.accumulations[0].end-=3600);officialRainWindows.clear()');
 const separate=h.run('officialRainAt(46.01,6.1,24,rainWindowEnd(),"FR")');assert(Math.abs(separate.value-10)<1e-10);assert.equal(separate.end,end);assert.equal(separate.countries.length,1);
});

test('rainfall mountain barriers suppress foreign influence while exact station popup readings remain original',()=>{
 const h=harness();h.seed();h.context.NorthernTerrain={influence:()=>()=>.001};
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{FR:{name:'Meteo-France'}},stations:[0,.01,.02].map((d,i)=>({country:'FR',code:'F'+i,name:'French gauge',lat:46+d,lon:6,times:[],amounts:[],accumulations:[{end:rainWindowEnd(),hours:24,value:25}]}))};officialRainWindows.clear()`);
 assert.equal(h.run('officialRainAt(46.01,6.3,24,rainWindowEnd(),"CH")'),null);
 assert.equal(h.run('officialGaugeRainTotal(officialRainData.stations[0],rainWindowEnd(),24)'),25);
});

test('official UK 24/48-hour heatmaps accept complete delayed SYNOP intervals and disclose their real end',()=>{
 const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/uk-rain-delayed.json'),'utf8'));
 const h=harness(true);h.seed();h.context.frameTime=fixture.referenceTime;h.context.uk=fixture.stations;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{GB:{name:'Met Office SYNOP via DWD'}},stations:uk};officialRainWindows.clear()`);
 for(const hours of [24,48]){
  const w=h.run(`officialRainWindow('GB',${hours},rainWindowEnd())`);assert(w);assert(w.end<h.context.frameTime-7200);
  const gauge=fixture.stations[0],expected=gauge.accumulations.find(a=>a.hours===hours);
  const field=h.run(`officialRainAt(${gauge.lat},${gauge.lon},${hours},rainWindowEnd(),'GB')`);
  assert(field);assert.equal(field.end,expected.end);assert.equal(field.value,expected.value);assert(field.delayed);
 }
 h.run('officialRainData.stations.forEach(s=>s.accumulations.forEach(a=>a.end=rainWindowEnd()-25*3600));officialRainWindows.clear()');
 assert.equal(h.run("officialRainWindow('GB',24,rainWindowEnd())"),null);
});

test('UK rain skips offscreen regions and Nordic model requests, and viewport changes invalidate the image cache',async()=>{
 const h=harness(true);h.seed();h.context.map.getBounds=()=>({getSouth:()=>50,getNorth:()=>59,getWest:()=>-8,getEast:()=>1});
 h.context.NorthernCountryFocus={key:()=> 'GB',current:()=>({id:'826'}),matchesCountry:c=>c==='826'||c==='GB',allowsStation:s=>s.country==='GB'};
 assert.deepEqual(Array.from(h.run('visibleRainfallRegions().map(r=>r.id)')),['british-isles']);
 assert.equal(h.run('visibleRainfallNeedsModel()'),false);
 let requests=0;h.context.fetch=async()=>{requests++;throw new Error('No Nordic model request expected for UK')};
 h.elements.rain24h.checked=true;await h.run('loadRainfall(false)');assert.equal(requests,0);
 h.context.NorthernCountryFocus=null;h.context.map.getBounds=()=>({getSouth:()=>40,getNorth:()=>50,getWest:()=>-120,getEast:()=>-80});
 assert(!h.run("visibleRainfallRegions().some(r=>r.id==='british-isles')"));
});

test('Italy, Croatia and Slovenia validate official gauges and preserve complete 1/24/48-hour windows',()=>{
 const h=harness(true);
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{IT:{name:'Italian SYNOP'},HR:{name:'DHMZ'},SI:{name:'ARSO'}},stations:[['IT',38.1,13.3],['HR',45.8,16],['SI',46.06,14.5]].flatMap(([country,lat,lon])=>[0,.01,.02].map((d,i)=>({country,lat:lat+d,lon,code:country+i,name:country,times:Array.from({length:49},(_,i)=>rainWindowEnd()-(48-i)*3600),amounts:Array(49).fill(1)})))};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 for(const country of ['IT','HR','SI']){
  h.context.focus=country;
  h.context.NorthernCountryFocus={current:()=>({id:{IT:'380',HR:'191',SI:'705'}[country]}),matchesCountry:c=>c===country,key:()=>country};
  for(const hours of [1,24,48])assert.equal(h.run(`officialRainWindow(focus,${hours},rainWindowEnd()).rows[0].value`),hours);
  assert(h.run('officialRainSourceSummary(24,rainWindowEnd())').includes({IT:'Italy',HR:'Croatia',SI:'Slovenia'}[country]));
  assert(h.run('visibleRainfallRegions()').some(r=>r.id===(country==='IT'?'italy':'adriatic')));
 }
 assert(h.run("['IT','HR','SI'].every(c=>OFFICIAL_ONLY_RAIN_COUNTRIES.has(c))"));
 h.run('officialRainData.stations[0].lat=59');assert(!h.run('validOfficialRainSnapshot(officialRainData)'));
});

test('Croatian daily reports never become hourly values and their actual delayed end remains visible',()=>{
 const h=harness(true);
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{HR:{name:'DHMZ'}},stations:[0,.01,.02].map((d,i)=>({country:'HR',lat:45.8+d,lon:16,code:'HR'+i,name:'Gauge',times:[],amounts:[],accumulations:[{end:rainWindowEnd()-8*3600,hours:24,value:3}]}))};`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 assert.equal(h.run("officialRainWindow('HR',1,rainWindowEnd())"),null);
 assert.equal(h.run("officialRainWindow('HR',48,rainWindowEnd())"),null);
 assert.equal(h.run("officialRainWindow('HR',24,rainWindowEnd()).end"),h.run('rainWindowEnd()-8*3600'));
});

test('Turkey native-minute rolling totals and daily 48 hours validate without manufacturing hourly history',()=>{
 const h=harness(true);h.seed();h.elements.timeline={value:'1',max:'1'};h.context.minuteEnd=Math.floor(Date.now()/60000)*60;
 h.run(`officialRainData={version:1,generatedAt:Date.now()/1000,sources:{TR:{name:'MGM'}},stations:[0,.01,.02].map((d,i)=>({country:'TR',code:'MGM-'+i,name:'Turkish gauge',lat:40+d,lon:33,times:[],amounts:[],accumulations:[{end:rainWindowEnd()-12*3600,hours:24,value:2},{end:rainWindowEnd()-12*3600,hours:48,value:5},{end:minuteEnd,hours:1,value:0},{end:minuteEnd,hours:24,value:7}]}))};officialRainWindows.clear();`);
 assert(h.run('validOfficialRainSnapshot(officialRainData)'));
 assert(h.run('RAIN_REGIONS.some(r=>r.id==="turkey")'));
 assert(h.run('OFFICIAL_ONLY_RAIN_COUNTRIES.has("TR")'));
 assert.equal(h.run('officialRainWindow("TR",1,rainWindowEnd()).end'),h.context.minuteEnd);
 assert.equal(h.run('officialRainWindow("TR",1,rainWindowEnd()).rows[0].value'),0);
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],24,rainWindowEnd()).value'),7);
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],48,rainWindowEnd()).value'),5);
 assert(h.run('Number.isNaN(rollingRainTotal(officialRainData.stations[0],rainWindowEnd(),24))'));
 h.elements.timeline.value='0';
 assert.equal(h.run('officialStationRainWindow(officialRainData.stations[0],1,rainWindowEnd()-3600)'),null);
 h.run('officialRainData.stations[0].accumulations[0].end=Date.now()/1000+500');assert(!h.run('validOfficialRainSnapshot(officialRainData)'));
});
test('Turkish daily gauges supplement rolling coverage without mixing different ending times',()=>{
 const h=harness(true);h.seed();h.elements.timeline={value:'1',max:'1'};h.context.minuteEnd=Math.floor(Date.now()/60000)*60;
 h.run(`const dailyEnd=Math.floor(rainWindowEnd()/86400)*86400+21600-(rainWindowEnd()%86400<21600?86400:0);officialRainData={version:1,generatedAt:Date.now()/1000,sources:{TR:{name:'MGM'}},stations:[0,.01,.02].flatMap((d,i)=>[{country:'TR',code:'roll'+i,name:'Rolling',lat:40+d,lon:33,times:[],amounts:[],accumulations:[{end:minuteEnd,hours:24,value:4}]},{country:'TR',code:'day'+i,name:'Daily',lat:39+d,lon:30,times:[],amounts:[],accumulations:[{end:dailyEnd,hours:24,value:20}]}])};officialRainWindows.clear();`);
 const windows=h.run('crossBorderRainWindows(24,rainWindowEnd()).filter(w=>w.rows.some(r=>r.station.country==="TR"))');assert.equal(windows.length,2);
 assert(windows.every(w=>w.rows.every(r=>r.value===(w.end===h.context.minuteEnd?4:20))));
});
test('rain refresh uses shared time keys and a separate manual refresh key',async()=>{
 const h=harness();let urls=[];h.context.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>({version:1,generatedAt:Date.now()/1000,sources:{},stations:[]})};};
 await h.run('loadOfficialRainfall(true)');assert.match(urls[0],/^data\/official-rainfall\.json\?v=refresh-\d+$/);
 h.run('officialRainLoadedAt=0');await h.run('loadOfficialRainfall()');assert.match(urls[1],/\?v=\d+$/);
});
test('Ukraine Romania and Hungary validate measured rain, preserve zeros and reject foreign coordinates',()=>{
 const h=harness(),end=h.context.frameTime;
 for(const [country,lat,lon] of [['UA',50.4,30.5],['RO',44.4,26.1],['HU',47.5,19.1]]){
  h.context.eastern={version:1,generatedAt:end,sources:{[country]:{name:'Official '+country}},stations:[{country,code:'test',name:'Gauge',lat,lon,times:[end],amounts:[0],accumulations:[{end,hours:24,value:3},{end,hours:48,value:5}]}]};
  assert.equal(h.run('validOfficialRainSnapshot(eastern)'),true);h.run('officialRainData=eastern;officialRainWindows.clear()');
  assert.equal(h.run('officialStationRainWindow(eastern.stations[0],1,eastern.generatedAt).value'),0);
  assert.equal(h.run('officialStationRainWindow(eastern.stations[0],48,eastern.generatedAt).value'),5);
  h.context.eastern.stations[0].lat=59;assert.equal(h.run('validOfficialRainSnapshot(eastern)'),false);
 }
});
test('six-hourly Ukrainian and Romanian totals retain delayed native ends, never invented hourly totals',()=>{
 const h=harness(),end=h.context.frameTime;
 for(const country of ['UA','RO']){
  h.context.eastern={version:1,generatedAt:end,sources:{[country]:{name:'Official '+country}},stations:Array.from({length:3},(_,i)=>({country,code:String(i),name:'Gauge',lat:country==='UA'?50:46,lon:country==='UA'?30:25,times:[],amounts:[],accumulations:[{end:end-6*3600,hours:24,value:3}]}))};
  h.run('officialRainData=eastern;officialRainWindows.clear()');h.context.easternCountry=country;
  assert.equal(h.run('officialRainWindow(easternCountry,24,eastern.generatedAt).end'),end-6*3600);
  assert.equal(h.run('officialRainWindow(easternCountry,1,eastern.generatedAt)'),null);
 }
});
test('Serbia Bulgaria and Croatia accept official totals, preserve missing hours and keep their delayed daily ends',()=>{
 const h=harness(),end=h.context.frameTime;
 for(const [country,lat,lon] of [['RS',44.12,21.95],['BG',43.98,22.85],['HR',45.73,16.06]]){
  h.context.balkan={version:1,generatedAt:end,sources:{[country]:{name:'Official '+country}},stations:Array.from({length:3},(_,i)=>({country,code:String(i),name:'Gauge',lat,lon,times:[],amounts:[],accumulations:[{end:end-9*3600,hours:24,value:6.4},{end:end-9*3600,hours:48,value:8.4}]}))};
  assert.equal(h.run('validOfficialRainSnapshot(balkan)'),true);h.run('officialRainData=balkan;officialRainWindows.clear()');h.context.balkanCountry=country;
  assert.equal(h.run('officialRainWindow(balkanCountry,24,balkan.generatedAt).end'),end-9*3600);
  assert.equal(h.run('officialStationRainWindow(balkan.stations[0],48,balkan.generatedAt).value'),8.4);
  assert.equal(h.run('officialRainWindow(balkanCountry,1,balkan.generatedAt)'),null);
  h.context.balkan.stations[0].lat=59;assert.equal(h.run('validOfficialRainSnapshot(balkan)'),false);
 }
});
