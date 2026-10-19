// Rank recent measurements only; these are coverage leaders, not global records.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WeatherExtremesData=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const names={EE:'Estonia',LV:'Latvia',LT:'Lithuania',FI:'Finland',SE:'Sweden',NO:'Norway',IS:'Iceland',PL:'Poland',DK:'Denmark',GL:'Greenland',CA:'Canada',US:'USA',FO:'Faroe Islands',GB:'UK',UK:'UK',IE:'Ireland',DE:'Germany',NL:'Netherlands',BE:'Belgium'};
 const metrics=[['cold','Coldest temperature','temperature',false],['warm','Warmest temperature','temperature',true],['wind','Strongest sustained wind','wind',true],['gust','Strongest wind gust','wind',true],['rain','Most precipitation · 24 h','rain',true],['snow','Deepest snow','snow',true]];
 const valid=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
 function recent(t,now,age){return valid(t,0,now)&&now-t<=age;}
 function rows(data){return Array.isArray(data?.stations)?data.stations:[];}
 function inside(s,{country,bounds}){
  if(!s||!names[s.country]||typeof s.name!=='string'||!valid(s.lat,-85,85)||!valid(s.lon,-180,180))return false;
  if(country&&s.country.replace('UK','GB')!==country.replace('UK','GB'))return false;
  if(!bounds)return true;
  if(s.lat<bounds.south||s.lat>bounds.north)return false;
  const span=bounds.east-bounds.west;
  return span>=360||((s.lon-bounds.west)%360+360)%360<=span;
 }
 function latest(s,column,now,age,min,max){
  let best=null;
  for(const r of Array.isArray(s.rows)?s.rows:[])if(Array.isArray(r)&&recent(r[0],now,age)&&valid(r[column],min,max)&&(!best||r[0]>best.time))best={time:r[0],value:r[column]};
  return best;
 }
 function rain(s,now){
  const end=Math.floor(now/3600)*3600;
  if(!Array.isArray(s.times)||!Array.isArray(s.amounts)||s.times.length!==s.amounts.length)return null;
  const amounts=new Map(),duplicates=new Set();
  s.times.forEach((t,i)=>{if(amounts.has(t))duplicates.add(t);amounts.set(t,s.amounts[i]);});
  for(let offset=0;offset<=2;offset++){
   const time=end-offset*3600;
   const published=s.country==='IS'&&Array.isArray(s.accumulations)?s.accumulations.find(a=>a?.hours===24&&a.end===time&&valid(a.value,0,1000)):null;
   if(published)return {time,value:published.value};
   let total=0,complete=true;
   for(let hour=0;hour<24;hour++){const t=time-hour*3600,value=amounts.get(t);if(duplicates.has(t)||!valid(value,0,1000)){complete=false;break;}total+=value;}
   if(complete&&total<=1000)return {time,value:total};
  }
  return null;
 }
 function summarize(data,options={}){
  const now=options.now??Date.now()/1000,all={};
  for(const kind of ['cold','warm','wind','gust','rain','snow'])all[kind]=new Map();
  function add(kind,s,reading,snapshot){
   if(!reading)return;
   const source=snapshot?.sources?.[s.country],key=s.country+'|'+(s.code||s.lat+','+s.lon);
   const item={...reading,lat:s.lat,lon:s.lon,name:s.name,country:s.country,code:s.code,source:typeof s.source==='string'?s.source:source?.name||'Official weather service',period:source?.period||'',timeKind:source?.timeKind||'observation',timePrecision:s.timePrecision||'instant'};
   const previous=all[kind].get(key);if(!previous||item.time>previous.time)all[kind].set(key,item);
  }
  for(const s of rows(data.temperature))if(inside(s,options)){
   const r=latest(s,1,now,95*60,-90,60);add('cold',s,r,data.temperature);add('warm',s,r,data.temperature);
  }
  for(const s of rows(data.wind))if(inside(s,options)){
   add('wind',s,latest(s,1,now,3*3600,0,100),data.wind);add('gust',s,latest(s,2,now,3*3600,0,100),data.wind);
  }
  for(const s of rows(data.rain))if(inside(s,options))add('rain',s,rain(s,now),data.rain);
  for(const s of rows(data.snow))if(inside(s,options)&&recent(s.time,now,36*3600)&&!['trace','patchy'].includes(s.state)&&valid(s.depthCm,0,1500))add('snow',s,{time:s.time,value:s.depthCm},data.snow);
  return metrics.map(([id,label,unit,maximum])=>{
   const candidates=[...all[id].values()].sort((a,b)=>(maximum?b.value-a.value:a.value-b.value)||b.time-a.time||a.name.localeCompare(b.name));
   return {id,label,unit,count:candidates.length,winner:candidates[0]||null};
  });
 }
 return {summarize,names};
});
