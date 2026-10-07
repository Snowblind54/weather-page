const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const forecast=require('../js/forecast-data.js');
const now=Date.parse('2026-10-07T20:30:00Z');
function item(time,details={},periods={}){return {time,data:{instant:{details:{air_temperature:5,...details}},...periods}};}
const period=(amount,h=1)=>({['next_'+h+'_hours']:{details:{precipitation_amount:amount},summary:{symbol_code:'rain'}}});
const payload=items=>({properties:{meta:{updated_at:'2026-10-07T19:30:00Z'},timeseries:items}});
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
  return {ids,requests,open,choose,runDebounce,reply,tick,close:()=>{ids.forecastSection.hidden=true;observer();}};
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
