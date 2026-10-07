// One viewport-sized WMS image per selected time; no off-screen tile downloads.
(function(){
  const panel=$('forecastSection');if(!panel)return;
  const D=ForecastMapData;
  const controls=document.createElement('div');controls.className='forecast-map-controls';
  controls.innerHTML=`<label class="label" for="forecastMapLayer">Forecast map layer</label><select id="forecastMapLayer"><option value="temperature">Temperature</option><option value="rain">Rain / snow (next hour)</option><option value="wind">Sustained wind</option><option value="gusts">Wind gusts</option><option value="clouds">Cloud cover</option><option value="off">Location forecast only</option></select><div class="forecast-map-opacity"><label for="forecastMapOpacity">Map opacity</label><output id="forecastMapOpacityValue">55%</output></div><input id="forecastMapOpacity" type="range" min="10" max="90" step="5" value="55" aria-label="Forecast map opacity"><div id="forecastMapLegend" hidden><div id="forecastMapLegendTitle" class="label"></div><img id="forecastMapColorbar" alt="Forecast colour scale" width="256" height="18"><div id="forecastMapLegendTicks"></div><div id="forecastMapVisibleTime" class="forecast-note"></div></div><div id="forecastMapStatus" class="status" role="status" aria-live="polite">Open Forecast to load the Nordic forecast map.</div><p class="forecast-note">MET Nordic · MEPS forecasts downscaled to a 1 km grid. Covers the Nordics and parts of the Baltics; Iceland is outside this grid. Map forecasts extend about 58–64 hours from the model cycle. Other weather overlays return when you close Forecast or choose location forecast only.</p>`;
  $('forecastLocation').before(controls);
  const dock=document.createElement('div');dock.className='forecast-map-dock';dock.hidden=true;
  dock.setAttribute('aria-label','Forecast map timeline');
  dock.innerHTML=`<div class="forecast-map-dock-heading"><strong>Forecast map</strong><time id="forecastMapTime"></time><button id="forecastMapPrevious" type="button" aria-label="Previous forecast hour">←</button><button id="forecastMapNext" type="button" aria-label="Next forecast hour">→</button></div><input id="forecastMapTimeline" type="range" min="0" max="0" value="0" step="1" aria-label="Forecast map time" aria-describedby="forecastMapTime"><div class="forecast-map-range"><span id="forecastMapStart"></span><span id="forecastMapEnd"></span></div><div id="forecastMapCycle" class="forecast-note"></div>`;
  document.body.append(dock);L.DomEvent.disableClickPropagation(dock);L.DomEvent.disableScrollPropagation(dock);
  map.createPane('forecastModel');map.getPane('forecastModel').style.zIndex='430';map.getPane('forecastModel').style.pointerEvents='none';
  let meta=null,metaPromise=null,metaChecked=0,selectedTime=null,generation=0,overlay=null,visibleTime=null,visibleUrl=null,renderTimer=null;
  const cache=new Map(),pending=new Map();
  const active=()=>!panel.hidden&&$('forecastMapLayer').value!=='off';
  const date=t=>new Date(t).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  function status(s,bad=false){$('forecastMapStatus').textContent=s;$('forecastMapStatus').className='status'+(bad?' bad':'');}
  function clearOverlay(){if(overlay)map.removeLayer(overlay);overlay=null;visibleTime=null;visibleUrl=null;$('forecastMapLegend').hidden=true;}
  function syncView(){document.body.classList.toggle('forecast-model-view',active());$('nav-forecastSection').classList.toggle('layer-active',active());dock.hidden=!active();}
  async function metadata(){
    if(meta&&Date.now()-metaChecked<15*60000)return meta;
    if(metaPromise)return metaPromise;
    metaPromise=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),20000);
      try{
        const response=await fetch('data/forecast-map.json?v='+Math.floor(Date.now()/900000),{signal:abort.signal,cache:'no-cache'});
        if(!response.ok)throw Error('Forecast map index unavailable');
        const next=await response.json();
        if(!/^https:\/\/thredds\.met\.no\/thredds\/wms\/metpplatest\/met_forecast_1_0km_nordic_\d{8}T\d{2}Z\.nc$/.test(next.endpoint)||!Array.isArray(next.bounds)||next.bounds.length!==4||!next.bounds.every(Number.isFinite))throw Error('Invalid map index');
        const raw=D.expandTimes(next.time_dimension),times=D.availableTimes(raw);
        if(!times.length||!Number.isFinite(Date.parse(next.reference_time)))throw Error('No current forecast grid available');
        for(const [kind,l] of Object.entries(D.layers))if(next.layers?.[kind]&&next.layers[kind]!==l.name)throw Error('Unexpected forecast variable');
        const followCurrent=meta&&selectedTime===meta.times[0];
        meta={...next,times};metaChecked=Date.now();
        if(followCurrent&&selectedTime!==times[0]){selectedTime=times[0];document.dispatchEvent(new CustomEvent('forecast-map-time',{detail:{time:selectedTime}}));}
        return meta;
      }finally{clearTimeout(timer);}
    })().catch(error=>{metaChecked=Date.now()-13*60000;if(meta&&D.availableTimes(D.expandTimes(meta.time_dimension)).length){console.warn(error);return meta;}throw error;}).finally(()=>{metaPromise=null;});
    return metaPromise;
  }
  function updateTimeline(){
    if(!meta)return;
    if(selectedTime===null)selectedTime=meta.times[0];
    const index=meta.times.reduce((best,t,i)=>Math.abs(t-selectedTime)<Math.abs(meta.times[best]-selectedTime)?i:best,0);
    $('forecastMapTimeline').max=String(meta.times.length-1);$('forecastMapTimeline').value=String(index);
    $('forecastMapTime').textContent=date(selectedTime);$('forecastMapTime').dateTime=new Date(selectedTime).toISOString();
    $('forecastMapStart').textContent=date(meta.times[0]);$('forecastMapEnd').textContent=date(meta.times.at(-1));
    $('forecastMapPrevious').disabled=index===0;$('forecastMapNext').disabled=index===meta.times.length-1;
    const older=Date.now()-Date.parse(meta.reference_time)>3*3600000;
    $('forecastMapCycle').textContent='MET Nordic cycle '+date(Date.parse(meta.reference_time))+(older?' · older cycle':'')+' · hourly forecast';
    for(const option of $('forecastMapLayer').options)option.disabled=option.value!=='off'&&!meta.layers[option.value];
  }
  function image(url){
    if(cache.has(url)){const img=cache.get(url);cache.delete(url);cache.set(url,img);return Promise.resolve(img);}
    if(pending.has(url))return pending.get(url);
    const work=new Promise((resolve,reject)=>{
      const img=new Image();img.referrerPolicy='no-referrer-when-downgrade';
      const timer=setTimeout(()=>{img.onload=img.onerror=null;img.src='';reject(Error('Forecast image timed out'));},25000);
      img.onload=()=>{clearTimeout(timer);img.onload=img.onerror=null;cache.set(url,img);while(cache.size>8)cache.delete(cache.keys().next().value);resolve(img);};
      img.onerror=()=>{clearTimeout(timer);img.onload=img.onerror=null;reject(Error('Forecast image unavailable'));};img.src=url;
    }).finally(()=>pending.delete(url));pending.set(url,work);return work;
  }
  function legend(kind){
    const l=D.layers[kind];$('forecastMapLegendTitle').textContent=l.label+' · '+l.unit;
    $('forecastMapColorbar').src=D.legendUrl(meta.endpoint,kind);
    $('forecastMapLegendTicks').replaceChildren(...l.ticks.map(value=>{const e=document.createElement('span');e.textContent=value;return e;}));
    $('forecastMapVisibleTime').textContent=kind==='rain'?'Map total for '+date(visibleTime)+' – '+date(visibleTime+3600000)+' (liquid-water equivalent).':'Map valid '+date(visibleTime);
    $('forecastMapLegend').hidden=false;
  }
  async function render(){
    const id=++generation;syncView();if(!active()){clearOverlay();return;}
    const kind=$('forecastMapLayer').value;
    status(meta?'Updating forecast map…':'Loading forecast map availability…');
    try{
      await metadata();if(id!==generation||!active())return;updateTimeline();
      if(!meta.times.includes(selectedTime)){clearOverlay();status('No map grid for this time. Use the forecast map timeline below; location forecasts extend further.',true);return;}
      if(!meta.layers[kind])throw Error('This forecast map variable is unavailable');
      const bounds=map.getBounds();
      if(bounds.getEast()<meta.bounds[0]||bounds.getWest()>meta.bounds[2]||bounds.getNorth()<meta.bounds[1]||bounds.getSouth()>meta.bounds[3]){clearOverlay();status('This view is outside the Nordic forecast grid. Location forecasts remain available.');return;}
      const south=Math.max(-85.05112878,bounds.getSouth()),north=Math.min(85.05112878,bounds.getNorth());
      const sw=L.CRS.EPSG3857.project(L.latLng(south,bounds.getWest())),ne=L.CRS.EPSG3857.project(L.latLng(north,bounds.getEast()));
      const size=map.getSize(),url=D.mapUrl(meta.endpoint,kind,selectedTime,[sw.x,sw.y,ne.x,ne.y],size.x,size.y);
      if(overlay&&visibleUrl===url){overlay.setOpacity(Number($('forecastMapOpacity').value)/100);legend(kind);status('Forecast map ready · cached image.');return;}
      status(visibleTime!==null?'Loading forecast map… Previous image valid '+date(visibleTime)+'.':'Loading forecast map image…');
      const img=await image(url);if(id!==generation||!active())return;
      img.dataset.forecastTime=new Date(selectedTime).toISOString();img.dataset.forecastLayer=kind;
      const next=L.imageOverlay(img,[[south,bounds.getWest()],[north,bounds.getEast()]],{pane:'forecastModel',opacity:Number($('forecastMapOpacity').value)/100,interactive:false,attribution:'Forecast © <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway</a> · CC BY 4.0'}).addTo(map);
      if(overlay)map.removeLayer(overlay);overlay=next;visibleTime=selectedTime;visibleUrl=url;legend(kind);
      status('Forecast map ready · '+D.layers[kind].label+' · '+date(visibleTime));
    }catch(error){if(id===generation&&active()){clearOverlay();status('Forecast map unavailable. Location forecasts still work; retry using Check for updates.',true);console.warn(error);}}
  }
  function schedule(delay=180){generation++;clearTimeout(renderTimer);renderTimer=setTimeout(render,delay);}
  function chooseTime(index){if(!meta)return;selectedTime=meta.times[Math.max(0,Math.min(meta.times.length-1,index))];updateTimeline();schedule();document.dispatchEvent(new CustomEvent('forecast-map-time',{detail:{time:selectedTime}}));}
  window.NorthernForecastMap={setTime(time){if(Number.isFinite(time)){selectedTime=time;if(active()){updateTimeline();schedule();}}}};
  $('forecastMapTimeline').addEventListener('input',()=>chooseTime(Number($('forecastMapTimeline').value)));
  $('forecastMapPrevious').addEventListener('click',()=>chooseTime(Number($('forecastMapTimeline').value)-1));
  $('forecastMapNext').addEventListener('click',()=>chooseTime(Number($('forecastMapTimeline').value)+1));
  $('forecastMapLayer').addEventListener('change',()=>{clearOverlay();syncView();schedule(0);});
  $('forecastMapOpacity').addEventListener('input',()=>{$('forecastMapOpacityValue').textContent=$('forecastMapOpacity').value+'%';overlay?.setOpacity(Number($('forecastMapOpacity').value)/100);});
  $('forecastRetry').addEventListener('click',()=>{metaChecked=0;schedule(0);});
  new MutationObserver(()=>{syncView();if(panel.hidden){generation++;clearTimeout(renderTimer);clearOverlay();}else schedule(0);}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  map.on('moveend resize',()=>{if(active())schedule(250);});
  setInterval(()=>{if(!document.hidden&&active()&&Date.now()-metaChecked>=15*60000)schedule(0);},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())schedule(0);});
})();
