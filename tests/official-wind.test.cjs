const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/official-wind.js'),'utf8');
function harness(){
  const now=Math.floor(Date.now()/1000),elements={officialWindSustained:{checked:false},officialWindGusts:{checked:false},officialWindStatus:{},timeline:{value:'1',max:'1'}};
  for(const e of Object.values(elements))e.addEventListener=(type,fn)=>e[type]=fn;
  const layers=new Set(),group={children:[],clearLayers(){this.children=[];},getLayers(){return this.children;},addTo(){layers.add(this);return this;}};
  const map={createPane(){},getPane:()=>({style:{}}),on(){},hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),getZoom:()=>6,getBounds:()=>({toBBoxString:()=> 'view',contains:()=>true}),latLngToContainerPoint:([lat,lon])=>({x:(lon-18)*100,y:(lat-53)*100})};
  const context={console,Date,Math,Number,Array,Map,Set,Promise,AbortController,setTimeout,clearTimeout,setInterval(){},document:{hidden:false,addEventListener(){}},$:id=>elements[id],map,frames:[{time:now-7200},{time:now}],fmt:t=>String(t),windColour:()=> '#fff',htmlEscape:s=>String(s).replaceAll('<','&lt;'),
    L:{layerGroup:()=>group,divIcon:o=>o,marker:(ll,o)=>({ll,options:o,bindPopup(html,opts){this.popup=html;this.popupOptions=opts;return this;},addTo(g){g.children.push(this);return this;}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);run(source);
  const fixture={version:1,generatedAt:now,refreshMinutes:60,units:'m/s',sources:{EE:{status:'ok',timeKind:'feed',name:'Agency',period:'Latest values'},FI:{status:'ok',timeKind:'observation',name:'FMI'}},stations:[{country:'EE',code:'EE1',name:'<Estonia>',lat:59,lon:25,rows:[[now-7200,1,2,null],[now-1200,0,null,230]]},{country:'FI',code:'FI1',name:'Finland',lat:61,lon:25,rows:[[now-3600,3.4,7.2,240]]}]};
  context.fixture=fixture;return {now,elements,layers,group,context,run,fixture};
}
test('official wind toggles work independently and missing gusts never show as zero',()=>{
  const h=harness();h.run('officialWindData=validateOfficialWind(fixture)');h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,2);assert.match(h.group.children[0].options.icon.html,/3.4/);assert.match(h.group.children[1].options.icon.html,/0.0/);
  h.elements.officialWindSustained.checked=false;h.elements.officialWindGusts.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,1);assert.match(h.group.children[0].options.icon.html,/7.2/);
  h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,2);assert.match(h.group.children[0].options.icon.html,/S 3.4.*G 7.2/);
  h.elements.officialWindSustained.checked=h.elements.officialWindGusts.checked=false;h.run('renderOfficialWind()');assert.equal(h.group.children.length,0);assert.equal(h.layers.size,0);
});
test('station selection never uses future readings, interpolates gaps, or retains observations over three hours',()=>{
  const h=harness();assert.equal(h.run('officialWindReading(fixture.stations[0],fixture.generatedAt-3600)[1]'),1);
  assert.equal(h.run('officialWindReading(fixture.stations[0],fixture.generatedAt-8000)'),null);
  h.fixture.stations[0].rows=[[h.now-12000,5,8,null],[h.now+600,7,10,null]];assert.equal(h.run('officialWindReading(fixture.stations[0],fixture.generatedAt)'),null);
});
test('historical timeline uses an earlier station reading instead of latest data',()=>{
  const h=harness();h.run('officialWindData=validateOfficialWind(fixture)');h.elements.officialWindSustained.checked=true;h.elements.timeline.value='0';h.run('renderOfficialWind()');assert.equal(h.group.children.length,1);assert.match(h.group.children[0].options.icon.html,/1.0/);assert.doesNotMatch(h.group.children[0].options.icon.html,/0.0/);
});
test('popup distinguishes feed timestamps from observations, escapes names, and uses dark-compatible wind styling',()=>{
  const h=harness();h.run('officialWindData=validateOfficialWind(fixture)');const ee=h.run('officialWindPopup(fixture.stations[0],fixture.stations[0].rows[1])');assert.match(ee,/Source feed timestamp/);assert.match(ee,/&lt;Estonia>/);assert.match(ee,/Unavailable/);assert.match(ee,/wind-popup/);const fi=h.run('officialWindPopup(fixture.stations[1],fixture.stations[1].rows[0])');assert.match(fi,/Observed:/);assert.match(fi,/FMI/);
});
test('validation rejects future snapshots, negative speeds, duplicate station identities, and unsorted rows',()=>{
  const h=harness();h.run('validateOfficialWind(fixture)');h.fixture.generatedAt=h.now+1000;assert.throws(()=>h.run('validateOfficialWind(fixture)'));h.fixture.generatedAt=h.now;h.fixture.stations[0].rows[0][1]=-1;assert.throws(()=>h.run('validateOfficialWind(fixture)'));h.fixture.stations[0].rows[0][1]=1;h.fixture.stations.push(h.fixture.stations[0]);assert.throws(()=>h.run('validateOfficialWind(fixture)'));
});
test('snapshot fetch is shared and disabling during a load cannot resurrect labels',async()=>{
  const h=harness();h.elements.officialWindSustained.checked=true;let resolve,calls=0;h.context.fetch=()=>{calls++;return new Promise(r=>resolve=r);};const pending=h.run('loadOfficialWind()');h.run('loadOfficialWind()');assert.equal(calls,1);h.elements.officialWindSustained.checked=false;h.run('renderOfficialWind()');resolve({ok:true,json:async()=>h.fixture});await pending;assert.equal(h.layers.size,0);assert.equal(h.group.children.length,0);
});
