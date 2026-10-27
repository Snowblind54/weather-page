const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('js/temperature-us.js','utf8');
function context(extra={}){const c={Date,Math,Number,Float32Array,Int32Array,Uint8Array,Promise,Map,Set,...extra};vm.createContext(c);vm.runInContext(source,c);return c;}
const region={id:'test',bounds:[[45,5],[47,8]],w:120,h:90},now=1800000000;
const observations=Array.from({length:30},(_,i)=>({country:i%2?'CH':'FR',code:String(i),lat:45.5+(i%5)*.2,lon:5.5+Math.floor(i/5)*.3,temp:10+i%4,time:now}));

test('terrain geometry is reused across changing readings and invalidated when station positions change',async()=>{
 let work=0;const c=context({NorthernTerrain:{available:true,elevation:()=>{work++;return 500},influence:()=>{work++;return()=>{work++;return 1}}}});
 const api=c.NorthernUSTemperature,first=await api.raster(region,observations,now);const initial=work;assert(initial>0);
 const second=await api.raster(region,observations.map(s=>({...s,temp:s.temp+2,time:now+60})),now+60);
 assert.equal(work,initial,'repeat frames must not recalculate terrain');
 const i=first.values.findIndex((v,i)=>Number.isFinite(v)&&Number.isFinite(second.values[i]));assert(i>=0);assert(Math.abs(second.values[i]-first.values[i]-2)<1e-4);
 await api.raster(region,observations.map((s,i)=>i? s:{...s,lon:s.lon+.1}),now);assert(work>initial);
});

test('the browser sends interpolation to a background worker and accepts transferred results',async()=>{
 let messages=0,url;
 class Worker{
  constructor(path){url=path}postMessage({id}){messages++;queueMicrotask(()=>this.onmessage({data:{id,result:{values:new Float32Array([7]),alpha:new Uint8Array([205])}}}))}terminate(){}
 }
 const c=context({Worker,document:{},NorthernTerrain:{elevation(){throw new Error('Heavy main-thread work must not run')}}});
 const result=await c.NorthernUSTemperature.raster(region,observations,now);
 assert.equal(messages,1);assert.match(url,/temperature-raster-worker/);assert.equal(result.values[0],7);
 assert.equal(await c.NorthernUSTemperature.raster(region,observations,now,()=>false),null);assert.equal(messages,1);
});

test('a blocked worker falls back to cancellable interpolation instead of losing the heatmap',async()=>{
 class Worker{postMessage(){queueMicrotask(()=>this.onerror(new Error('Worker blocked')))}terminate(){}}
 let yields=0;const c=context({Worker,document:{}});
 const result=await c.NorthernUSTemperature.raster(region,observations,now,()=>true,async()=>{yields++});
 assert(result.alpha.some(a=>a>0));assert(yields>0);
});
