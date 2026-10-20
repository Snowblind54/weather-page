const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/official-wind.js'),'utf8');
function harness(){
  const now=Math.floor(Date.now()/1000),elements={officialWindSustained:{checked:false},officialWindGusts:{checked:false},officialWindStatus:{},windMode:{value:'sustained'},windOn:{checked:false},windHeatmapOn:{checked:false},timeline:{value:'1',max:'1'}};
  for(const e of Object.values(elements))e.addEventListener=(type,fn)=>e[type]=fn;
  const layers=new Set(),group={children:[],clearLayers(){this.children=[];},getLayers(){return this.children;},addTo(){layers.add(this);return this;}};
  const map={createPane(){},getPane:()=>({style:{}}),on(){},hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),getZoom:()=>6,getBounds:()=>({toBBoxString:()=> 'view',contains:()=>true}),latLngToContainerPoint:([lat,lon])=>({x:(lon-18)*100,y:(lat-53)*100})};
  const context={console,Date,Math,Number,Array,Map,Set,Promise,AbortController,setTimeout,clearTimeout,setInterval(){},document:{hidden:false,addEventListener(){}},$:id=>elements[id],map,frames:[{time:now-7200},{time:now}],fmt:t=>String(t),windColour:()=> '#fff',htmlEscape:s=>String(s).replaceAll('<','&lt;'),
    L:{layerGroup:()=>group,divIcon:o=>o,marker:(ll,o)=>({ll,options:o,on(){return this;},bindPopup(html,opts){this.popup=html;this.popupOptions=opts;return this;},addTo(g){g.children.push(this);return this;}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);run(source);
  const fixture={version:1,generatedAt:now,refreshMinutes:10,units:'m/s',sources:{EE:{status:'ok',timeKind:'feed',name:'Agency',period:'Latest values'},FI:{status:'ok',timeKind:'observation',name:'FMI'}},stations:[{country:'EE',code:'EE1',name:'<Estonia>',lat:59,lon:25,rows:[[now-7200,1,2,null],[now-1200,0,null,230]]},{country:'FI',code:'FI1',name:'Finland',lat:61,lon:25,rows:[[now-3600,3.4,7.2,240]]}]};
  context.fixture=fixture;return {now,elements,layers,group,context,run,fixture};
}
test('official wind toggles work independently and missing gusts never show as zero',()=>{
  const h=harness();h.run('officialWindData=validateOfficialWind(fixture)');h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,2);assert.match(h.group.children[0].options.icon.html,/3.4/);assert.match(h.group.children[1].options.icon.html,/0.0/);
  h.elements.officialWindSustained.checked=false;h.elements.officialWindGusts.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,1);assert.match(h.group.children[0].options.icon.html,/7.2/);
  h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,2);assert.match(h.group.children[0].options.icon.html,/S 3.4.*G 7.2/);
  h.elements.officialWindSustained.checked=h.elements.officialWindGusts.checked=false;h.run('renderOfficialWind()');assert.equal(h.group.children.length,0);assert.equal(h.layers.size,0);
});
test('Faroe, UK and Irish measurements validate, label sources and preserve missing gusts',()=>{
 const h=harness();
 for(const [country,lat,lon,name] of [['FO',62,-6.8,'Faroe Islands'],['GB',51.5,-.4,'UK'],['IE',53.5,-7.3,'Ireland']]){
  h.fixture.sources[country]={status:'ok',timeKind:'observation',name:'Official '+name,period:'Measured wind'};
  h.fixture.stations.push({country,code:country+'1',name,lat,lon,rows:[[h.now-600,4.5,null,270]]});
 }
 h.run('officialWindData=validateOfficialWind(fixture)');
 for(const s of h.fixture.stations.slice(-3)){
  h.context.selected=s;
  const popup=h.run('officialWindPopup(selected,selected.rows[0])');
  assert.match(popup,/Unavailable/);assert(popup.includes(s.name));assert(popup.includes('Official '+s.name));
 }
 h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,5);
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
  const h=harness();h.elements.officialWindSustained.checked=true;let resolve,calls=0;h.context.fetch=()=>{calls++;return new Promise(r=>resolve=r);};const pending=h.run('loadOfficialWind()');h.run('loadOfficialWind()');assert.equal(calls,1);h.elements.officialWindSustained.checked=false;h.run('renderOfficialWind()');resolve({ok:true,json:async()=>h.fixture});await pending;assert.equal(calls,1,'24 h history waits for a station popup');assert.equal(h.layers.size,0);assert.equal(h.group.children.length,0);
});

test('Florida stations validate and display NOAA observations with missing gusts intact',()=>{
  const h=harness();
  h.fixture.sources.US={status:'ok',timeKind:'observation',name:'NOAA / NWS',period:'2-minute mean wind'};
  h.fixture.stations=[{country:'US',code:'KMIA',name:'Miami',lat:25.8,lon:-80.3,rows:[[h.now-600,5.14,null,90]]}];
  h.run('officialWindData=validateOfficialWind(fixture)');
  h.elements.officialWindSustained.checked=true;h.run('renderOfficialWind()');
  assert.equal(h.group.children.length,1);
  assert.match(h.group.children[0].popup,/Official station · USA/);
  assert.match(h.group.children[0].popup,/NOAA/);
  assert.match(h.group.children[0].popup,/Unavailable/);
  h.elements.officialWindSustained.checked=false;h.elements.officialWindGusts.checked=true;h.run('renderOfficialWind()');
  assert.equal(h.group.children.length,0);
  h.fixture.stations[0].lat=10;assert.throws(()=>h.run('validateOfficialWind(fixture)'));
});



test('US validation covers mainland, Alaska, Hawaii and the Aleutian date line without changing European bounds',()=>{
 const h=harness();h.fixture.sources.US={status:'ok',timeKind:'observation',name:'NOAA'};
 h.fixture.stations=[['KJFK',40.6,-73.8],['PANC',61.2,-150],['PHNL',21.3,-157.9],['PASY',52.7,174.1]].map(([code,lat,lon])=>({country:'US',code,name:code,lat,lon,rows:[[h.now-60,5.14,10.29,90]]}));
 h.run('validateOfficialWind(fixture)');h.fixture.stations[0].country='EE';assert.throws(()=>h.run('validateOfficialWind(fixture)'));
});
test('the shared snapshot accepts a nationwide station count and still enforces a bounded maximum',()=>{
 const h=harness();h.fixture.sources.US={status:'ok',timeKind:'observation',name:'NOAA'};
 h.fixture.stations=Array.from({length:4500},(_,i)=>({country:'US',code:'US'+i,name:'US Station',lat:40,lon:-100,rows:[[h.now-60,0,null,null]]}));
 h.run('validateOfficialWind(fixture)');h.fixture.stations=Array.from({length:10001},()=>h.fixture.stations[0]);assert.throws(()=>h.run('validateOfficialWind(fixture)'));
});

test('clicking measured wind controls loads the shared snapshot without enabling a modeled field',async()=>{
  const h=harness();let requests=0;
  h.context.fetch=async url=>{requests++;assert.equal(url,'data/official-wind.json');return {ok:true,json:async()=>h.fixture};};
  h.elements.officialWindSustained.checked=true;h.elements.officialWindSustained.change();
  await h.run('officialWindPromise');
  assert.equal(requests,1);assert.equal(h.group.children.length,2);
  assert.equal(h.elements.windOn.checked,false);assert.equal(h.elements.windHeatmapOn.checked,false);
  h.elements.officialWindGusts.checked=true;h.elements.officialWindGusts.change();assert.equal(requests,1,'another toggle reuses the same snapshot');
  h.elements.officialWindSustained.checked=h.elements.officialWindGusts.checked=false;
  h.elements.officialWindGusts.change();assert.equal(h.group.children.length,0);
});



test('Germany and Benelux official gusts validate in their national bounds with correct periods',()=>{
 const h=harness();h.fixture.stations=[];
 for(const [country,lat,lon,name,period] of [['DE',47.97,8.52,'Germany','10 min'],['NL',52.1,5.18,'Netherlands','10 min'],['BE',50.8,4.35,'Belgium','10 min'],['LU',49.63,6.23,'Luxembourg','2 min']]){
  h.fixture.sources[country]={status:'ok',timeKind:'observation',name:'Official '+name,period:'Native observation period'};
  h.fixture.stations.push({country,code:country+'1',name,lat,lon,rows:[[h.now-600,4,8,180]]});
  h.context.selected=h.fixture.stations.at(-1);h.run('officialWindData=validateOfficialWind(fixture)');
  const popup=h.run('officialWindPopup(selected,selected.rows[0])');assert(popup.includes('Official '+name));assert(popup.includes(period));
 }
 h.elements.officialWindGusts.checked=true;h.run('renderOfficialWind()');assert.equal(h.group.children.length,4);
 h.fixture.stations.at(-1).lat=52;assert.throws(()=>h.run('validateOfficialWind(fixture)'));
});

test('Scottish SYNOP popups retain their hourly gust period and provider instead of airport definitions',()=>{
 const h=harness();h.fixture.sources.GB={status:'ok',timeKind:'observation',name:'UK observations',period:'Airport default'};
 h.fixture.stations=[{country:'GB',code:'SYNOP-03044',name:'Altnaharra',lat:58.28,lon:-4.43,sourceName:'Met Office SYNOP observations distributed by DWD',period:'10-minute mean wind and maximum gust over the preceding hour.',gustLabel:'Gust max · 1 hour',rows:[[h.now-1800,10,16.67,110]]}];
 h.run('officialWindData=validateOfficialWind(fixture)');const popup=h.run('officialWindPopup(fixture.stations[0],fixture.stations[0].rows[0])');
 assert.match(popup,/Gust max · 1 hour/);assert.match(popup,/preceding hour/);assert.match(popup,/SYNOP observations/);assert.match(popup,/weather_reports\/poi/);assert.doesNotMatch(popup,/Airport default/);
});
