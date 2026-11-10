// Shared regional images from GitHub Pages; no browser requests to MET WMS.
(function(){
  const panel=$('forecastSection');if(!panel)return;
  const D=ForecastMapData;
  const controls=document.createElement('div');controls.className='forecast-map-controls';
  controls.innerHTML=`<div class="forecast-map-layer-heading"><label class="label" for="forecastMapLayer">Forecast map layer</label><button type="button" class="info-button" data-info="forecastMapInfo" aria-controls="forecastMapInfo" aria-expanded="false" aria-label="Forecast map information">i</button></div><div id="forecastMapInfo" class="source-card" hidden><h3>Forecast map information</h3><p class="forecast-note">Nordics/Baltics: MET Nordic. Europe/Arctic and North America: ECMWF IFS open data (9 km / 0.1° grid preferred; 0.25° fallback), covering Iceland, Svalbard, Greenland, Europe, the Mediterranean, Canada, mainland USA, Alaska, Hawaii and the Atlantic; MET Nordic keeps priority inside its coverage. All regions follow the same hourly timeline. Precipitation distinguishes rain, snow/wet snow, rain/snow transition, freezing rain and ice pellets. Snow uses pink/purple with white snowflakes; grey means type unavailable. MET Nordic uses snow-phase probability (above 70% snow, below 30% rain, otherwise uncertain transition); it does not diagnose freezing rain here. ECMWF uses its precipitation-type field with nearest-neighbour spatial sampling and holds the preceding native type between three-hour steps. Phase and intensity have different time support, shown in the layer notes. ECMWF’s native steps are three hours: temperature, wind and clouds are interpolated between steps; rain shows the three-hour mean rate and gusts use the nearest native forecast, with its actual period shown below. The model cycles can differ. New ECMWF model cycles arrive four times daily; the 9 km feed is published about two hours after the coarser feed; the shared cache checks every hour. Maps are prepared centrally and served through R2/CDN with GitHub fallback. Only regions in the current view are downloaded. Air masses uses a separate ECMWF 850 hPa forecast over Europe and nearby seas, with native three-hour steps up to forecast hour +120. It shows temperature aloft (typically around 1.5 km above sea level), and is blank where that level is below the model terrain. Closing this menu keeps the forecast map and timeline active. Choose another category in the top menu to return to its weather layers, or choose location forecast only to hide the coloured forecast map.</p></div><select id="forecastMapLayer"><option value="temperature">Temperature</option><option value="airmass">Air masses · 850 hPa</option><option value="rain">Precipitation · rain / snow</option><option value="wind">Sustained wind</option><option value="gusts">Wind gusts</option><option value="clouds">Cloud cover</option><option value="off">Location forecast only</option></select><div class="forecast-map-opacity"><label for="forecastMapOpacity">Map opacity</label><output id="forecastMapOpacityValue">55%</output></div><input id="forecastMapOpacity" type="range" min="10" max="90" step="5" value="55" aria-label="Forecast map opacity"><div id="forecastMapLegend" hidden><div id="forecastMapLegendTitle" class="label"></div><img id="forecastMapColorbar" alt="Forecast colour scale" width="256" height="18"><div id="forecastMapLegendTicks"></div><div id="forecastMapVisibleTime" class="forecast-note"></div></div><div id="forecastMapStatus" class="status" role="status" aria-live="polite">Open Forecast to load the forecast maps.</div>`;
  $('forecastLocation').before(controls);
  const dock=document.createElement('div');dock.className='forecast-map-dock';dock.hidden=true;
  dock.setAttribute('aria-label','Forecast map timeline');
  dock.innerHTML=`<div class="forecast-map-dock-heading"><strong>Forecast map</strong><time id="forecastMapTime"></time><button id="forecastAirPlay" type="button" aria-pressed="false" hidden>▶ Play</button><button id="forecastMapPrevious" type="button" aria-label="Previous forecast step">←</button><button id="forecastMapNext" type="button" aria-label="Next forecast step">→</button></div><input id="forecastMapTimeline" type="range" min="0" max="0" value="0" step="1" aria-label="Forecast map time" aria-describedby="forecastMapTime"><div class="forecast-map-range"><span id="forecastMapStart"></span><span id="forecastMapEnd"></span></div><details class="forecast-map-cycle-details"><summary>Model cycles</summary><div id="forecastMapCycle" class="forecast-note"></div></details>`;
  const layerSwitch=document.createElement('div');layerSwitch.className='forecast-map-layer-switch';
  layerSwitch.append(controls.querySelector('.forecast-map-layer-heading'),$('forecastMapInfo'),$('forecastMapLayer'));
  const precipKey=document.createElement('div');precipKey.id='forecastPrecipKey';precipKey.className='forecast-precip-key';precipKey.hidden=true;
  precipKey.innerHTML='<strong>❄ Snow forecast = pink/purple + snowflakes</strong><div><span><i class="precip-rain"></i>Rain intensity</span><span><i class="precip-snow"></i>❄ Snow / wet snow</span><span><i class="precip-mixed"></i>Rain/snow transition</span><span><i class="precip-freezing"></i>Freezing rain</span><span><i class="precip-ice"></i>Ice pellets</span><span><i class="precip-unknown"></i>Type unavailable</span></div>';
  layerSwitch.append(precipKey);
  const precipAvailability=document.createElement('div');precipAvailability.className='forecast-precip-availability';precipKey.append(precipAvailability);
  const airKey=document.createElement('div');airKey.className='forecast-air-key';airKey.hidden=true;
  airKey.innerHTML='<div class="forecast-air-scale" aria-hidden="true"></div><div class="forecast-air-ticks" aria-label="Air mass temperature scale"></div><div class="forecast-air-note"><span>0°C line</span><span>850 hPa · ECMWF · Europe</span></div><div class="forecast-air-status" role="status"></div>';
  layerSwitch.append(airKey);
  const airStatus=airKey.querySelector('.forecast-air-status');
  dock.prepend(layerSwitch);
  document.body.append(dock);L.DomEvent.disableClickPropagation(dock);L.DomEvent.disableScrollPropagation(dock);
  map.createPane('forecastModel');map.getPane('forecastModel').style.zIndex='430';map.getPane('forecastModel').style.pointerEvents='none';
  let meta=null,metaPromise=null,metaChecked=0,selectedTime=null,generation=0,overlay=null,visibleTime=null,visibleUrl=null,renderTimer=null,visibleRegions=[];
  let airMeta=null,airPromise=null,airChecked=0,snapTime=false,playTimer=null,playing=false;
  const cache=new Map(),pending=new Map();
  let forecastMode=false;
  const active=()=>forecastMode&&$('forecastMapLayer').value!=='off';
  const airSelected=()=>$('forecastMapLayer').value==='airmass';
  const timelineMeta=()=>airSelected()?airMeta:meta;
  const date=t=>new Date(t).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  function status(s,bad=false){$('forecastMapStatus').textContent=s;$('forecastMapStatus').className='status'+(bad?' bad':'');if(airSelected())airStatus.textContent=s.startsWith('Forecast map ready')?'':s;}
  function opacity(){overlay?.forEach(layer=>layer.setOpacity(Number($('forecastMapOpacity').value)/100));}
  function clearOverlay(){window.ForecastWindDirections?.clear();precipKey.hidden=true;overlay?.forEach(layer=>map.removeLayer(layer));overlay=null;visibleRegions=[];visibleTime=null;visibleUrl=null;$('forecastMapLegend').hidden=true;}
  function syncView(){document.body.classList.toggle('forecast-view',forecastMode);document.body.classList.toggle('forecast-model-view',active());$('nav-forecastSection').classList.toggle('layer-active',active());dock.hidden=!forecastMode;for(const child of dock.children)child.hidden=child!==layerSwitch&&!active();airKey.hidden=!airSelected();$('forecastAirPlay').hidden=!airSelected();}
  async function airMetadata(){
    if(airMeta&&Date.now()-airChecked<15*60000)return airMeta;
    if(airPromise)return airPromise;
    airPromise=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),20000);
      try{
        const key=airChecked?'cycle-'+Math.floor(Date.now()/900000):'refresh-'+Math.floor(Date.now()/10000);
        const response=await fetch('data/forecast-airmass.json?v='+key,{signal:abort.signal,cache:'no-store'});
        if(!response.ok)throw Error('ECMWF air mass forecast not yet published');
        const region=D.airMassMetadata(await response.json(),Date.now());
        const followsFirst=airSelected()&&airMeta&&selectedTime===airMeta.times[0];
        airMeta={...region,regions:[region]};airChecked=Date.now();
        if(followsFirst&&selectedTime!==region.times[0]){selectedTime=region.times[0];announceTime();}
        return airMeta;
      }finally{clearTimeout(timer);}
    })().catch(error=>{
      airChecked=Date.now()-13*60000;
      if(airMeta){try{const valid=D.airMassMetadata(airMeta,Date.now());return airMeta={...valid,regions:[valid]};}catch{airMeta=null;}}
      throw error;
    }).finally(()=>{airPromise=null;});
    return airPromise;
  }
  async function metadata(){
    if(meta&&Date.now()-metaChecked<15*60000)return meta;
    if(metaPromise)return metaPromise;
    metaPromise=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),20000);
      try{
        // New tabs and explicit retries must not reuse a cached manifest whose
        // old cycle has already retired from the independent delivery mirror.
        const cacheKey=metaChecked===0?'refresh-'+Math.floor(Date.now()/10000):Math.floor(Date.now()/900000);
        const sources=[['data/forecast-map.json','Nordics','forecast-cache'],['data/forecast-iceland.json','Iceland','forecast-iceland-cache'],['data/forecast-canada.json','Canada','forecast-canada-cache']];
        const results=await Promise.allSettled(sources.map(async([path,region,assetRoot])=>{
          const response=await fetch(path+'?v='+cacheKey,{signal:abort.signal,cache:'no-cache'});
          if(!response.ok)throw Error(region+' map index unavailable');
          const candidate=await response.json();
          if(candidate.delivery!=='static-regional-images'||(candidate.asset_root||'forecast-cache')!==assetRoot||!Array.isArray(candidate.bounds)||candidate.bounds.length!==4||!candidate.bounds.every(Number.isFinite)||candidate.bounds[0]>=candidate.bounds[2]||candidate.bounds[1]>=candidate.bounds[3]||candidate.bounds[1]<-85||candidate.bounds[3]>85||candidate.bounds[0]<(assetRoot==='forecast-canada-cache'?-190:-180)||candidate.bounds[2]>180||!Number.isFinite(Date.parse(candidate.reference_time))||!D.cachedTimes(candidate).length)throw Error('Invalid '+region+' map index');
          for(const kind of ['temperature','rain','wind'])if(!candidate.layers?.[kind])throw Error('Missing '+region+' quantity');
          for(const kind of Object.keys(candidate.layers)){if(candidate.layers[kind]!==D.layers[kind]?.name)throw Error('Invalid '+region+' quantity');D.assetUrl(candidate,kind);}
          return {...candidate,region};
        }));
        const regions=[];
        results.forEach((result,i)=>{if(result.status==='fulfilled')regions.push(result.value);else console.warn(sources[i][1]+' forecast cache unavailable',result.reason);});
        if(!regions.length)throw Error('No current forecast grid available');
        const next=regions.find(r=>r.region==='Nordics')||regions[0];
        const times=D.regionalTimes(regions);
        const followCurrent=!airSelected()&&meta&&selectedTime===meta.times[0];
        meta={...next,layers:Object.assign({},...regions.map(r=>r.layers)),times,regions};metaChecked=Date.now();
        if(followCurrent&&selectedTime!==times[0]){selectedTime=times[0];document.dispatchEvent(new CustomEvent('forecast-map-time',{detail:{time:selectedTime}}));}
        return meta;
      }finally{clearTimeout(timer);}
    })().catch(error=>{metaChecked=Date.now()-13*60000;if(meta&&D.regionalTimes(meta.regions).length){console.warn(error);return meta;}throw error;}).finally(()=>{metaPromise=null;});
    return metaPromise;
  }
  function updateTimeline(){
    const current=timelineMeta();if(!current)return;
    const times=current.times;
    if(selectedTime===null)selectedTime=times[0];
    const index=times.reduce((best,t,i)=>Math.abs(t-selectedTime)<Math.abs(times[best]-selectedTime)?i:best,0);
    if(snapTime||(airSelected()&&selectedTime>=times[0]-3*3600000&&selectedTime<=times.at(-1))){
      snapTime=false;
      if(selectedTime!==times[index]){selectedTime=times[index];announceTime();}
    }
    $('forecastMapTimeline').max=String(times.length-1);$('forecastMapTimeline').value=String(index);
    $('forecastMapTime').textContent=date(selectedTime);$('forecastMapTime').dateTime=new Date(selectedTime).toISOString();
    $('forecastMapStart').textContent=date(times[0]);$('forecastMapEnd').textContent=date(times.at(-1));
    $('forecastMapPrevious').disabled=index===0;$('forecastMapNext').disabled=index===times.length-1;
    const older=current.regions.some(r=>r.region==='Nordics'&&Date.now()-Date.parse(r.reference_time)>9*3600000);
    $('forecastMapCycle').textContent=airSelected()?'ECMWF IFS · 0.25° · '+date(Date.parse(current.reference_time))+' · native 3-hour steps':current.regions.map(r=>D.regionLabel(r)+(r.grid_spacing_degrees?' '+(r.grid_spacing_degrees===.1?'9 km / 0.1°':'0.25° fallback'):'')+' cycle '+date(Date.parse(r.reference_time))).join(' · ')+(older?' · older Nordic cycle':'');
    for(const option of $('forecastMapLayer').options)option.disabled=Boolean(meta)&&!['off','airmass'].includes(option.value)&&!meta.layers[option.value];
  }
  function image(url){
    if(cache.has(url)){const img=cache.get(url);cache.delete(url);cache.set(url,img);return Promise.resolve(img);}
    if(pending.has(url))return pending.get(url);
    const work=new Promise((resolve,reject)=>{
      const img=new Image();img.referrerPolicy='no-referrer-when-downgrade';
      const backup=window.weatherGithubDataUrl?.(url)||url;let retried=false,timer;
      const failed=()=>{clearTimeout(timer);
        if(!retried&&backup!==url){retried=true;load(backup);return;}
        img.onload=img.onerror=null;img.src='';reject(Error('Forecast image unavailable: '+url));
      };
      const load=source=>{timer=setTimeout(failed,source===url&&backup!==url?8000:25000);img.src=source;};
      img.onload=()=>{clearTimeout(timer);img.onload=img.onerror=null;cache.set(url,img);while(cache.size>8)cache.delete(cache.keys().next().value);resolve(img);};
      img.onerror=failed;load(url);
    }).finally(()=>pending.delete(url));pending.set(url,work);return work;
  }
  document.addEventListener('weather-units-change',()=>{if(overlay)legend($('forecastMapLayer').value);});
  const airUnit=()=>globalThis.WeatherUnits?.temperatureUnit()??'°C';
  function airTicks(){
    airKey.querySelector('.forecast-air-ticks').replaceChildren(...D.layers.airmass.ticks.map(value=>{
      const tick=document.createElement('span'),c=Number(value.replace('−','-'));
      tick.textContent=String(Math.round(globalThis.WeatherUnits?.temperatureValue(c)??c))+'°';return tick;
    }));
    airKey.querySelector('.forecast-air-note span').textContent=(airUnit()==='°F'?'32°F':'0°C')+' line';
  }
  function legend(kind){
    precipKey.hidden=kind!=='rain';
    if(kind==='rain'){
      const missing=visibleRegions.filter(r=>r.precipitation_types?.version!==1).map(D.regionLabel);
      precipAvailability.textContent=missing.length?'Snow-type maps are updating for '+missing.join(', ')+'. These regions currently show total precipitation only.':'';
    }
    const l=D.layers[kind],temperature=['temperature','airmass'].includes(kind);
    $('forecastMapLegendTitle').textContent=(kind==='rain'?'Rain intensity':l.label)+' · '+(temperature?(globalThis.WeatherUnits?.temperatureUnit()??l.unit):['wind','gusts'].includes(kind)?(globalThis.WeatherUnits?.windUnit()??l.unit):l.unit);
    if(kind==='airmass')airTicks();
    const colorbar=$('forecastMapColorbar');colorbar.onerror=()=>{const backup=window.weatherGithubDataUrl?.(colorbar.src);if(backup&&backup!==colorbar.src)colorbar.src=backup;};
    colorbar.src=D.assetUrl(visibleRegions[0]||meta,kind);
    $('forecastMapLegendTicks').replaceChildren(...(kind==='temperature'?D.temperatureTicks(visibleRegions[0]||meta):l.ticks).map(value=>{const e=document.createElement('span');const native=Number(String(value).replace('−','-').replace('+',''));
      const converted=temperature?(globalThis.WeatherUnits?.temperatureValue(native)??native):['wind','gusts'].includes(kind)?(globalThis.WeatherUnits?.windValue(native)??native):native;
      e.textContent=(temperature||['wind','gusts'].includes(kind))&&Number.isFinite(native)?String(Math.round(converted))+(String(value).endsWith('+')?'+':''):value;return e;}));
    const notes=visibleRegions.map(region=>{
      if(kind==='airmass')return 'ECMWF IFS: valid '+date(visibleTime)+'. Temperature at 850 hPa, typically around 1.5 km above sea level. The cream line marks '+(airUnit()==='°F'?'32°F':'0°C')+' at that level. Blank where the pressure level is below model terrain.';
      if(region.region==='Nordics')return kind==='rain'?'Nordics: total for '+date(visibleTime)+' – '+date(visibleTime+3600000)+'. '+(region.precipitation_types?.version===1?'Snow likely above 70% snow-phase probability; orange is an uncertain rain/snow transition.':'Precipitation type unavailable for this cache; colours show total precipitation only.'):'Nordics: valid '+date(visibleTime)+'.';
      const period=region.periods[new Date(visibleTime).toISOString()];
      const label=D.regionLabel(region);
      if(kind==='rain'||kind==='gusts')return label+': '+(kind==='rain'?'three-hour mean precipitation rate':'maximum gust (nearest native forecast)')+' for '+date(Date.parse(kind==='gusts'?(period.gust_start||period.start):period.start))+' – '+date(Date.parse(kind==='gusts'?(period.gust_end||period.end):period.end))+'.';
      return label+': valid '+date(visibleTime)+(period.interpolated?' · interpolated between native three-hour forecasts.':'.');
    });
    if(kind==='rain')for(const region of visibleRegions.filter(r=>r.region!=='Nordics')){
      const period=region.periods?.[new Date(visibleTime).toISOString()];
      notes.push(D.regionLabel(region)+': '+(region.precipitation_types?.version===1&&period?.precipitation_type_time?'precipitation type valid '+date(Date.parse(period.precipitation_type_time))+' (held from three-hour steps).':'precipitation type unavailable for this cache.'));
    }
    if(['wind','gusts'].includes(kind))notes.push('Arrows point where the wind is blowing; they show sustained-wind direction at the selected hour, including on the gust map.');
    $('forecastMapVisibleTime').textContent=notes.join(' ')+(kind==='rain'?' Pink/purple with ❄ marks forecast snow, not snow already on the ground. Snow/mixed colours identify type, not intensity. Amounts are liquid-water equivalent, not snow depth.':'');
    $('forecastMapLegend').hidden=false;
  }
  async function render(){
    const id=++generation;syncView();if(!active()){clearOverlay();return;}
    const kind=$('forecastMapLayer').value,air=kind==='airmass';precipKey.hidden=kind!=='rain';if(air)airTicks();
    window.ForecastWindDirections?.clear();
    status(meta?'Updating forecast map…':'Loading forecast map availability…');
    try{
      const current=await (air?airMetadata():metadata());if(id!==generation||!active())return;updateTimeline();
      if(!current.times.includes(selectedTime)){clearOverlay();status('No map grid for this time. Use the forecast map timeline below; location forecasts extend further.',true);return;}
      if(!current.layers[kind])throw Error('This forecast map variable is unavailable');
      const bounds=map.getBounds();
      const regions=D.visibleRegions(current.regions,bounds,kind,selectedTime);
      if(!regions.length){stopPlayback();clearOverlay();status(air?'Pan to Europe to see the air mass forecast.':'No forecast map available in this view at this hour. Location forecasts remain available.');return;}
      const urls=regions.map(region=>D.assetUrl(region,kind,selectedTime)),key=urls.map((url,i)=>url+'@'+regions[i].bounds[0]).join('|');
      if(overlay&&visibleUrl===key){visibleRegions=regions;opacity();legend(kind);if(['wind','gusts'].includes(kind))window.ForecastWindDirections?.show(regions,visibleTime);status('Forecast map ready · cached images.');return;}
      status(visibleTime!==null?'Loading forecast maps… Previous images valid '+date(visibleTime)+'.':'Loading forecast map images…');
      const imgs=await Promise.all(urls.map(image));if(id!==generation||!active())return;
      const next=imgs.map((img,index)=>{
        // Keep cached image elements independent of Leaflet's DOM ownership.
        // Removing an old overlay must not detach an image reused by a new one.
        const display=img.cloneNode(false),region=regions[index];display.dataset.forecastTime=new Date(selectedTime).toISOString();display.dataset.forecastLayer=kind;display.dataset.forecastRegion=region.region;
        return L.imageOverlay(display,[[region.bounds[1],region.bounds[0]],[region.bounds[3],region.bounds[2]]],{pane:'forecastModel',zIndex:region.region==='Iceland'?0:1,opacity:Number($('forecastMapOpacity').value)/100,interactive:false,attribution:region.region!=='Nordics'?'Forecast © <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF</a> · CC BY 4.0'+(air?' · 850 hPa · 3-hour steps':' · hourly interpolation'):'Forecast © <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway</a> · CC BY 4.0'}).addTo(map);
      });
      overlay?.forEach(layer=>map.removeLayer(layer));overlay=next;visibleRegions=regions;visibleTime=selectedTime;visibleUrl=key;legend(kind);
      if(['wind','gusts'].includes(kind))window.ForecastWindDirections?.show(regions,visibleTime);
      status('Forecast map ready · '+D.layers[kind].label+' · '+date(visibleTime));
      if(air){const index=current.times.indexOf(visibleTime),nextTime=current.times[index+1];if(nextTime!==undefined)image(D.assetUrl(regions[0],kind,nextTime)).catch(()=>{});}
    }catch(error){if(id===generation&&active()){stopPlayback();clearOverlay();status(air?'Air mass forecast unavailable. Retry using Check for updates.':'Forecast map unavailable. Location forecasts still work; retry using Check for updates.',true);console.warn(error);}}
  }
  function schedule(delay=180){generation++;clearTimeout(renderTimer);renderTimer=setTimeout(render,delay);}
  function announceTime(){document.dispatchEvent(new CustomEvent('forecast-map-time',{detail:{time:selectedTime}}));}
  function chooseTime(index){const times=timelineMeta()?.times;if(!times?.length)return;selectedTime=times[Math.max(0,Math.min(times.length-1,index))];updateTimeline();schedule();announceTime();}
  function stopPlayback(){playing=false;clearTimeout(playTimer);$('forecastAirPlay').textContent='▶ Play';$('forecastAirPlay').setAttribute('aria-pressed','false');}
  $('forecastAirPlay').addEventListener('click',()=>{
    if(playing){stopPlayback();return;}if(!active()||!airSelected()||!airMeta||visibleTime!==selectedTime||!overlay)return;
    playing=true;$('forecastAirPlay').textContent='Ⅱ Pause';$('forecastAirPlay').setAttribute('aria-pressed','true');
    if(selectedTime===airMeta.times.at(-1))chooseTime(0);
    const tick=()=>{
      if(!playing||!active()||!airSelected()||document.hidden){stopPlayback();return;}
      const index=airMeta.times.indexOf(selectedTime);
      if(visibleTime===selectedTime&&index===airMeta.times.length-1){stopPlayback();return;}
      if(visibleTime===selectedTime)chooseTime(index+1);
      playTimer=setTimeout(tick,750);
    };
    playTimer=setTimeout(tick,750);
  });
  window.NorthernForecastMap={isActive:()=>forecastMode,setActive(enabled){forecastMode=Boolean(enabled);syncView();if(!active()){stopPlayback();generation++;clearTimeout(renderTimer);clearOverlay();}else schedule(0);},setTime(time){if(Number.isFinite(time)){stopPlayback();selectedTime=time;if(active()){updateTimeline();schedule();}}}};
  $('forecastMapTimeline').addEventListener('input',()=>{stopPlayback();chooseTime(Number($('forecastMapTimeline').value));});
  $('forecastMapPrevious').addEventListener('click',()=>{stopPlayback();chooseTime(Number($('forecastMapTimeline').value)-1);});
  $('forecastMapNext').addEventListener('click',()=>{stopPlayback();chooseTime(Number($('forecastMapTimeline').value)+1);});
  $('forecastMapLayer').addEventListener('change',()=>{stopPlayback();snapTime=true;clearOverlay();syncView();schedule(0);});
  $('forecastMapOpacity').addEventListener('input',()=>{$('forecastMapOpacityValue').textContent=$('forecastMapOpacity').value+'%';opacity();});
  $('forecastRetry').addEventListener('click',()=>{metaChecked=airChecked=0;schedule(0);});
  new MutationObserver(()=>{if(!panel.hidden){forecastMode=true;syncView();schedule(0);}}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  map.on('moveend resize',()=>{if(active())schedule(250);});
  setInterval(()=>{if(!document.hidden&&active()&&Date.now()-(airSelected()?airChecked:metaChecked)>=15*60000)schedule(0);},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())schedule(0);});
})();





