const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const forecast=require('../js/forecast-data.js');
const now=Date.parse('2026-10-07T20:30:00Z');
function item(time,details={},periods={}){return {time,data:{instant:{details:{air_temperature:5,...details}},...periods}};}
const period=(amount,h=1)=>({['next_'+h+'_hours']:{details:{precipitation_amount:amount},summary:{symbol_code:'rain'}}});
const payload=items=>({properties:{meta:{updated_at:'2026-10-07T19:30:00Z'},timeseries:items}});
const gustGrid=()=>({reference_time:'2026-10-07T18:00:00Z',units:'m/s',grid_spacing_degrees:.25,latitudes:[65,65.25],longitudes:[-19.25,-19],samples:[
  {time:'2026-10-07T21:00:00Z',start:'2026-10-07T20:00:00Z',end:'2026-10-07T21:00:00Z',values:[0,12,13,14]},
  {time:'2026-10-08T00:00:00Z',start:'2026-10-07T23:00:00Z',end:'2026-10-08T00:00:00Z',values:[20,22,23,24]}
]});
test('Iceland gust sampling preserves zero, nearest native periods, and refuses extrapolation',()=>{
  const grid=forecast.validateGustGrid(gustGrid(),'2026-10-07T18:00:00Z');
  const s=forecast.gustSample(grid,65.05,-19.2,Date.parse('2026-10-07T22:00:00Z'));
  assert.equal(s.value,0);assert.equal(s.end,Date.parse('2026-10-07T21:00:00Z'));assert.equal(s.start,Date.parse('2026-10-07T20:00:00Z'));
  assert.equal(forecast.gustSample(grid,64,-19.2,now),null);
  assert.equal(forecast.gustSample(grid,65.05,-19.2,Date.parse('2026-10-08T03:00:00Z')),null);
});
test('malformed, mismatched or unphysical gust grids cannot produce readings',()=>{
  const grid=gustGrid();assert.throws(()=>forecast.validateGustGrid(grid,'2026-10-07T12:00:00Z'));
  grid.samples[0].values[0]=-1;assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time));
  grid.samples[0].values[0]=0;grid.samples[0].end='2026-10-07T22:00:00Z';assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time));
});
test('ECMWF only supplements missing gusts and daily maxima are labelled as available samples',()=>{
  const grid=gustGrid(),series=[{time:Date.parse('2026-10-07T21:00:00Z'),temp:5,gust:null,wind:2,rain:null},{time:Date.parse('2026-10-07T22:00:00Z'),temp:6,gust:8,wind:3,rain:null}];
  const rows=forecast.addGusts(series,grid,65.05,-19.2);
  assert.equal(rows[0].gust,0);assert.equal(rows[0].gustSource,'ECMWF IFS');assert.equal(rows[1].gust,8);assert.equal(rows[1].gustSource,undefined);assert.equal(series[0].gust,null);
  assert(forecast.days(rows,'UTC')[0].ecmwfGusts);
});
test('zero is preserved, missing gusts stay unavailable, and old times are removed',()=>{
  const r=forecast.rows(payload([item('2026-10-07T19:00:00Z'),item('2026-10-07T20:00:00Z',{wind_speed:0},period(0))]),now);
  assert.equal(r.length,1);assert.equal(r[0].wind,0);assert.equal(r[0].gust,null);assert.equal(r[0].rain,0);assert.equal(r[0].hours,1);
});
test('six-hour precipitation is kept as a six-hour amount without invented gusts',()=>{
  const [r]=forecast.rows(payload([item('2026-10-08T06:00:00Z',{},period(12,6))]),now);
  assert.equal(r.hours,6);assert.equal(r.rain,12);assert.equal(r.gust,null);
});
test('daily rain never double-counts overlapping native periods',()=>{
  const r=forecast.rows(payload([item('2026-10-08T00:00:00Z',{},period(6,6)),item('2026-10-08T01:00:00Z',{},period(2)),item('2026-10-08T06:00:00Z',{},period(3,6))]),now);
  const [d]=forecast.days(r,'UTC');assert.equal(d.rain,9);assert.equal(d.rainHours,12);assert(d.partial);
});
test('periods crossing local midnight are not arbitrarily split into daily totals',()=>{
  const r=forecast.rows(payload([item('2026-10-07T20:00:00Z',{},period(6,6)),item('2026-10-08T02:00:00Z',{},period(2,6))]),now);
  const d=forecast.days(r,'Europe/Tallinn');assert.equal(d.length,2);assert.equal(d[0].rain,0);assert(d[0].partial);assert.equal(d[1].rain,2);
});
test('daily grouping respects the selected time zone',()=>{
  assert.equal(forecast.dayKey(Date.parse('2026-10-07T22:00:00Z'),'Europe/Tallinn'),'2026-10-08');
  assert.equal(forecast.dayKey(Date.parse('2026-10-07T22:00:00Z'),'Atlantic/Reykjavik'),'2026-10-07');
});
test('malformed and expired-only forecasts fail rather than show empty results',()=>{
  assert.throws(()=>forecast.rows({}));assert.throws(()=>forecast.rows(payload([item('2020-01-01T00:00:00Z')]),now));
});
const flush=()=>new Promise(r=>setImmediate(r));
function harness(){
  const ids={},timers=new Map(),requests=[],storage=new Map();let timerId=0,observer,tick;
  class Element{
    constructor(){this.children=[];this.events={};this.dataset={};this.hidden=false;this.value='0';this.classList={toggle(){},contains:()=>String(this.className||'').includes('bad')};}
    set innerHTML(s){for(const m of s.matchAll(/id="([^"]+)"/g))ids[m[1]]=new Element();}
    append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);}prepend(n){this.children.unshift(n);}
    replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this[k]=v;}removeAttribute(k){delete this[k];}addEventListener(k,f){this.events[k]=f;}focus(){}
    getBoundingClientRect(){return {bottom:80,top:700};}
    cloneNode(deep){const e=new Element();for(const k of ['id','textContent','className'])if(this[k]!==undefined)e[k]=this[k];if(deep)e.children=this.children.map(n=>n.cloneNode(true));return e;}
    scrollIntoView(){}
  }
  const nav=new Element(),body=new Element();body.appendChild=e=>{body.append(e);ids[e.id]=e;};
  const markers=[],listeners={},popups=[];let currentPopup;const map={createPane(){},getPane:()=>({style:{}}),getCenter:()=>({lat:59.437,lng:24.7536}),on:(k,f)=>listeners[k]=f,removeLayer(){},closePopup(){currentPopup?.close();}};
  const c={document:{body,hidden:false,querySelector:()=>nav,createElement:()=>new Element(),addEventListener(){}},window:{innerWidth:1366,innerHeight:936,addEventListener(){}},$:id=>ids[id],map,
    L:{point:(x,y)=>[x,y],popup:options=>{const p={options,on(k,f){this[k]=f;return this;},setLatLng(ll){this.ll=ll;return this;},setContent(c){this.content=c;return this;},openOn(){currentPopup=this;this.open=true;return this;},close(){if(this.open){this.open=false;this.remove?.();}return this;}};popups.push(p);return p;},DomEvent:{disableClickPropagation(){},disableScrollPropagation(){}},divIcon:x=>x,marker:coords=>{markers.push(coords);return {addTo(){return this;}};}},
    MetForecastData:{...forecast,rows:d=>forecast.rows(d,now)},Intl,Date:class extends Date{static now(){return now;}},AbortController,URLSearchParams,
    MutationObserver:class{constructor(f){observer=f;}observe(){}},
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    setInterval:f=>{tick=f;},setTimeout:(f,n)=>{const id=++timerId;timers.set(id,{f,n});return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),stop(){}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/forecast.js','utf8'),c);
  const open=()=>{ids.forecastSection.hidden=false;observer();};
  const choose=(lat,lng)=>{listeners.click({latlng:{lat,lng}});};
  const runDebounce=()=>{for(const [id,t]of timers)if(t.n===350){timers.delete(id);t.f();}};
  const reply=(i,temp=5)=>requests[i].resolve({ok:true,status:200,headers:{get:()=>new Date(now+3600000).toUTCString()},json:async()=>payload([item('2026-10-07T20:00:00Z',{air_temperature:temp},period(0))])});
  const replyJson=(i,data)=>requests[i].resolve({ok:true,json:async()=>data});
  return {ids,requests,markers,popups,open,choose,runDebounce,reply,replyJson,tick,hidePanel:()=>{ids.forecastSection.hidden=true;observer();},close:()=>{ids.forecastSection.hidden=true;currentPopup?.close();observer();}};
}
test('repeated updates reuse cache and in-flight requests; API URL identifies rounded coordinates',async()=>{
  const h=harness();h.open();h.runDebounce();h.ids.forecastRetry.events.click();assert.equal(h.requests.length,1);
  assert(h.requests[0].url.endsWith('lat=59.437&lon=24.754'));assert.equal(h.requests[0].options.headers,undefined);
  h.reply(0);await flush();h.ids.forecastRetry.events.click();await flush();assert.equal(h.requests.filter(r=>r.url.includes('api.met.no')).length,1);assert.equal(h.ids.forecastContent.hidden,false);
});
test('a late response for an old location cannot replace the new location',async()=>{
  const h=harness();h.open();h.runDebounce();h.choose(60,25);h.runDebounce();assert.equal(h.requests.length,2);
  h.reply(1,9);await flush();const current=h.ids.forecastSelected.children[0].children[0].textContent;
  h.reply(0,-10);await flush();assert.equal(h.ids.forecastSelected.children[0].children[0].textContent,current);assert.equal(current,'9.0°');
});
test('closing the panel cancels work and prevents a late result from being shown',async()=>{
  const h=harness();h.open();h.runDebounce();h.close();assert(h.requests[0].options.signal.aborted);
  h.reply(0);await flush();assert.equal(h.ids.forecastContent.hidden,true);
});
const gustMeta={reference_time:'2026-10-07T18:00:00Z',asset_root:'forecast-iceland-cache',asset_version:'atlantic-v1',gust_grid:{path:'data/forecast-iceland-cache/20261007T18Z-atlantic-v1/gust-grid-v1.json',units:'m/s'}};
test('The expanded Europe source keeps Iceland numeric gusts working',async()=>{
  const meta=structuredClone(gustMeta);meta.asset_version='euroatlantic-v2';meta.gust_grid.path=meta.gust_grid.path.replace('atlantic-v1','euroatlantic-v2');
  const h=harness();h.open();h.choose(65.05,-19.2);h.runDebounce();h.reply(0);await flush();h.replyJson(1,meta);await flush();
  assert.equal(h.requests[2].url,meta.gust_grid.path);h.replyJson(2,gustGrid());await flush();
  assert.equal(h.ids.forecastSelected.children[1].children[1].children[1].textContent,'0.0 m/s');assert.equal(h.ids.forecastGustAttribution.hidden,false);
});
test('Iceland panel loads shared numeric gusts, labels the native interval, and reuses the grid',async()=>{
  const h=harness();h.open();h.choose(65.05,-19.2);h.runDebounce();h.reply(0);await flush();
  assert(h.requests[1].url.startsWith('data/forecast-iceland.json'));h.replyJson(1,gustMeta);await flush();
  assert.equal(h.requests[2].url,gustMeta.gust_grid.path);h.replyJson(2,gustGrid());await flush();
  const card=h.ids.forecastSelected.children[1].children[1];assert.equal(card.children[1].textContent,'0.0 m/s');assert.match(card.children[2].textContent,/ECMWF IFS.*maximum.*0.25°/);
  assert.equal(h.ids.forecastGustAttribution.hidden,false);
  h.choose(65.1,-19.1);h.runDebounce();h.reply(3);await flush();assert.equal(h.requests.length,4); // One new MET location request, no new gust grid.
});
test('a late Iceland grid cannot replace another location or a closed forecast panel',async()=>{
  const h=harness();h.open();h.choose(65.05,-19.2);h.runDebounce();h.reply(0);await flush();h.replyJson(1,gustMeta);await flush();
  h.choose(59,25);h.runDebounce();h.reply(3,9);await flush();h.replyJson(2,gustGrid());await flush();
  assert.equal(h.ids.forecastSelected.children[0].children[0].textContent,'9.0°');assert.equal(h.ids.forecastSelected.children[1].children[1].children[1].textContent,'Unavailable');assert.equal(h.ids.forecastGustAttribution.hidden,true);
  const other=harness();other.open();other.choose(65.05,-19.2);other.runDebounce();other.reply(0);await flush();other.close();other.replyJson(1,gustMeta);await flush();other.replyJson(2,gustGrid());await flush();assert.equal(other.ids.forecastGustAttribution.hidden,true);
});


test('Canada gust grid retains native spacing, valid zero gusts and refuses points outside its longitude band',()=>{
 const grid=gustGrid();grid.region='Canada';grid.latitudes=[50,50.25];grid.longitudes=[-100,-99.75];forecast.validateGustGrid(grid,grid.reference_time,'Canada');const rows=forecast.addGusts([{time:Date.parse('2026-10-07T21:00:00Z'),gust:null}],grid,50.05,-100);assert.equal(rows[0].gust,0);assert.equal(rows[0].gustSource,'ECMWF IFS');assert.equal(forecast.gustSample(grid,50,-110,Date.parse('2026-10-07T21:00:00Z')),null);assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time));grid.samples[0].values[0]=Infinity;assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time,'Canada'));
});

const canadaGustMeta={reference_time:'2026-10-07T18:00:00Z',asset_root:'forecast-canada-cache',asset_version:'canada-v1',gust_grids:[[-142,-110],[-110,-80],[-80,-50]].map(([west,east],i)=>({bounds:[west,40,east,84],path:'data/forecast-canada-cache/20261007T18Z-canada-v1/gust-grid-'+i+'-v1.json',units:'m/s'}))};
const canadaGustGrid=()=>({...gustGrid(),region:'Canada',latitudes:[50,50.25],longitudes:[-100,-99.75]});
test('Canada point forecast downloads only its gust band and reuses it for nearby points',async()=>{
 const h=harness();h.open();h.choose(50.05,-100);h.runDebounce();h.reply(0);await flush();assert(h.requests[1].url.startsWith('data/forecast-canada.json'));h.replyJson(1,canadaGustMeta);await flush();assert.equal(h.requests[2].url,canadaGustMeta.gust_grids[1].path);h.replyJson(2,canadaGustGrid());await flush();assert.equal(h.ids.forecastSelected.children[1].children[1].children[1].textContent,'0.0 m/s');assert.equal(h.ids.forecastGustAttribution.hidden,false);h.choose(50.1,-99.9);h.runDebounce();h.reply(3);await flush();assert.equal(h.requests.length,4);
});
test('Late Canada gust data cannot replace another location',async()=>{
 const h=harness();h.open();h.choose(50.05,-100);h.runDebounce();h.reply(0);await flush();h.replyJson(1,canadaGustMeta);await flush();h.choose(59,25);h.runDebounce();h.reply(3,9);await flush();h.replyJson(2,canadaGustGrid());await flush();assert.equal(h.ids.forecastSelected.children[0].children[0].textContent,'9.0°');assert.equal(h.ids.forecastGustAttribution.hidden,true);
});


const americaGustMeta={reference_time:'2026-10-07T18:00:00Z',asset_root:'forecast-canada-cache',asset_version:'northamerica-v2',gust_grids:[18,40,62].flatMap((south,row)=>[-190,-150,-110,-70].map((west,col)=>({bounds:[west,south,west+40,south+22],path:'data/forecast-canada-cache/20261007T18Z-northamerica-v2/gust-grid-'+(row*4+col)+'-v1.json',units:'m/s'})))};
const americaGustGrid=(lat=26,lon=-81)=>({...gustGrid(),region:'North America',latitudes:[lat,lat+.25],longitudes:[lon,lon+.25]});
test('USA point forecasts load their local gust grid with the new source version',async()=>{
 const h=harness();h.open();h.choose(26.05,-81);h.runDebounce();h.reply(0);await flush();h.replyJson(1,americaGustMeta);await flush();assert.equal(h.requests[2].url,americaGustMeta.gust_grids[2].path);h.replyJson(2,americaGustGrid());await flush();assert.equal(h.ids.forecastSelected.children[1].children[1].children[1].textContent,'0.0 m/s');assert.equal(h.ids.forecastGustAttribution.hidden,false);
});
test('Native gust samples work on both sides of the Alaska date line and reject invented grid detail',()=>{
 const grid=americaGustGrid(52,-187);forecast.validateGustGrid(grid,grid.reference_time,'North America');assert.equal(forecast.gustSample(grid,52,173,Date.parse('2026-10-07T21:00:00Z')).value,0);assert.equal(forecast.gustSample(grid,52,-187,Date.parse('2026-10-07T21:00:00Z')).value,0);assert.equal(forecast.gustSample(grid,52,172,Date.parse('2026-10-07T21:00:00Z')),null);grid.longitudes=[-187,-186.9];assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time,'North America'));
});

test('Date-line point pins stay on the clicked world copy while the forecast API uses canonical longitude',()=>{const h=harness();h.open();h.choose(52,-187);h.runDebounce();assert.match(h.requests[0].url,/lon=173.000/);assert.equal(h.markers.at(-1)[1],-187);h.close();h.open();assert.equal(h.markers.at(-1)[1],-187);});


const europeGustMeta={reference_time:'2026-10-07T18:00:00Z',asset_root:'forecast-iceland-cache',asset_version:'euroatlantic-v3',europe_gust_grids:[18,40,62].flatMap((south,row)=>[-30,0,30].map((west,col)=>({bounds:[west,south,west+30,south+22],path:'data/forecast-iceland-cache/20261007T18Z-euroatlantic-v3/europe-gust-grid-'+(row*3+col)+'-v1.json',units:'m/s'})))};
const europeGustGrid=()=>({...gustGrid(),region:'Europe',latitudes:[41.75,42],longitudes:[12.25,12.5]});
test('Europe grids preserve native gusts and refuse locations beyond their coverage',()=>{
 const grid=europeGustGrid();forecast.validateGustGrid(grid,grid.reference_time,'Europe');
 assert.equal(forecast.gustSample(grid,41.8,12.3,Date.parse('2026-10-07T21:00:00Z')).value,0);
 assert.equal(forecast.gustSample(grid,40,12.3,now),null);
 const rows=forecast.addGusts([{time:Date.parse('2026-10-07T21:00:00Z'),gust:17}],grid,41.8,12.3);assert.equal(rows[0].gust,17);
 grid.region='North America';assert.throws(()=>forecast.validateGustGrid(grid,grid.reference_time,'Europe'));
});
test('Rome fills missing gusts from only its regional grid and reuses the cached tile',async()=>{
 const h=harness();h.open();h.choose(41.8,12.3);h.runDebounce();h.reply(0);await flush();h.replyJson(1,europeGustMeta);await flush();
 assert.equal(h.requests[2].url,europeGustMeta.europe_gust_grids[4].path);h.replyJson(2,europeGustGrid());await flush();
 assert.equal(h.ids.forecastSelected.children[1].children[1].children[1].textContent,'0.0 m/s');assert.equal(h.ids.forecastGustAttribution.hidden,false);
 h.choose(41.9,12.4);h.runDebounce();h.reply(3);await flush();assert.equal(h.requests.length,4);
});
test('A late Europe grid cannot replace a newly selected location',async()=>{
 const h=harness();h.open();h.choose(41.8,12.3);h.runDebounce();h.reply(0);await flush();h.replyJson(1,europeGustMeta);await flush();h.choose(59,25);h.runDebounce();h.reply(3,9);await flush();h.replyJson(2,europeGustGrid());await flush();assert.equal(h.ids.forecastSelected.children[0].children[0].textContent,'9.0°');assert.equal(h.ids.forecastGustAttribution.hidden,true);
});

test('9 km encoded gusts preserve native points and zero while rejecting truncated bytes',()=>{
 const g=gustGrid();g.grid_spacing_degrees=.1;g.latitudes=[65,65.1];g.longitudes=[-19.2,-19.1];g.encoding='uint16-le-base64';g.scale=.01;
 for(const s of g.samples){const bytes=Buffer.alloc(8);s.values.forEach((v,i)=>bytes.writeUInt16LE(Math.round(v*100),i*2));s.values=bytes.toString('base64');}
 const broken=structuredClone(g);broken.samples[0].values='AAAA';assert.throws(()=>forecast.validateGustGrid(broken,g.reference_time));
 forecast.validateGustGrid(g,g.reference_time);forecast.validateGustGrid(g,g.reference_time);
 const t=Date.parse(g.samples[0].time);assert.equal(forecast.gustSample(g,65,-19.2,t).value,0);
 assert.equal(forecast.gustSample(g,65.1,-19.1,t).value,14);assert.equal(forecast.gustSample(g,65.1,-19.1,t).resolution,.1);
 assert.equal(forecast.gustSample(g,65.2,-19.1,t),null);
});


test('Compressed 9 km gust payloads decode with bounded size before native validation',async()=>{
 const g=gustGrid();g.grid_spacing_degrees=.1;g.latitudes=[65,65.1];g.longitudes=[-19.2,-19.1];g.encoding='uint16-le-gzip-base64';g.scale=.01;
 for(const s of g.samples){const bytes=Buffer.alloc(8);s.values.forEach((v,i)=>bytes.writeUInt16LE(Math.round(v*100),i*2));s.values=require('node:zlib').gzipSync(bytes).toString('base64');}
 const broken=structuredClone(g);broken.samples[0].values=require('node:zlib').gzipSync(Buffer.alloc(100)).toString('base64');
 await assert.rejects(()=>forecast.prepareGustGrid(broken));
 const ready=forecast.validateGustGrid(await forecast.prepareGustGrid(g),g.reference_time);
 assert.equal(ready.samples[0].values[0],0);assert.equal(ready.samples[0].values[3],14);
});

test('map forecast popup keeps loading with the menu closed and shows the same six metrics',async()=>{
 const h=harness();h.open();h.choose(59.437,24.75);h.hidePanel();h.runDebounce();
 assert.equal(h.requests.length,1);assert(!h.requests[0].options.signal.aborted);
 const popup=h.popups[0];assert(popup.open);assert.equal(popup.options.pane,'forecastPopup');
 h.reply(0,9);await flush();
 const summary=popup.content.children[2];assert.equal(summary.id,undefined);
 assert.equal(summary.children[0].children[0].textContent,'9.0°');
 assert.equal(summary.children[1].children.length,6);
 assert.equal(summary.children[1].children[1].children[1].textContent,'Unavailable');
 assert.equal(summary.children[1].children[2].children[1].textContent,'0.0 mm');
 assert.equal(h.ids.forecastSection.hidden,true);
});

test('closing a standalone forecast popup cancels its request and rejects a late response',async()=>{
 const h=harness();h.open();h.choose(59.437,24.75);h.hidePanel();h.runDebounce();
 h.popups[0].close();assert(h.requests[0].options.signal.aborted);
 h.reply(0,30);await flush();assert.equal(h.ids.forecastContent.hidden,true);assert.equal(h.popups[0].open,false);
});
