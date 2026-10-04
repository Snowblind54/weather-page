const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

function harness(details=false,ensemble=false){
  const elements={},layers=new Set(),panes=new Map(),timers=new Map();let tick=1;
  for(const id of ['cycloneOn','cycloneHistoryOn','cyclonePathsOn','cycloneForecastHour','cycloneTimeLabel','cycloneStatus','cycloneSection','cycloneNow','cycloneCoverage','cyclonePlay','cycloneIsobarsOn','cycloneIsobarOpacity','cycloneIsobarStatus','cycloneList','cycloneListSummary','cycloneNamesStatus','cycloneSpreadOn','cyclonePossibleOn','cycloneEnsembleStatus'])
    elements[id]={checked:false,value:'0',textContent:'',listeners:{},addEventListener(n,f){this.listeners[n]=f;},children:[],replaceChildren(){this.children=[];},appendChild(c){this.children.push(c);},getBoundingClientRect(){return {left:1000,right:1400,top:0,bottom:900};}};
  const map={createPane:n=>panes.set(n,{style:{}}),getPane:n=>panes.get(n),hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),
    fitBounds(){this.moves++;},setView(p,z){this.moves++;this.view=p;this.zoom=z;},getZoom(){return this.zoom;},zoom:4,on(){},getSize:()=>({x:1000,y:800}),getContainer:()=>({getBoundingClientRect:()=>({left:0,top:0})}),latLngToContainerPoint:ll=>({x:(ll[1]+85)*7,y:(82-ll[0])*8+100}),moves:0};
  function layer(extra={}){return {...extra,addTo(target){if(target===map)layers.add(this);else target.addLayer(this);return this;}};}
  let clock=Date.now();
  class ClockDate extends Date {static now(){return clock;}}
  const now=Math.floor(clock/3600000)*3600;
  const data={version:1,generatedAt:now,modelRun:now-3600,forecastEnd:now+96*3600,status:'ok',systems:[
    {id:'GFS-example',name:null,points:Array.from({length:33},(_,i)=>({time:now-3600+i*3*3600,lat:55,lon:-40+i*.5,pressure:985-i*.2,nearbyWind:20,nearbyGust:32+i*.2}))}
  ]};
  const context={console,Date:ClockDate,Math,JSON,Number,Map,Set,AbortController,setTimeout,clearTimeout,
    setInterval(f,delay){if(delay<1000){timers.set(tick,f);return tick++;}return 0;},clearInterval:n=>timers.delete(n),
    map,$:id=>elements[id],setWeatherSectionState(){},fmt:t=>new Date(t*1000).toISOString(),htmlEscape:s=>String(s).replaceAll('<','&lt;'),
    document:{hidden:false,addEventListener(){},createElement(){return {type:'',innerHTML:'',listeners:{},setAttribute(){},addEventListener(k,f){this.listeners[k]=f;}};}},URL,fetch:async()=>({ok:true,json:async()=>JSON.parse(JSON.stringify(data))}),
    L:{divIcon:o=>o,marker:(point,options)=>layer({point,options,on(n,f){this[n]=f;return this;},setLatLng(p){this.point=p;return this;},setIcon(v){this.options.icon=v;},getElement:()=>null}),
      layerGroup:(children=[])=>layer({children,eachLayer(fn){this.children.forEach(fn);},addLayer(l){this.children.push(l);},removeLayer(l){this.children=this.children.filter(x=>x!==l);}}),
      polyline:(points,options)=>layer({points,options,setStyle(style){Object.assign(this.options,style);}}),circleMarker:(point,options)=>layer({point,options}),
      circle:(point,options)=>layer({point,options}),polygon:(points,options)=>layer({points,options}),
      popup:options=>layer({options,setLatLng(p){this.point=p;return this;},setContent(s){this.content=s;return this;},openOn(){layers.add(this);return this;}})}
  };
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/cyclones.js'),'utf8'));
  if(details){elements.cycloneIsobarsOn.checked=true;elements.cycloneIsobarOpacity.value='35';run(fs.readFileSync(path.join(__dirname,'../js/cyclone-details.js'),'utf8'));}
  if(ensemble)run(fs.readFileSync(path.join(__dirname,'../js/cyclone-ensemble.js'),'utf8'));
  context.fixture=data;
  const seed=()=>{elements.cycloneOn.checked=true;run('cycloneData=validateCyclones(fixture);renderCyclones();');};
  return {context,run,elements,layers,timers,map,data,seed,setClock(t){clock=t;}};
}

test('movement units, interpolation, coverage and absent observations',()=>{
  const h=harness();h.seed();
  const a=h.run('cyclonePointAt(fixture.systems[0],fixture.systems[0].points[0].time+5400)');
  assert.equal(a.lon,-39.75);assert.equal(a.nearbyGust,32.1);assert.ok(a.speed>10&&a.speed<11);assert.ok(a.bearing>89&&a.bearing<91);
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.modelRun-1)'),null);
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.forecastEnd+1)'),null);
  h.run('fixture.systems[0].points[1].time=fixture.modelRun+9*3600;');
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.modelRun+3600)'),null);
  assert.equal(h.run('cycloneVisiblePosition({lat:40,lon:25,pressure:985})'),false);
  assert.equal(h.run('cycloneVisiblePosition({lat:55,lon:25,pressure:985})'),true);
});

test('paths are separate, centre popup and forecasts preserve the viewport',()=>{
  const h=harness();h.seed();assert.equal(h.run('cycloneMarkers.size'),1);assert.equal(h.run('cyclonePathGroup'),null);
  h.elements.cyclonePathsOn.checked=true;h.elements.cyclonePathsOn.listeners.change();
  assert.ok(h.run('cyclonePathGroup.children.some(l=>l.points?.length>1)'));
  const before=h.run('cycloneMarkers.values().next().value.point[1]');
  const projected=h.run('JSON.stringify(cyclonePathGroup.children)');
  h.run('openCyclonePopup(fixture.systems[0])');
  assert.equal(h.run('cyclonePopup.options.autoPan'),false);assert.equal(h.run('cyclonePopup.options.keepInView'),false);
  assert.match(h.run('cyclonePopup.content'),/Moving speed/);assert.match(h.run('cyclonePopup.content'),/no official name/);
  assert.match(h.run('cyclonePopup.content'),/m\/s/);assert.match(h.run('cyclonePopup.content'),/excludes gusts/);assert.match(h.run('cyclonePopup.content'),/Highest model gust/);assert.match(h.run('cyclonePopup.content'),/32.1 m\/s/);
  h.elements.cycloneForecastHour.value='24';h.elements.cycloneForecastHour.listeners.input();
  assert.ok(h.run('cycloneMarkers.values().next().value.point[1]')>before);
  assert.equal(h.run('JSON.stringify(cyclonePathGroup.children)'),projected,'forecast geometry and labels stay fixed while centre moves');
  assert.equal(h.map.moves,0);
  h.elements.cycloneCoverage.listeners.click();assert.equal(h.map.moves,1);
  h.elements.cyclonePlay.listeners.click();assert.equal(h.timers.size,1);
  h.elements.cycloneOn.checked=false;h.elements.cycloneOn.listeners.change();
  assert.equal(h.run('cycloneMarkers.size'),0);assert.equal(h.layers.size,0);assert.equal(h.timers.size,0);
});

test('stale model cannot leave centres, paths or playback on the map',()=>{
  const h=harness();h.seed();h.elements.cyclonePathsOn.checked=true;h.elements.cyclonePlay.listeners.click();
  h.run('cycloneData.modelRun=Math.floor(Date.now()/1000)-19*3600;renderCyclones();');
  assert.equal(h.layers.size,0);assert.equal(h.timers.size,0);assert.match(h.elements.cycloneStatus.textContent,/too old/);
});

test('projected paths and playback reach 72 hours',()=>{
  const h=harness();h.elements.cyclonePathsOn.checked=true;h.seed();
  assert.ok(h.run('cyclonePathGroup.children.some(l=>l.options?.icon?.html=== "+72 h")'));
  h.elements.cycloneForecastHour.value='71';h.elements.cyclonePlay.listeners.click();
  const advance=[...h.timers.values()][0];advance();
  assert.equal(Number(h.elements.cycloneForecastHour.value),72);advance();
  assert.equal(Number(h.elements.cycloneForecastHour.value),0);
  assert.match(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/id="cycloneForecastHour"[^>]*max="72"/);
});

test('loading is shared and off during fetch cannot resurrect markers',async()=>{
  const h=harness();let finish,calls=0;
  h.context.fetch=()=>{calls++;return new Promise(resolve=>finish=resolve);};h.elements.cycloneOn.checked=true;
  const a=h.run('loadCyclones()'),b=h.run('loadCyclones()');assert.equal(calls,1);
  h.elements.cycloneOn.checked=false;h.elements.cycloneOn.listeners.change();
  finish({ok:true,json:async()=>h.data});await Promise.all([a,b]);
  assert.equal(h.layers.size,0);assert.equal(h.run('cycloneMarkers.size'),0);
  h.elements.cycloneOn.checked=true;await h.run('loadCyclones()');assert.equal(calls,1);assert.equal(h.run('cycloneMarkers.size'),1);
});

test('failed refresh discloses prior forecast and corrupt snapshots are rejected',async()=>{
  const h=harness();h.seed();h.context.fetch=async()=>{throw new Error('offline');};
  await h.run('loadCyclones(true)');assert.equal(h.run('cycloneMarkers.size'),1);assert.match(h.elements.cycloneStatus.textContent,/refresh failed/);
  h.run('fixture.systems.push(fixture.systems[0]);');assert.throws(()=>h.run('validateCyclones(fixture)'),/Invalid cyclone track/);
});

test('past trails remain distinct from forecasts, exclude future points and split missing history',()=>{
  const h=harness(),now=h.data.generatedAt;
  h.data.systems[0].history=[47,44,24,21,18,15,12,9,6,3].map(age=>({time:now-age*3600,lat:55,lon:-42+age*.01,pressure:985}));
  h.elements.cycloneHistoryOn.checked=true;h.seed();
  assert.equal(h.run('cyclonePathGroup'),null);assert.equal(h.run('cycloneHistoryGroup.children.length'),2,'long gaps are not bridged');
  const past=h.run('JSON.stringify(cycloneHistoryGroup.children.map(l=>l.points))');
  assert(h.run('cycloneHistoryGroup.children.every(l=>!l.options.dashArray)'));
  h.elements.cycloneForecastHour.value='24';h.elements.cyclonePathsOn.checked=true;h.run('renderCyclones()');
  assert.equal(past,h.run('JSON.stringify(cycloneHistoryGroup.children.map(l=>l.points))'),'history stays anchored to now');
  assert(h.run('cyclonePathGroup.children.some(l=>l.options?.dashArray)'));
  h.elements.cycloneHistoryOn.checked=false;h.elements.cycloneHistoryOn.listeners.change();
  assert.equal(h.run('cycloneHistoryGroup'),null);assert.notEqual(h.run('cyclonePathGroup'),null);
  h.data.systems[0].history.push({time:now+1,lat:55,lon:-40,pressure:985});
  assert.throws(()=>h.run('validateCyclones(fixture)'),/Invalid cyclone history point/);
});


test('1000 hPa boundary hides weak centres, trails, forecast labels and list entries',()=>{
  const h=harness(true);h.data.systems[0].points.forEach(p=>p.pressure=1000.1);
  h.elements.cyclonePathsOn.checked=true;h.elements.cycloneHistoryOn.checked=true;h.seed();
  assert.equal(h.run('cycloneMarkers.size'),0);assert.equal(h.elements.cycloneList.children.length,0);
  assert.equal(h.run('cyclonePathGroup.children.length'),0);assert.equal(h.run('cycloneHistoryGroup.children.length'),0);
  h.data.systems[0].points.forEach(p=>p.pressure=1000);h.run('renderCyclones()');
  assert.equal(h.run('cycloneMarkers.size'),1);assert.equal(h.elements.cycloneList.children.length,1);
  h.elements.cycloneList.children[0].listeners.click();assert.equal(h.map.moves,1);assert.ok(h.run('cyclonePopup.content').includes('1000.0 hPa'));
});
test('pressure trend uses elapsed history without bridging missing time intervals',()=>{
  const h=harness(true),now=h.data.generatedAt;
  h.data.systems[0].history=[{time:now-7*3600,pressure:990,lat:55,lon:-40},{time:now-4*3600,pressure:987,lat:55,lon:-40}];h.seed();
  h.context.trendPoint={time:now,pressure:984};
  assert.equal(h.run('cycloneTrend(fixture.systems[0],trendPoint).kind'),'deepening');
  assert.equal(h.run('cycloneTrend(fixture.systems[0],trendPoint).change'),-5);
  h.context.trendPoint.pressure=991;assert.equal(h.run('cycloneTrend(fixture.systems[0],trendPoint).kind'),'filling');
  h.data.systems[0].history=[{time:now-15*3600,pressure:999}];
  assert.equal(h.run('cycloneTrend(fixture.systems[0],trendPoint).change'),null);
});
test('isobars retain 1 hPa spacing at every zoom with bounded labels and disappear when disabled',()=>{
  const h=harness(true),run=h.data.modelRun;
  h.data.pressureContours={version:1,interval:1,modelRun:run,frames:[{time:run,lines:Array.from({length:12},(_,i)=>({pressure:960+i,points:[[-75+i*8,55],[-70+i*8,56],[-65+i*8,57]]}))}]};
  h.seed();assert.equal(h.run('cycloneIsobarGroup.children.length'),12);assert.ok(h.run('cycloneIsobarLabels.children.length')<=8);
  assert.match(h.elements.cycloneIsobarStatus.textContent,/1 hPa spacing/);
  h.map.zoom=5;h.run('renderCycloneIsobars()');assert.equal(h.run('cycloneIsobarGroup.children.length'),12);
  const group=h.run('cycloneIsobarGroup');h.elements.cycloneIsobarOpacity.value='20';h.run('renderCycloneIsobars()');assert.equal(h.run('cycloneIsobarGroup'),group);assert.equal(group.children[0].options.opacity,.2);
  h.elements.cycloneOn.checked=false;h.elements.cycloneOn.listeners.change();assert.equal(h.run('cycloneIsobarGroup'),null);assert.equal(h.elements.cycloneList.children.length,0);
  h.data.pressureContours.modelRun++;assert.throws(()=>h.run('validateCyclones(fixture)'),/contour archive/);
});
test('European official name provenance is escaped and linked only to official hosts',()=>{
  const h=harness(true);h.data.systems[0].name='<Austen>';
  h.data.systems[0].europeanName={issuer:'Met Office',url:'https://weather.metoffice.gov.uk/warnings-and-advice/uk-storm-centre'};h.seed();
  h.run('openCyclonePopup(fixture.systems[0])');const content=h.run('cyclonePopup.content');
  assert.match(content,/&lt;Austen>/);assert.match(content,/association is inferred/);assert.match(content,/Official source/);
  assert.equal(h.run('cycloneSafeNameUrl("https://weather.metoffice.gov.uk.evil.example/x")'),null);
});

test('hourly centres and contours stay synchronized, Now advances and playback uses one-hour steps',()=>{
  const h=harness(true),run=h.data.modelRun;
  h.data.forecastStepHours=1;
  h.data.systems[0].points=Array.from({length:97},(_,i)=>({time:run+i*3600,lat:55,lon:-40+i*.1,pressure:985,nearbyWind:20,nearbyGust:32}));
  h.data.pressureContours={version:1,interval:1,modelRun:run,frames:Array.from({length:97},(_,i)=>({time:run+i*3600,lines:[{pressure:985,points:[[-40+i*.1,55],[-39+i*.1,56]]}]}))};
  h.setClock((run+5400)*1000);h.seed();
  assert.equal(h.run('cycloneSelectedTime()'),run+3600);
  assert.match(h.elements.cycloneIsobarStatus.textContent,new RegExp(new Date((run+3600)*1000).toISOString()));
  assert.equal(h.run('cycloneMarkers.values().next().value.point[1]'),-39.9);
  h.setClock((run+7200)*1000);h.run('renderCyclones()');
  assert.equal(h.run('cycloneSelectedTime()'),run+7200);
  assert.equal(h.run('cycloneMarkers.values().next().value.point[1]'),-39.8);
  h.elements.cyclonePlay.listeners.click();[...h.timers.values()][0]();
  assert.equal(Number(h.elements.cycloneForecastHour.value),1);
  assert.equal(h.run('cycloneSelectedTime()'),run+10800);
  h.data.systems[0].points=h.data.systems[0].points.filter(p=>p.time!==run+10800);h.run('renderCyclones()');
  assert.equal(h.run('cycloneMarkers.size'),0,'missing detected centre is not interpolated into an hourly pressure frame');
  assert.match(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/id="cycloneForecastHour"[^>]*step="1"/);
});

function ensembleFixture(h){
  const run=h.data.modelRun;
  return {version:1,methodVersion:1,modelRun:run,generatedAt:h.data.generatedAt,forecastEnd:run+96*3600,stepHours:6,
    expectedMembers:31,availableMembers:31,spreadPercentile:80,status:'ok',systems:[{id:'GFS-example',
      members:Array.from({length:31},(_,i)=>({member:i?'p'+String(i).padStart(2,'0'):'c00',
        points:Array.from({length:17},(_,j)=>({time:run+j*6*3600,lat:55+i*.02,lon:-40+j,pressure:985}))})),
      frames:Array.from({length:17},(_,i)=>({time:run+i*6*3600,lat:55.3,lon:-40+i,radiusKM:30+i*5,support:31}))}]};
}

test('ensemble shading and optional member tracks never alter the GFS projected path',()=>{
  const h=harness(true,true);h.context.ensembleFixture=ensembleFixture(h);
  h.run('cycloneEnsembleData=validateCycloneEnsemble(ensembleFixture);cycloneEnsembleLoadedAt=Date.now();');
  h.elements.cyclonePathsOn.checked=true;h.elements.cycloneSpreadOn.checked=true;h.seed();
  const primary=h.run('JSON.stringify(cyclonePathGroup.children)');
  assert(h.run('cycloneEnsembleGroup.children.some(l=>l.options.radius>0)'));
  assert(h.run('cycloneEnsembleGroup.children.every(l=>l.options.interactive===false)'));
  assert.equal(h.run('cycloneEnsembleGroup.children.filter(l=>l.options.opacity===.25).length'),0);
  h.elements.cyclonePossibleOn.checked=true;h.elements.cyclonePossibleOn.listeners.change();
  assert.equal(h.run('cycloneEnsembleGroup.children.filter(l=>l.options.opacity===.25).length'),31);
  assert.equal(h.run('JSON.stringify(cyclonePathGroup.children)'),primary);
  assert.match(h.elements.cycloneEnsembleStatus.textContent,/not a probability cone/);
  h.elements.cycloneSpreadOn.checked=false;h.elements.cycloneSpreadOn.listeners.change();
  assert.equal(h.run('cycloneEnsembleGroup.children.length'),31);
  h.elements.cyclonePossibleOn.checked=false;h.elements.cyclonePossibleOn.listeners.change();
  assert.equal(h.run('cycloneEnsembleGroup'),null);assert.equal(h.run('JSON.stringify(cyclonePathGroup.children)'),primary);
});

test('ensemble validation rejects corrupt members and insufficient support without affecting centres',()=>{
  const h=harness(true,true);h.seed();const e=ensembleFixture(h);h.context.ensembleFixture=e;
  assert.equal(h.run('validateCycloneEnsemble(ensembleFixture).availableMembers'),31);
  e.systems[0].frames[0].support=9;
  assert.throws(()=>h.run('validateCycloneEnsemble(ensembleFixture)'),/Invalid ensemble spread/);
  e.systems[0].frames[0].support=31;e.systems[0].members[1].member='c00';
  assert.throws(()=>h.run('validateCycloneEnsemble(ensembleFixture)'),/Invalid ensemble member/);
  assert.equal(h.run('cycloneMarkers.size'),1);
});

test('ensemble loading is shared, rejects mixed runs, and cannot resurrect an off layer',async()=>{
  const h=harness(true,true);h.seed();h.elements.cycloneSpreadOn.checked=true;
  let finish,calls=0;h.context.fetch=()=>{calls++;return new Promise(resolve=>finish=resolve);};
  const pending=h.run('loadCycloneEnsemble()');h.run('loadCycloneEnsemble()');assert.equal(calls,1);
  h.elements.cycloneOn.checked=false;h.elements.cycloneOn.listeners.change();
  finish({ok:true,json:async()=>ensembleFixture(h)});await pending;assert.equal(h.run('cycloneEnsembleGroup'),null);
  h.elements.cycloneOn.checked=true;h.run('cycloneEnsembleData=null;cycloneEnsembleRetryAt=0;');
  const wrong=ensembleFixture(h);wrong.modelRun-=6*3600;wrong.forecastEnd-=6*3600;
  wrong.systems.forEach(s=>{s.frames.forEach(p=>p.time-=6*3600);s.members.forEach(m=>m.points.forEach(p=>p.time-=6*3600));});
  h.context.fetch=async()=>({ok:true,json:async()=>wrong});await h.run('loadCycloneEnsemble()');
  assert.equal(h.run('cycloneEnsembleData'),null);assert.match(h.elements.cycloneEnsembleStatus.textContent,/unavailable/);
  h.run('renderCyclones()');assert.equal(h.run('cycloneMarkers.size'),1);
});

test('ensemble interpolation and corridor segments do not bridge missing six-hour samples',()=>{
  const h=harness(false,true);h.context.points=[{time:0,lat:55,lon:-30,radiusKM:10,support:31},{time:12*3600,lat:56,lon:-20,radiusKM:40,support:31}];
  assert.equal(h.run('ensemblePointAt(points,6*3600,true)'),null);
  assert.equal(h.run('ensemblePointAt(points,0,true).radiusKM'),10);
});
