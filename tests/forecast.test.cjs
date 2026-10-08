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
    constructor(){this.children=[];this.events={};this.dataset={};this.hidden=false;this.value='0';this.classList={toggle(){}};}
    set innerHTML(s){for(const m of s.matchAll(/id="([^"]+)"/g))ids[m[1]]=new Element();}
    append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);}prepend(n){this.children.unshift(n);}
    replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this[k]=v;}addEventListener(k,f){this.events[k]=f;}focus(){}
  }
  const nav=new Element(),body=new Element();body.appendChild=e=>{body.append(e);ids[e.id]=e;};
  const listeners={};const map={createPane(){},getPane:()=>({style:{}}),getCenter:()=>({lat:59.437,lng:24.7536}),on:(k,f)=>listeners[k]=f,removeLayer(){},closePopup(){}};
  const c={document:{body,hidden:false,querySelector:()=>nav,createElement:()=>new Element(),addEventListener(){}},window:{addEventListener(){}},$:id=>ids[id],map,
    L:{DomEvent:{disableClickPropagation(){},disableScrollPropagation(){}},divIcon:x=>x,marker:()=>({addTo(){return this;}})},
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
  return {ids,requests,open,choose,runDebounce,reply,replyJson,tick,close:()=>{ids.forecastSection.hidden=true;observer();}};
}
test('repeated updates reuse cache and in-flight requests; API URL identifies rounded coordinates',async()=>{
  const h=harness();h.open();h.runDebounce();h.ids.forecastRetry.events.click();assert.equal(h.requests.length,1);
  assert(h.requests[0].url.endsWith('lat=59.437&lon=24.754'));assert.equal(h.requests[0].options.headers,undefined);
  h.reply(0);await flush();h.ids.forecastRetry.events.click();await flush();assert.equal(h.requests.length,1);assert.equal(h.ids.forecastContent.hidden,false);
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
