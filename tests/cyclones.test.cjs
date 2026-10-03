const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

function harness(){
  const elements={},layers=new Set(),panes=new Map(),timers=new Map();let tick=1;
  for(const id of ['cycloneOn','cyclonePathsOn','cycloneForecastHour','cycloneTimeLabel','cycloneStatus','cycloneSection','cycloneNow','cycloneCoverage','cyclonePlay'])
    elements[id]={checked:false,value:'0',textContent:'',listeners:{},addEventListener(n,f){this.listeners[n]=f;}};
  const map={createPane:n=>panes.set(n,{style:{}}),getPane:n=>panes.get(n),hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),
    fitBounds(){this.moves++;},moves:0};
  function layer(extra={}){return {...extra,addTo(target){if(target===map)layers.add(this);else target.addLayer(this);return this;}};}
  const now=Math.floor(Date.now()/1000);
  const data={version:1,generatedAt:now,modelRun:now-3600,forecastEnd:now+96*3600,status:'ok',systems:[
    {id:'GFS-example',name:null,points:Array.from({length:33},(_,i)=>({time:now-3600+i*3*3600,lat:55,lon:-40+i*.5,pressure:985-i*.2,nearbyWind:20}))}
  ]};
  const context={console,Date,Math,JSON,Number,Map,Set,AbortController,setTimeout,clearTimeout,
    setInterval(f,delay){if(delay<1000){timers.set(tick,f);return tick++;}return 0;},clearInterval:n=>timers.delete(n),
    map,$:id=>elements[id],setWeatherSectionState(){},fmt:t=>new Date(t*1000).toISOString(),htmlEscape:s=>String(s).replaceAll('<','&lt;'),
    document:{hidden:false,addEventListener(){}},fetch:async()=>({ok:true,json:async()=>JSON.parse(JSON.stringify(data))}),
    L:{divIcon:o=>o,marker:(point,options)=>layer({point,options,on(n,f){this[n]=f;return this;},setLatLng(p){this.point=p;return this;},setIcon(v){this.options.icon=v;},getElement:()=>null}),
      layerGroup:(children=[])=>layer({children,addLayer(l){this.children.push(l);},removeLayer(l){this.children=this.children.filter(x=>x!==l);}}),
      polyline:(points,options)=>layer({points,options}),circleMarker:(point,options)=>layer({point,options}),
      popup:options=>layer({options,setLatLng(p){this.point=p;return this;},setContent(s){this.content=s;return this;},openOn(){layers.add(this);return this;}})}
  };
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/cyclones.js'),'utf8'));
  context.fixture=data;
  const seed=()=>{elements.cycloneOn.checked=true;run('cycloneData=validateCyclones(fixture);renderCyclones();');};
  return {context,run,elements,layers,timers,map,data,seed};
}

test('movement units, interpolation, coverage and absent observations',()=>{
  const h=harness();h.seed();
  const a=h.run('cyclonePointAt(fixture.systems[0],fixture.systems[0].points[0].time+5400)');
  assert.equal(a.lon,-39.75);assert.ok(a.speed>10&&a.speed<11);assert.ok(a.bearing>89&&a.bearing<91);
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.modelRun-1)'),null);
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.forecastEnd+1)'),null);
  h.run('fixture.systems[0].points[1].time=fixture.modelRun+9*3600;');
  assert.equal(h.run('cyclonePointAt(fixture.systems[0],fixture.modelRun+3600)'),null);
  assert.equal(h.run('cycloneVisiblePosition({lat:40,lon:25})'),false);
  assert.equal(h.run('cycloneVisiblePosition({lat:55,lon:25})'),true);
});

test('paths are separate, centre popup and forecasts preserve the viewport',()=>{
  const h=harness();h.seed();assert.equal(h.run('cycloneMarkers.size'),1);assert.equal(h.run('cyclonePathGroup'),null);
  h.elements.cyclonePathsOn.checked=true;h.elements.cyclonePathsOn.listeners.change();
  assert.ok(h.run('cyclonePathGroup.children.some(l=>l.points?.length>1)'));
  const before=h.run('cycloneMarkers.values().next().value.point[1]');
  h.run('openCyclonePopup(fixture.systems[0])');
  assert.equal(h.run('cyclonePopup.options.autoPan'),false);assert.equal(h.run('cyclonePopup.options.keepInView'),false);
  assert.match(h.run('cyclonePopup.content'),/Moving speed/);assert.match(h.run('cyclonePopup.content'),/no official name/);
  assert.match(h.run('cyclonePopup.content'),/m\/s/);assert.match(h.run('cyclonePopup.content'),/excludes gusts/);
  h.elements.cycloneForecastHour.value='24';h.elements.cycloneForecastHour.listeners.input();
  assert.ok(h.run('cycloneMarkers.values().next().value.point[1]')>before);
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
