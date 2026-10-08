// Shared regional images from GitHub Pages; no browser requests to MET WMS.
(function(){
  const panel=$('forecastSection');if(!panel)return;
  const D=ForecastMapData;
  const controls=document.createElement('div');controls.className='forecast-map-controls';
  controls.innerHTML=`<div class="forecast-map-layer-heading"><label class="label" for="forecastMapLayer">Forecast map layer</label><button type="button" class="info-button" data-info="forecastMapInfo" aria-controls="forecastMapInfo" aria-expanded="false" aria-label="Forecast map information">i</button></div><div id="forecastMapInfo" class="source-card" hidden><h3>Forecast map information</h3><p class="forecast-note">Nordics/Baltics: MET Nordic. Iceland/North Atlantic: ECMWF IFS open data (0.25° grid), filling the gap to Norway; MET Nordic keeps priority inside its coverage. Both follow the same hourly timeline and colour scales. Iceland’s native steps are three hours: temperature, wind and clouds are interpolated between steps; rain shows the three-hour mean rate and gusts use the nearest native forecast, with its actual period shown below. The model cycles can differ. Shared maps refresh every six hours. Other weather overlays return when you close Forecast or choose location forecast only.</p></div><select id="forecastMapLayer"><option value="temperature">Temperature</option><option value="rain">Rain / snow</option><option value="wind">Sustained wind</option><option value="gusts">Wind gusts</option><option value="clouds">Cloud cover</option><option value="off">Location forecast only</option></select><div class="forecast-map-opacity"><label for="forecastMapOpacity">Map opacity</label><output id="forecastMapOpacityValue">55%</output></div><input id="forecastMapOpacity" type="range" min="10" max="90" step="5" value="55" aria-label="Forecast map opacity"><div id="forecastMapLegend" hidden><div id="forecastMapLegendTitle" class="label"></div><img id="forecastMapColorbar" alt="Forecast colour scale" width="256" height="18"><div id="forecastMapLegendTicks"></div><div id="forecastMapVisibleTime" class="forecast-note"></div></div><div id="forecastMapStatus" class="status" role="status" aria-live="polite">Open Forecast to load the forecast maps.</div>`;
  $('forecastLocation').before(controls);
  const dock=document.createElement('div');dock.className='forecast-map-dock';dock.hidden=true;
  dock.setAttribute('aria-label','Forecast map timeline');
  dock.innerHTML=`<div class="forecast-map-dock-heading"><strong>Forecast map</strong><time id="forecastMapTime"></time><button id="forecastMapPrevious" type="button" aria-label="Previous forecast hour">←</button><button id="forecastMapNext" type="button" aria-label="Next forecast hour">→</button></div><input id="forecastMapTimeline" type="range" min="0" max="0" value="0" step="1" aria-label="Forecast map time" aria-describedby="forecastMapTime"><div class="forecast-map-range"><span id="forecastMapStart"></span><span id="forecastMapEnd"></span></div><div id="forecastMapCycle" class="forecast-note"></div>`;
  document.body.append(dock);L.DomEvent.disableClickPropagation(dock);L.DomEvent.disableScrollPropagation(dock);
  map.createPane('forecastModel');map.getPane('forecastModel').style.zIndex='430';map.getPane('forecastModel').style.pointerEvents='none';
  let meta=null,metaPromise=null,metaChecked=0,selectedTime=null,generation=0,overlay=null,visibleTime=null,visibleUrl=null,renderTimer=null,visibleRegions=[];
  const cache=new Map(),pending=new Map();
  const active=()=>!panel.hidden&&$('forecastMapLayer').value!=='off';
  const date=t=>new Date(t).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  function status(s,bad=false){$('forecastMapStatus').textContent=s;$('forecastMapStatus').className='status'+(bad?' bad':'');}
  function opacity(){overlay?.forEach(layer=>layer.setOpacity(Number($('forecastMapOpacity').value)/100));}
  function clearOverlay(){overlay?.forEach(layer=>map.removeLayer(layer));overlay=null;visibleRegions=[];visibleTime=null;visibleUrl=null;$('forecastMapLegend').hidden=true;}
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
        if(next.delivery!=='static-regional-images'||!Array.isArray(next.bounds)||next.bounds.length!==4||!next.bounds.every(Number.isFinite))throw Error('Invalid map index');
        const times=D.cachedTimes(next);
        if(!times.length||!Number.isFinite(Date.parse(next.reference_time)))throw Error('No current forecast grid available');
        for(const [kind,l] of Object.entries(D.layers))if(next.layers?.[kind]){if(next.layers[kind]!==l.name)throw Error('Unexpected forecast variable');D.assetUrl(next,kind);}
        let iceland=null;
        try{
          const r=await fetch('data/forecast-iceland.json?v='+Math.floor(Date.now()/900000),{signal:abort.signal,cache:'no-cache'});
          if(r.ok){const candidate=await r.json();if(candidate.asset_root!=='forecast-iceland-cache'||candidate.delivery!=='static-regional-images'||!Array.isArray(candidate.bounds)||candidate.bounds.length!==4||!candidate.bounds.every(Number.isFinite)||!D.cachedTimes(candidate).length)throw Error('Invalid Iceland map index');for(const kind of Object.keys(candidate.layers)){if(candidate.layers[kind]!==D.layers[kind]?.name)throw Error('Invalid Iceland quantity');D.assetUrl(candidate,kind);}iceland=candidate;}
        }catch(error){console.warn('Iceland forecast cache unavailable',error);}
        const followCurrent=meta&&selectedTime===meta.times[0];
        meta={...next,times,regions:[{...next,region:'Nordics'},...(iceland?[{...iceland,region:'Iceland'}]:[])]};metaChecked=Date.now();
        if(followCurrent&&selectedTime!==times[0]){selectedTime=times[0];document.dispatchEvent(new CustomEvent('forecast-map-time',{detail:{time:selectedTime}}));}
        return meta;
      }finally{clearTimeout(timer);}
    })().catch(error=>{metaChecked=Date.now()-13*60000;if(meta&&D.cachedTimes(meta).length){console.warn(error);return meta;}throw error;}).finally(()=>{metaPromise=null;});
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
    const older=Date.now()-Date.parse(meta.reference_time)>9*3600000;
    $('forecastMapCycle').textContent=meta.regions.map(r=>(r.region==='Iceland'?'Iceland / Atlantic':r.region)+' cycle '+date(Date.parse(r.reference_time))).join(' · ')+(older?' · older Nordic cycle':'');
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
    $('forecastMapColorbar').src=D.assetUrl(visibleRegions[0]||meta,kind);
    $('forecastMapLegendTicks').replaceChildren(...l.ticks.map(value=>{const e=document.createElement('span');e.textContent=value;return e;}));
    const notes=visibleRegions.map(region=>{
      if(region.region!=='Iceland')return kind==='rain'?'Nordics: total for '+date(visibleTime)+' – '+date(visibleTime+3600000)+'.':'Nordics: valid '+date(visibleTime)+'.';
      const period=region.periods[new Date(visibleTime).toISOString()];
      if(kind==='rain'||kind==='gusts')return 'Iceland / North Atlantic: '+(kind==='rain'?'three-hour mean precipitation rate':'maximum gust (nearest native forecast)')+' for '+date(Date.parse(kind==='gusts'?(period.gust_start||period.start):period.start))+' – '+date(Date.parse(kind==='gusts'?(period.gust_end||period.end):period.end))+'.';
      return 'Iceland / North Atlantic: valid '+date(visibleTime)+(period.interpolated?' · interpolated between native three-hour forecasts.':'.');
    });
    $('forecastMapVisibleTime').textContent=notes.join(' ')+(kind==='rain'?' Rain/snow is liquid-water equivalent.':'');
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
      const regions=D.visibleRegions(meta.regions,bounds,kind,selectedTime);
      if(!regions.length){clearOverlay();status('No forecast map available in this view at this hour. Location forecasts remain available.');return;}
      const urls=regions.map(region=>D.assetUrl(region,kind,selectedTime)),key=urls.join('|');
      if(overlay&&visibleUrl===key){visibleRegions=regions;opacity();legend(kind);status('Forecast map ready · cached images.');return;}
      status(visibleTime!==null?'Loading forecast maps… Previous images valid '+date(visibleTime)+'.':'Loading forecast map images…');
      const imgs=await Promise.all(urls.map(image));if(id!==generation||!active())return;
      const next=imgs.map((img,index)=>{
        // Keep cached image elements independent of Leaflet's DOM ownership.
        // Removing an old overlay must not detach an image reused by a new one.
        const display=img.cloneNode(false),region=regions[index];display.dataset.forecastTime=new Date(selectedTime).toISOString();display.dataset.forecastLayer=kind;display.dataset.forecastRegion=region.region;
        return L.imageOverlay(display,[[region.bounds[1],region.bounds[0]],[region.bounds[3],region.bounds[2]]],{pane:'forecastModel',zIndex:region.region==='Iceland'?0:1,opacity:Number($('forecastMapOpacity').value)/100,interactive:false,attribution:region.region==='Iceland'?'Forecast © <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF</a> · CC BY 4.0 · hourly interpolation':'Forecast © <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway</a> · CC BY 4.0'}).addTo(map);
      });
      overlay?.forEach(layer=>map.removeLayer(layer));overlay=next;visibleRegions=regions;visibleTime=selectedTime;visibleUrl=key;legend(kind);
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
  $('forecastMapOpacity').addEventListener('input',()=>{$('forecastMapOpacityValue').textContent=$('forecastMapOpacity').value+'%';opacity();});
  $('forecastRetry').addEventListener('click',()=>{metaChecked=0;schedule(0);});
  new MutationObserver(()=>{syncView();if(panel.hidden){generation++;clearTimeout(renderTimer);clearOverlay();}else schedule(0);}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  map.on('moveend resize',()=>{if(active())schedule(250);});
  setInterval(()=>{if(!document.hidden&&active()&&Date.now()-metaChecked>=15*60000)schedule(0);},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())schedule(0);});
})();
