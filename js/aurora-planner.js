if(!map.getPane('auroraPlannerPane')){map.createPane('auroraPlannerPane');map.getPane('auroraPlannerPane').style.zIndex='640';}
(function(){
  'use strict';
  const panel=document.getElementById('spaceWeatherSection'),D=window.NorthernAuroraPlannerData;
  if(!panel||!D||typeof map==='undefined')return;
  const $=id=>document.getElementById(id),section=document.createElement('section');
  section.className='section aurora-planner';section.setAttribute('aria-labelledby','auroraPlannerTitle');
  section.innerHTML=`<div class="space-section-title"><h3 id="auroraPlannerTitle"><label><input id="auroraPlannerOn" type="checkbox" aria-controls="auroraPlannerSettings" aria-expanded="false"> Aurora viewing planner</label></h3></div><div id="auroraPlannerSettings" hidden><div class="small">Your next 48 hours · nearby clearer skies</div>
    <form id="auroraPlannerSearch" class="aurora-planner-search" role="search"><label for="auroraPlannerInput">Choose a location</label><div><input id="auroraPlannerInput" type="search" placeholder="Town or city" autocomplete="off" role="combobox" aria-controls="auroraPlannerMatches" aria-expanded="false"><button type="submit">Search</button></div><ul id="auroraPlannerMatches" role="listbox" aria-label="Planner locations" hidden></ul></form>
    <div class="aurora-planner-actions"><button id="auroraPlannerPick" type="button" aria-pressed="false">Pick on map</button><button id="auroraPlannerGPS" type="button">Use my location</button></div>
    <div id="auroraPlannerLocation" class="small">Search for a place, pick a map point or use your location.</div>
    <label class="aurora-planner-radius" for="auroraPlannerRadius">Compare nearby points<select id="auroraPlannerRadius"><option value="0">This location only</option><option value="25">Within 25 km</option><option value="50" selected>Within 50 km</option><option value="100">Within 100 km</option></select></label>
    <div class="aurora-planner-modes" role="group" aria-label="Planner mode"><button id="auroraPlannerOutlook" type="button" aria-pressed="true">Next 48 hours</button><button id="auroraPlannerNow" type="button" aria-pressed="false">Go now</button></div>
    <button id="auroraPlannerRun" class="aurora-planner-run" type="button">Find best viewing window</button>
    <p id="auroraPlannerStatus" class="small" role="status" aria-live="polite">Uses darkness, forecast clouds and NOAA forecast activity.</p><div id="auroraPlannerCloudTimeline"></div><div id="auroraPlannerResults"></div>
    <details class="aurora-planner-info"><summary>How the planner works</summary><p>Compares two-hour windows at your location and eight surrounding map points. Natural Earth land boundaries and lakes exclude mapped water; if land verification fails, no viewing spots are recommended. Clouds use the nearest native 0.25° ECMWF grid point, with time interpolation between three-hour forecasts. Darkness is calculated locally; NOAA’s three-hour Kp forecast supplies the activity outlook.</p><p>Ratings are relative guidance, not a probability or a sighting guarantee. Magnetic latitude is approximated. Current OVATION and solar wind are short-term signals, not a forecast for the whole night. Mapped land is not a guarantee of public access or safe terrain: check access and a clear northern horizon. Light pollution, moonlight and terrain are not included.</p><p>Planning confidence uses lead time, cloud model age and cloud variability nearby and through time. It is capped at Moderate because only one cloud model is used; independent model agreement is not checked.</p><p>Go now checks the next hour using modelled clouds, darkness, fresh NOAA OVATION and solar wind/Bz. Live readings must be fresh; short-term signals are not carried into tomorrow’s outlook.</p></details></div>`;
  const daylight=document.getElementById('sunriseSunsetSection');daylight.after(section);
  const toggle=$('auroraPlannerOn'),settings=$('auroraPlannerSettings');
  L.DomEvent.disableClickPropagation(section);L.DomEvent.disableScrollPropagation(section);
  let point=null,picking=false,generation=0,marker=null,lastRun=0,running=false,mode='outlook';
  let meta=null,checked=0,metaPromise=null;
  const cache=new Map(),pending=new Map();
  function select(p){
    point={lat:p.lat,lon:D.longitude(p.lon),label:p.label||p.lat.toFixed(3)+'°, '+D.longitude(p.lon).toFixed(3)+'°'};
    generation++;running=false;lastRun=0;$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';picking=false;$('auroraPlannerPick').setAttribute('aria-pressed','false');
    $('auroraPlannerLocation').textContent=point.label;$('auroraPlannerStatus').textContent='Ready to compare viewing windows.';$('auroraPlannerResults').replaceChildren();$('auroraPlannerCloudTimeline').replaceChildren();
    if(marker){map.removeLayer(marker);marker=null;}
  }
  const search=window.NorthernForecastSearch?.attach({form:$('auroraPlannerSearch'),input:$('auroraPlannerInput'),results:$('auroraPlannerMatches'),status:$('auroraPlannerStatus'),onChoose:p=>{select(p);map.setView([p.lat,p.lon],Math.max(7,Math.min(10,map.getZoom())));}});
  $('auroraPlannerPick').addEventListener('click',()=>{picking=!picking;$('auroraPlannerPick').setAttribute('aria-pressed',String(picking));$('auroraPlannerStatus').textContent=picking?'Click a point on the map. Dragging will not choose a location.':'Map selection cancelled.';});
  let dragged=false;
  map.on('dragstart',()=>{dragged=true;});map.on('dragend',()=>setTimeout(()=>{dragged=false;},100));
  map.on('click',e=>{if(toggle.checked&&picking&&!dragged&&!panel.hidden&&e.latlng)select({lat:e.latlng.lat,lon:e.latlng.lng});});
  $('auroraPlannerGPS').addEventListener('click',()=>{
    if(!navigator.geolocation){$('auroraPlannerStatus').textContent='Location access is unavailable. Search for your town instead.';return;}
    const id=++generation;$('auroraPlannerStatus').textContent='Finding your location…';
    navigator.geolocation.getCurrentPosition(p=>{if(id!==generation||panel.hidden||!toggle.checked)return;select({lat:p.coords.latitude,lon:p.coords.longitude,label:'Your location'});map.setView([point.lat,point.lon],8);},()=>{if(id===generation)$('auroraPlannerStatus').textContent='Location unavailable. Search for a town or pick a map point.';},{timeout:10000,maximumAge:300000});
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
  function viewingPoint(p){
    if(marker)map.removeLayer(marker);
    marker=L.circleMarker([p.lat,p.lon],{pane:'auroraPlannerPane',radius:8,color:'#b7ffe0',fillColor:'#53cfaa',fillOpacity:.8,weight:2}).addTo(map);
    marker.bindTooltip(p.distance?p.distance+' km '+p.direction:point.label);map.setView([p.lat,p.lon],9);
  }
  function gridFor(grids,p){return grids.get(Math.min(11,Math.floor((D.longitude(p.lon)+180)/30)));}
  const altitude=(t,p)=>SunCalc.getPosition(new Date(t),p.lat,p.lon).altitude*180/Math.PI;
  function confidenceNode(c){
    const p=document.createElement('p');p.className='aurora-planner-confidence';p.textContent='Planning confidence: '+c.label;p.title=c.reason;
    const detail=document.createElement('small');detail.textContent=c.reason;p.appendChild(detail);return p;
  }
  function timeline(p,grids,snapshot,window=null){
    const container=$('auroraPlannerCloudTimeline');container.replaceChildren();const g=gridFor(grids,p);
    if(!g)return;
    const rows=D.cloudTimeline({grid:g,point:p,snapshot,altitude}),title=document.createElement('h4');title.textContent='Hourly cloud timeline';
    const location=document.createElement('p');location.className='small';location.textContent=(p.distance?p.distance+' km '+p.direction+' · '+p.lat.toFixed(3)+'°, '+p.lon.toFixed(3)+'°':point.label)+' · local time';
    const help=document.createElement('p');help.className='small';help.textContent='Lower bars = clearer skies. Green borders = dark sky. Tap an hour for details.';
    const strip=document.createElement('div');strip.className='aurora-cloud-strip';strip.setAttribute('role','group');strip.setAttribute('aria-label','Hourly cloud forecast');
    const detail=document.createElement('p');detail.className='aurora-cloud-detail';detail.setAttribute('aria-live','polite');
    const format=new Intl.DateTimeFormat(undefined,{timeZone:tzlookup(p.lat,p.lon),hour:'2-digit',minute:'2-digit',hour12:false});
    let selected=null;
    function choose(row,button){
      selected?.setAttribute('aria-pressed','false');selected=button;button.setAttribute('aria-pressed','true');
      const c=D.planningConfidence({grid:g,point:p,time:row.time,snapshot});
      detail.textContent=time(row.time,p)+' · '+(row.cloud===null?'Cloud unavailable':Math.round(row.cloud)+'% cloud')+' · '+(row.dark?'Dark sky':'Daylight / twilight')+' · '+(row.kp===null?'Activity unavailable':'forecast Kp '+row.kp.toFixed(1))+' · planning confidence '+c.label;
    }
    for(const [i,row] of rows.entries()){
      const button=document.createElement('button');button.type='button';button.className='aurora-cloud-hour'+(row.dark?' is-dark':'')+(window&&row.time>=window.start&&row.time<window.end?' in-window':'');button.setAttribute('aria-pressed','false');
      button.setAttribute('aria-label',time(row.time,p)+' · '+(row.cloud===null?'cloud unavailable':Math.round(row.cloud)+' percent cloud')+' · '+(row.dark?'dark sky':'daylight or twilight'));
      const value=document.createElement('span');value.className='aurora-cloud-value';value.textContent=row.cloud===null?'—':Math.round(row.cloud)+'%';
      const bar=document.createElement('i');bar.style.height=(row.cloud===null?2:Math.max(2,row.cloud*.4))+'px';
      const clock=document.createElement('span');clock.className='aurora-cloud-clock';clock.textContent=i%3===0?format.format(new Date(row.time)):'';
      button.append(value,bar,clock);button.addEventListener('click',()=>choose(row,button));strip.appendChild(button);
      if((window&&row.time===window.start)||(!window&&i===0))choose(row,button);
    }
    container.append(title,location,help,strip,detail);
  }
  function showNow(points,grids,m,snapshot){
    const results=points.map(p=>D.goNow({point:p,grid:gridFor(grids,p),snapshot,altitude}));
    results.sort((a,b)=>b.score-a.score||a.point.distance-b.point.distance);
    const best=results[0],output=$('auroraPlannerResults');output.replaceChildren();
    $('auroraPlannerStatus').textContent='Go now · next-hour check at a verified land point. Live signals are not a forecast for the whole night.';
    const card=document.createElement('article');card.className='aurora-planner-window aurora-now-window';
    const title=document.createElement('strong');title.textContent=best.label;
    const location=document.createElement('p');location.textContent=best.point.distance?best.point.distance+' km '+best.point.direction+' · '+best.point.lat.toFixed(3)+'°, '+best.point.lon.toFixed(3)+'°':point.label;
    const reason=document.createElement('p');reason.textContent=best.reason;
    const facts=document.createElement('p');facts.textContent=(best.sun<-12?'Dark sky':'Daylight / twilight')+' · '+(best.cloud===null?'Cloud forecast unavailable':Math.round(best.cloud)+'% forecast cloud during the next hour');
    const live=document.createElement('p');live.textContent='Regional aurora signal: '+(!best.spaceFresh||best.signal===null?'Unavailable / stale':best.signal<10?'Weak':best.signal<30?'Present':'Active')+' · '+(best.windFresh?'Bz '+best.bz.toFixed(1)+' nT · '+Math.round(best.speed)+' km/s':'Solar wind / Bz unavailable or stale')+' · '+best.trend;
    const confidence=document.createElement('p');confidence.className='small';confidence.textContent=best.fresh?'Fresh live inputs; cloud cover remains a model forecast.':'Live-data confidence is limited until all required inputs are fresh.';
    const button=document.createElement('button');button.type='button';button.textContent='Show live viewing point';button.addEventListener('click',()=>viewingPoint(best.point));
    card.append(title,location,reason,facts,live,confidence,button);output.append(card);timeline(best.point,grids,snapshot);
    const update=document.createElement('p');update.className='small';update.textContent='Checked '+time(Date.now(),best.point)+' · cloud model run '+time(Date.parse(m.reference_time),best.point)+'. Live mode refreshes every two minutes while visible.';output.append(update);
  }
  function show(result,m,snapshot,grids,points){
    const output=$('auroraPlannerResults');output.replaceChildren();
    if(!result.windows.length){
      if(points?.length)timeline(points[0],grids,snapshot);
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
        marker=L.circleMarker([w.point.lat,w.point.lon],{pane:'auroraPlannerPane',radius:8,color:'#b7ffe0',fillColor:'#53cfaa',fillOpacity:.8,weight:2}).addTo(map);
        marker.bindTooltip((w.point.distance?w.point.distance+' km '+w.point.direction:point.label)+' · '+w.label);map.setView([w.point.lat,w.point.lon],9);
      });
      const confidence=D.planningConfidence({grid:gridFor(grids,w.point),point:w.point,time:w.start+3600000,snapshot});
      card.append(title,date,location,facts,confidenceNode(confidence),button);output.append(card);
    });
    timeline(result.windows[0].point,grids,snapshot,result.windows[0]);
    const note=document.createElement('p');note.className='small';note.textContent='Cloud model run '+time(Date.parse(m.reference_time),point)+'. NOAA activity updated '+time(snapshot.kpForecast.fetchedAt*1000,point)+'. Ratings compare available conditions; even the best window may have weak aurora activity.';output.append(note);
  }
  async function run(){
    if(!toggle.checked)return;
    if(!point){$('auroraPlannerStatus').textContent='Choose a location using search, Pick on map or Use my location first.';return;}
    const chosen={...point},id=++generation;lastRun=Date.now();running=true;
    $('auroraPlannerStatus').textContent='Verifying land locations and loading forecast guidance…';
    $('auroraPlannerRun').textContent='Comparing…';$('auroraPlannerResults').replaceChildren();$('auroraPlannerCloudTimeline').replaceChildren();
    try{
      if(chosen.lat<35)throw Error('The planner currently covers 35–90°N. Choose a northern location.');
      const isLand=await window.NorthernAuroraLand.load();
      const points=D.nearby(chosen,Number($('auroraPlannerRadius').value)).filter(p=>p.lat>=35&&isLand(p));
      if(!points.length)throw Error('No verified land points in this selection. Choose a land location or increase the comparison radius.');
      const [m,snapshot]=await Promise.all([metadata(),window.NorthernSpaceWeather?.getSnapshot?window.NorthernSpaceWeather.getSnapshot(mode==='now'):json('data/space-weather.json?v='+Math.floor(Date.now()/120000),{cache:'no-cache'})]);
      if(Date.now()-Date.parse(m.reference_time)>24*3600000)throw Error('Cloud forecast is stale. The planner will resume after the next successful update.');
      const bands=[...new Set(points.map(p=>Math.min(11,Math.floor((p.lon+180)/30))))];
      const loaded=await Promise.all(bands.map(async band=>[band,await grid(m,band)]));
      const grids=new Map(loaded);
      if(id!==generation||panel.hidden)return;
      if(mode==='now')showNow(points,grids,m,snapshot);
      else show(D.rank({points,grids,snapshot,altitude}),m,snapshot,grids,points);
    }catch(error){if(id===generation&&!panel.hidden)$('auroraPlannerStatus').textContent=error.message||'Planner unavailable. Try again shortly.';}
    finally{if(id===generation){running=false;$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';}}
  }
  function stopPlanner(){generation++;running=false;picking=false;search?.cancel();$('auroraPlannerPick').setAttribute('aria-pressed','false');$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';if(marker){map.removeLayer(marker);marker=null;}}
  toggle.addEventListener('change',()=>{settings.hidden=!toggle.checked;toggle.setAttribute('aria-expanded',String(toggle.checked));if(!toggle.checked)stopPlanner();else if(point&&lastRun)run();});
  $('auroraPlannerRun').addEventListener('click',run);
  function setMode(next){mode=next;generation++;running=false;$('auroraPlannerOutlook').setAttribute('aria-pressed',String(mode==='outlook'));$('auroraPlannerNow').setAttribute('aria-pressed',String(mode==='now'));$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';$('auroraPlannerResults').replaceChildren();$('auroraPlannerCloudTimeline').replaceChildren();if(point)run();else $('auroraPlannerStatus').textContent='Choose a location first.';}
  $('auroraPlannerOutlook').addEventListener('click',()=>setMode('outlook'));$('auroraPlannerNow').addEventListener('click',()=>setMode('now'));
  $('auroraPlannerRadius').addEventListener('change',()=>{generation++;running=false;lastRun=0;$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';$('auroraPlannerResults').replaceChildren();$('auroraPlannerCloudTimeline').replaceChildren();$('auroraPlannerStatus').textContent='Comparison radius changed. Find a new viewing window.';});
  new MutationObserver(()=>{if(panel.hidden){generation++;running=false;picking=false;search?.cancel();$('auroraPlannerPick').setAttribute('aria-pressed','false');$('auroraPlannerRun').textContent=mode==='now'?'Check conditions now':'Find best viewing window';}}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  $('clearLayers')?.addEventListener('click',()=>{toggle.checked=false;settings.hidden=true;toggle.setAttribute('aria-expanded','false');stopPlanner();});
  setInterval(()=>{if(toggle.checked&&lastRun&&!running&&!document.hidden&&!panel.hidden&&Date.now()-lastRun>=(mode==='now'?2:15)*60000)run();},60000);
})();
