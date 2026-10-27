/* Individual 2 m temperature ensembles, fetched only for an opened location. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NorthernEnsembleData=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const models=[{id:'ecmwf',api:'ecmwf_ifs025',name:'ECMWF',members:51,color:'#79b2ff',resolution:'0.25°'},{id:'gfs',api:'gfs05',name:'GFS',members:31,color:'#ff8585',resolution:'0.5°'}];
 const ttl=30*60*1000,cache=new Map(),storageKey='northernTemperatureEnsemblesV1';let restored=false;
 function location(point){
  const lat=Number(point.lat),lon=Number(point.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat< -90||lat>90||lon< -180||lon>180)throw new Error('Invalid ensemble location');
  return {lat:Number(lat.toFixed(3)),lon:Number(lon.toFixed(3))};
 }
 function url(point,id){
  const p=location(point),model=models.find(m=>m.id===id);if(!model)throw new Error('Unknown ensemble model');
  const q=new URLSearchParams({latitude:p.lat,longitude:p.lon,hourly:'temperature_2m',models:model.api,forecast_days:'15',timeformat:'unixtime',timezone:'auto',temperature_unit:'celsius',cell_selection:'land'});
  return 'https://ensemble-api.open-meteo.com/v1/ensemble?'+q;
 }
 function normalize(raw,id,fetchedAt=Date.now()){
  const model=models.find(m=>m.id===id),h=raw?.hourly,times=h?.time;
  if(!model||!Array.isArray(times)||times.length<2||times.length>400||times.some((t,i)=>!Number.isInteger(t)||t<0||(i&&t<=times[i-1])))throw new Error('Unexpected ensemble time axis');
  if(times.at(-1)-times[0]>17*86400)throw new Error('Unexpected ensemble forecast length');
  const keys=Object.keys(h).filter(k=>/^temperature_2m(?:_member\d{2,3})?$/.test(k)).sort((a,b)=>a==='temperature_2m'?-1:b==='temperature_2m'?1:a.localeCompare(b));
  if(keys.length<2||keys.length>model.members)throw new Error('Individual ensemble members unavailable');
  const members=keys.map(key=>{
   const values=h[key];if(raw.hourly_units?.[key]!=='°C'||!Array.isArray(values)||values.length!==times.length)throw new Error('Ensemble temperature units or member length changed');
   return values.map(v=>v===null?null:typeof v==='number'&&Number.isFinite(v)&&v>=-100&&v<=65?v:null);
  });
  if(!members.some(values=>values.some(Number.isFinite)))throw new Error('No temperature forecasts available');
  return {id,times,members,fetchedAt,timezone:typeof raw.timezone==='string'?raw.timezone:'UTC',elevation:Number.isFinite(raw.elevation)?raw.elevation:null,latitude:raw.latitude,longitude:raw.longitude};
 }
 function quantile(sorted,p){const x=(sorted.length-1)*p,a=Math.floor(x);return sorted[a]+(sorted[Math.ceil(x)]-sorted[a])*(x-a);}
 function statistics(data){
  return data.times.map((time,i)=>{
   const values=data.members.map(m=>m[i]).filter(Number.isFinite).sort((a,b)=>a-b);
   if(values.length<2)return null;
   return {time,count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,p10:quantile(values,.1),p90:quantile(values,.9),min:values[0],max:values.at(-1),belowZero:values.filter(v=>v<0).length/values.length};
  });
 }
 function restore(){
  if(restored)return;restored=true;
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(saved))for(const [key,item]of saved.slice(-12)){if(item?.fetchedAt<=Date.now()&&Date.now()-item.fetchedAt<ttl&&item?.raw){cache.set(key,item);}}}catch{}
 }
 function save(){try{localStorage.setItem(storageKey,JSON.stringify([...cache].slice(-12)));}catch{}}
 async function load(point,id,{signal,fetcher=globalThis.fetch}={}){
  restore();const p=location(point),key=p.lat+','+p.lon+'/'+id,item=cache.get(key);
  if(item&&Date.now()-item.fetchedAt<ttl){try{return normalize(item.raw,id,item.fetchedAt);}catch{cache.delete(key);}}
  const response=await fetcher(url(p,id),{signal,cache:'no-cache'});
  if(!response.ok)throw new Error(response.status===429?'The ensemble service is busy. Try again shortly.':'Ensemble service unavailable (HTTP '+response.status+').');
  const raw=await response.json(),fetchedAt=Date.now(),data=normalize(raw,id,fetchedAt);
  cache.delete(key);cache.set(key,{raw,fetchedAt});while(cache.size>12)cache.delete(cache.keys().next().value);save();return data;
 }
 return {models,url,normalize,statistics,load,location,ttl};
});
