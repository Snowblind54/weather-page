(function(){
  'use strict';
  const panel=document.getElementById('spaceWeatherSection'),D=window.NorthernAuroraPlannerData;
  if(!panel||!D||typeof map==='undefined')return;
  const $=id=>document.getElementById(id),section=document.createElement('section');
  section.className='section aurora-planner';section.setAttribute('aria-labelledby','auroraPlannerTitle');
  section.innerHTML=`<div class="space-section-title"><div><h3 id="auroraPlannerTitle">Aurora viewing planner</h3><div class="small">Your next 48 hours · nearby clearer skies</div></div></div>
    <form id="auroraPlannerSearch" class="aurora-planner-search" role="search"><label for="auroraPlannerInput">Choose a location</label><div><input id="auroraPlannerInput" type="search" placeholder="Town or city" autocomplete="off" role="combobox" aria-controls="auroraPlannerMatches" aria-expanded="false"><button type="submit">Search</button></div><ul id="auroraPlannerMatches" role="listbox" aria-label="Planner locations" hidden></ul></form>
    <div class="aurora-planner-actions"><button id="auroraPlannerCentre" type="button">Use map centre</button><button id="auroraPlannerPick" type="button" aria-pressed="false">Pick on map</button><button id="auroraPlannerGPS" type="button">Use my location</button></div>
    <div id="auroraPlannerLocation" class="small">Choose a place or use the map centre.</div>
    <label class="aurora-planner-radius" for="auroraPlannerRadius">Compare nearby points<select id="auroraPlannerRadius"><option value="0">This location only</option><option value="25">Within 25 km</option><option value="50" selected>Within 50 km</option><option value="100">Within 100 km</option></select></label>
    <button id="auroraPlannerRun" class="aurora-planner-run" type="button">Find best viewing window</button>
    <p id="auroraPlannerStatus" class="small" role="status" aria-live="polite">Uses darkness, forecast clouds and NOAA forecast activity.</p><div id="auroraPlannerResults"></div>
    <details class="aurora-planner-info"><summary>How the planner works</summary><p>Compares two-hour windows at your location and eight surrounding map points. Clouds use the nearest native 0.25° ECMWF grid point, with time interpolation between three-hour forecasts. Darkness is calculated locally; NOAA’s three-hour Kp forecast supplies the activity outlook.</p><p>Ratings are relative guidance, not a probability or a sighting guarantee. Magnetic latitude is approximated. Current OVATION and solar wind are short-term signals, not a forecast for the whole night. Nearby points may be offshore or inaccessible: check land, access and a clear northern horizon. Light pollution, moonlight and terrain are not included.</p></details>`;
  const layers=panel.querySelector('.space-layer-section');layers.after(section);
  L.DomEvent.disableClickPropagation(section);L.DomEvent.disableScrollPropagation(section);
  let point=null,picking=false,generation=0,marker=null,lastRun=0,running=false;
  let meta=null,checked=0,metaPromise=null;
  const cache=new Map(),pending=new Map();
  function select(p){
    point={lat:p.lat,lon:D.longitude(p.lon),label:p.label||p.lat.toFixed(3)+'°, '+D.longitude(p.lon).toFixed(3)+'°'};
    generation++;running=false;$('auroraPlannerRun').textContent='Find best viewing window';picking=false;$('auroraPlannerPick').setAttribute('aria-pressed','false');
    $('auroraPlannerLocation').textContent=point.label;$('auroraPlannerStatus').textContent='Ready to compare viewing windows.';$('auroraPlannerResults').replaceChildren();
    if(marker){map.removeLayer(marker);marker=null;}
  }
  const search=window.NorthernForecastSearch?.attach({form:$('auroraPlannerSearch'),input:$('auroraPlannerInput'),results:$('auroraPlannerMatches'),status:$('auroraPlannerStatus'),onChoose:p=>{select(p);map.setView([p.lat,p.lon],Math.max(7,Math.min(10,map.getZoom())));}});
  $('auroraPlannerCentre').addEventListener('click',()=>{const p=map.getCenter();select({lat:p.lat,lon:p.lng});});
  $('auroraPlannerPick').addEventListener('click',()=>{picking=!picking;$('auroraPlannerPick').setAttribute('aria-pressed',String(picking));$('auroraPlannerStatus').textContent=picking?'Click a point on the map. Dragging will not choose a location.':'Map selection cancelled.';});
  let dragged=false;
  map.on('dragstart',()=>{dragged=true;});map.on('dragend',()=>setTimeout(()=>{dragged=false;},100));
  map.on('click',e=>{if(picking&&!dragged&&!panel.hidden&&e.latlng)select({lat:e.latlng.lat,lon:e.latlng.lng});});
  $('auroraPlannerGPS').addEventListener('click',()=>{
    if(!navigator.geolocation){$('auroraPlannerStatus').textContent='Location access is unavailable. Search for your town instead.';return;}
    const id=++generation;$('auroraPlannerStatus').textContent='Finding your location…';
    navigator.geolocation.getCurrentPosition(p=>{if(id!==generation||panel.hidden)return;select({lat:p.coords.latitude,lon:p.coords.longitude,label:'Your location'});map.setView([point.lat,point.lon],8);},()=>{if(id===generation)$('auroraPlannerStatus').textContent='Location unavailable. Search for a town or use the map centre.';},{timeout:10000,maximumAge:300000});
  });
  async function json(path,options={}){
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
    try{const response=await fetch(path,{...options,signal:abort.signal});if(!response.ok)throw Error('Shared forecast HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}
  }
  async function metadata(){
    if(meta&&Date.now()-checked<5*60000)return meta;
    if(!metaPromise)metaPromise=(async()=>{
      const next=D.validateManifest(await json('data/aurora-planner.json?v='+Math.floor(Date.now()/300000),{cache:'no-cache'}));
      if(meta?.reference_time!==next.reference_time)cache.clear();meta=next;checked=Date.now();return next;
    })().finally(()=>{metaPromise=null;});
    return metaPromise;
  }
  async function grid(m,band){
    const path=m.grids[band].path;if(cache.has(path)){const g=cache.get(path);cache.delete(path);cache.set(path,g);return g;}
    if(!pending.has(path))pending.set(path,(async()=>{
      const value=D.decodeGrid(await json(path,{cache:'force-cache'}),m,band);
      if(meta?.reference_time===m.reference_time){cache.set(path,value);while(cache.size>3)cache.delete(cache.keys().next().value);}
      return value;
    })().finally(()=>pending.delete(path)));
    return pending.get(path);
  }
  function time(value,p){
    const zone=tzlookup(p.lat,p.lon);
    return new Intl.DateTimeFormat(undefined,{timeZone:zone,weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'}).format(new Date(value));
  }
  function show(result,m,snapshot){
    const output=$('auroraPlannerResults');output.replaceChildren();
    if(!result.windows.length){
      $('auroraPlannerStatus').textContent=!result.diagnostics.darkHours?'No sufficiently dark two-hour window in the next 48 hours.':!result.diagnostics.cloudHours?'Cloud forecasts do not cover a dark window yet.':'NOAA activity forecasts are missing or stale for the dark windows. Try again after the next update.';return;
    }
    $('auroraPlannerStatus').textContent='Best available windows · '+tzlookup(point.lat,point.lon)+' local time. Nearby points use their own local time.';
    result.windows.forEach((w,i)=>{
      const card=document.createElement('article');card.className='aurora-planner-window';
      const title=document.createElement('strong');title.textContent=(i?'Alternative':'Best available')+' · '+w.label;
      const date=document.createElement('div');date.className='aurora-planner-time';date.textContent=time(w.start,w.point)+' → '+time(w.end,w.point);
      const location=document.createElement('p');location.textContent=w.point.distance?w.point.distance+' km '+w.point.direction+' · '+w.point.lat.toFixed(3)+'°, '+w.point.lon.toFixed(3)+'°':point.label;
      const facts=document.createElement('p');facts.className='aurora-planner-facts';facts.textContent='Dark sky · '+Math.round(w.cloud)+'% cloud · forecast Kp '+w.kp.toFixed(1);
      const button=document.createElement('button');button.type='button';button.textContent='Show viewing point';button.addEventListener('click',()=>{
        if(marker)map.removeLayer(marker);
        marker=L.circleMarker([w.point.lat,w.point.lon],{radius:8,color:'#b7ffe0',fillColor:'#53cfaa',fillOpacity:.8,weight:2}).addTo(map);
        marker.bindTooltip((w.point.distance?w.point.distance+' km '+w.point.direction:point.label)+' · '+w.label);map.setView([w.point.lat,w.point.lon],9);
      });
      card.append(title,date,location,facts,button);output.append(card);
    });
    const note=document.createElement('p');note.className='small';note.textContent='Cloud model run '+time(Date.parse(m.reference_time),point)+'. NOAA activity updated '+time(snapshot.kpForecast.fetchedAt*1000,point)+'. Ratings compare available conditions; even the best window may have weak aurora activity.';output.append(note);
  }
  async function run(){
    if(!point){const p=map.getCenter();select({lat:p.lat,lon:p.lng});}
    const chosen={...point},id=++generation;lastRun=Date.now();running=true;
    $('auroraPlannerStatus').textContent='Comparing darkness, forecast clouds and aurora activity…';
    $('auroraPlannerRun').textContent='Comparing…';$('auroraPlannerResults').replaceChildren();
    try{
      if(chosen.lat<35)throw Error('The planner currently covers 35–90°N. Choose a northern location.');
      const points=D.nearby(chosen,Number($('auroraPlannerRadius').value)).filter(p=>p.lat>=35);
      const [m,snapshot]=await Promise.all([metadata(),window.NorthernSpaceWeather?.getSnapshot?window.NorthernSpaceWeather.getSnapshot():json('data/space-weather.json?v='+Math.floor(Date.now()/120000),{cache:'no-cache'})]);
      if(Date.now()-Date.parse(m.reference_time)>24*3600000)throw Error('Cloud forecast is stale. The planner will resume after the next successful update.');
      const bands=[...new Set(points.map(p=>Math.min(11,Math.floor((p.lon+180)/30))))];
      const loaded=await Promise.all(bands.map(async band=>[band,await grid(m,band)]));
      const result=D.rank({points,grids:new Map(loaded),snapshot,altitude:(t,p)=>SunCalc.getPosition(new Date(t),p.lat,p.lon).altitude*180/Math.PI});
      if(id!==generation||panel.hidden)return;show(result,m,snapshot);
    }catch(error){if(id===generation&&!panel.hidden)$('auroraPlannerStatus').textContent=error.message||'Planner unavailable. Try again shortly.';}
    finally{if(id===generation){running=false;$('auroraPlannerRun').textContent='Find best viewing window';}}
  }
  $('auroraPlannerRun').addEventListener('click',run);
  $('auroraPlannerRadius').addEventListener('change',()=>{generation++;running=false;$('auroraPlannerRun').textContent='Find best viewing window';$('auroraPlannerResults').replaceChildren();$('auroraPlannerStatus').textContent='Comparison radius changed. Find a new viewing window.';});
  new MutationObserver(()=>{if(panel.hidden){generation++;running=false;picking=false;search?.cancel();$('auroraPlannerPick').setAttribute('aria-pressed','false');$('auroraPlannerRun').textContent='Find best viewing window';}}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  $('clearLayers')?.addEventListener('click',()=>{if(marker){map.removeLayer(marker);marker=null;}picking=false;$('auroraPlannerPick').setAttribute('aria-pressed','false');});
  setInterval(()=>{if(lastRun&&!running&&!document.hidden&&!panel.hidden&&Date.now()-lastRun>=15*60000)run();},60000);
})();
