// Download shared snapshots only while the user opens Weather extremes.
(() => {
 'use strict';
 const section=document.getElementById('weatherExtremes'),list=document.getElementById('weatherExtremesList'),status=document.getElementById('weatherExtremesStatus'),scope=document.getElementById('weatherExtremesScope'),refresh=document.getElementById('weatherExtremesRefresh');
 if(!section)return;
 const paths={temperature:'official-temperature',wind:'official-wind',rain:'official-rainfall',snow:'official-snow-depth'};
 const snapshots={},failed=new Set();let pending=null,checkedAt=0,results=[];
 const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
 for(const [code,name] of Object.entries(WeatherExtremesData.names).filter(([code])=>code!=='UK').sort((a,b)=>a[1].localeCompare(b[1]))){const option=el('option',name);option.value=code;scope.append(option);}
 function active(){return section.open&&!document.getElementById('warningSection').hidden&&!document.hidden;}
 function stamp(r){
  const date=new Date(r.time*1000);
  if(r.timePrecision==='day')return date.toLocaleDateString(undefined,{day:'numeric',month:'short',timeZone:'UTC'})+' · observation day';
  return date.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 }
 function value(metric){
  const n=metric.winner.value;
  if(metric.unit==='temperature')return globalThis.WeatherUnits?.temperature(n)??n.toFixed(1)+'°C';
  if(metric.unit==='wind')return globalThis.WeatherUnits?.wind(n)??n.toFixed(1)+' m/s';
  return n.toFixed(1)+(metric.unit==='rain'?' mm':' cm');
 }
 function locate(metric){
  const r=metric.winner,content=el('div',undefined,'weather-extremes-popup');
  content.append(el('strong',metric.label),el('div',value(metric)),el('div',r.name+' · '+WeatherExtremesData.names[r.country]),el('div',stamp(r)),el('div',r.source));
  if(r.period)content.append(el('p',r.period));
  if(metric.id==='rain')content.append(el('p','24-hour period ending at the displayed time.'));
  map.setView([r.lat,r.lon],Math.max(7,map.getZoom()));
  L.popup({autoPan:false}).setLatLng([r.lat,r.lon]).setContent(content).openOn(map);
 }
 function render(){
  const options={country:globalThis.NorthernCountryFocus?.current()?.iso2||(scope.value==='all'||scope.value==='view'?null:scope.value)};
  if(scope.value==='view'){const b=map.getBounds();options.bounds={south:b.getSouth(),north:b.getNorth(),west:b.getWest(),east:b.getEast()};}
  results=WeatherExtremesData.summarize(snapshots,options);list.replaceChildren();
  for(const metric of results){
   const r=metric.winner,card=el(r?'button':'div',undefined,'weather-extreme-card');
   if(r){card.type='button';card.addEventListener('click',()=>locate(metric));card.title='Locate '+r.name+' on the map';}
   const heading=el('span',undefined,'weather-extreme-heading');heading.append(el('span',metric.label),el('strong',r?value(metric):'Unavailable'));card.append(heading);
   if(r){
    card.append(el('span',r.name+' · '+WeatherExtremesData.names[r.country],'weather-extreme-place'));
    card.append(el('span',(metric.id==='rain'?'24 h ending ':r.timeKind==='feed'?'Feed time ':'Observed ')+stamp(r),'weather-extreme-meta'));
    card.append(el('span',r.source,'weather-extreme-meta'));
    if(metric.unit==='wind'&&r.period)card.append(el('span',r.period,'weather-extreme-meta'));
    card.append(el('span',metric.count.toLocaleString()+' reporting stations · tap to locate','weather-extreme-meta'));
   }else card.append(el('span',checkedAt?'No recent complete measurements in this area.':'Open this section to load observations.','weather-extreme-meta'));
   list.append(card);
  }
  if(!pending)status.textContent=checkedAt?(failed.size?failed.size+' of 4 feeds could not refresh. Available readings retain their observation times.':'Checked '+new Date(checkedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})+' · refreshes every 5 minutes while open.'):'Expand to load current observations.';
 }
 async function load(force=false){
  if(pending)return pending;if(!force&&Date.now()-checkedAt<5*60000){render();return;}
  status.textContent='Loading official observations…';refresh.disabled=true;
  pending=(async()=>{
   await Promise.all(Object.entries(paths).map(async([kind,path])=>{
    try{
     const response=await fetch('data/'+path+'.json',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
     if(!response.ok)throw Error('Snapshot unavailable');const data=await response.json();
     if(!Array.isArray(data.stations))throw Error('Invalid observations');snapshots[kind]=data;failed.delete(kind);
    }catch{failed.add(kind);}
   }));
   checkedAt=Date.now();
  })().finally(()=>{pending=null;refresh.disabled=false;render();});return pending;
 }
 section.addEventListener('toggle',()=>{if(active())load();});
 document.addEventListener('country-focus-change',()=>{scope.disabled=!!globalThis.NorthernCountryFocus?.active();render();});
 scope.addEventListener('change',render);refresh.addEventListener('click',()=>load(true));
 document.addEventListener('weather-units-change',()=>{if(section.open)render();});
 document.addEventListener('visibilitychange',()=>{if(active())load();});
 new MutationObserver(()=>{if(active())load();}).observe(document.getElementById('warningSection'),{attributes:true,attributeFilter:['hidden']});
 map.on('moveend',()=>{if(active()&&scope.value==='view')render();});
 setInterval(()=>{if(active())load();},60000);
})();
