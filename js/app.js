let playbackGeneration=0;
function stop(){
  playbackGeneration++;
  playing=false;$('play').textContent='▶ Play';
  if(timer)clearTimeout(timer);timer=null;
}
function start(){
  stop();requestCloudHistory();
  playing=true;$('play').textContent='❚❚ Pause';
  const generation=playbackGeneration;
  async function step(){
    if(!playing || generation!==playbackGeneration)return;
    const started=performance.now();
    let i=Number($('timeline').value)+1;
    if(i>Number($('timeline').max))i=Number($('timeline').min);
    $('timeline').value=i;
    try{await applyFrame({awaitCloud:true});}catch(e){console.error(e);}
    if(playing && generation===playbackGeneration){
      timer=setTimeout(step,Math.max(50,900-(performance.now()-started)));
    }
  }
  // Show the current observation, then buffer before the first playback step.
  timer=setTimeout(async()=>{
    try{await applyFrame({awaitCloud:true});await prepareCloudPlayback();}catch(e){console.error(e);}
    if(playing && generation===playbackGeneration)timer=setTimeout(step,50);
  },0);
}

$('locateBtn').addEventListener('click',showMyLocation);
$('streetBtn').onclick=useStreet;
$('satBtn').onclick=useSatellite;

// Compact weather cards expand only while enabled.
for(const [toggleId,sectionId] of [
  ['tempOn','tempSection'],
  ['windOn','windSection'],
  ['cloudOn','cloudSection'],
  ['radarOn','radarSection'],
  ['cycloneOn','cycloneSection'],
  ['warningOn','warningSection']
]){
  $(toggleId).addEventListener('change',()=>{
    setWeatherSectionState(sectionId,$(toggleId).checked);
  });
  setWeatherSectionState(sectionId,$(toggleId).checked);
}

$('warningOn').addEventListener('change',async()=>{
  if(!$('warningOn').checked){
    warningLoadGeneration++;
    clearWarningLayers();
    warningRecords=[];
    lithuaniaWarnings=[];
    nordicWarnings=[];
    $('warningList').innerHTML='';
    $('warningStatus').textContent='Weather warnings layer is off.';
    $('warningStatus').className='status';
    return;
  }

  try{
    await loadWarnings(true);
  }catch(e){
    console.error(e);
    $('warningStatus').textContent='Warnings could not load: '+e.message;
    $('warningStatus').className='status bad';
  }
});

$('tempOn').addEventListener('change',async()=>{
  if(!$('tempOn').checked){
    temperatureRenderToken++;
    if(temperatureDebounceTimer) clearTimeout(temperatureDebounceTimer);
    if(temperaturePrecacheTimer) clearTimeout(temperaturePrecacheTimer);

    if(temperatureLayer){
      map.removeLayer(temperatureLayer);
      temperatureLayer=null;
    }
    if(map.hasLayer(temperatureLabels)) map.removeLayer(temperatureLabels);

    $('tempStatus').textContent='Temperature: hidden.';
    $('tempStatus').className='status';
    return;
  }
  try{
    await loadTemperatures();
  }catch(e){
    console.error(e);
    $('tempStatus').textContent=e.rateLimited
      ? 'Temperature service is rate limited right now. Please try again in about a minute.'
      : 'Temperature layer could not load: '+e.message;
    $('tempStatus').className=e.rateLimited?'status warn':'status bad';
  }
});

$('heatmapOn').addEventListener('change',()=>{
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame && $('tempOn').checked) queueTemperatureRender(frame.time,0);
});

$('windOn').addEventListener('change',()=>{
  if($('windOn').checked) loadWind().catch(reportWindError);
  else hideWind();
  updateAccumulationPopup();
});
$('windMode').addEventListener('change',()=>{
  showWindLegend();
  if($('windOn').checked) renderWind(selectedWindTime());
  updateAccumulationPopup();
});
$('windDensity').addEventListener('input',()=>{
  $('windDensityVal').textContent=$('windDensity').value+'%';
  windLayer?.reset();
});

$('tempOpacity').addEventListener('input',()=>{
  $('tempOpacityVal').textContent=$('tempOpacity').value+'%';
  if(temperatureLayer) temperatureLayer.setOpacity(Number($('tempOpacity').value)/100);
});

$('cloudOpacity').addEventListener('input',()=>{
  $('cloudOpacityVal').textContent=$('cloudOpacity').value+'%';
  updateCloudBlendOpacity();
});

$('cloudOn').addEventListener('change',async()=>{
  if(!$('cloudOn').checked){
    await drawCloud(null,-1);
    return;
  }
  await applyFrame();
  scheduleCloudPrecache();
});

$('radarOn').addEventListener('change',async()=>{
  // Immediately invalidate any Estonian frame currently downloading/decoding.
  radarRenderGeneration++;
  radarSwapGeneration++;

  if(!$('radarOn').checked){
    if(radarLayer){
      map.removeLayer(radarLayer);
      radarLayer=null;
    }
    clearDirectNationalRadars();
    $('radarStatus').textContent='Baltic radar: hidden.';
    $('radarStatus').className='status';
    return;
  }

  await applyFrame();
});

$('timeline').addEventListener('input',()=>{
  stop();requestCloudHistory();

  const i=Number($('timeline').value);
  const frame=frames[i];

  if(frame){
    $('timeLabel').textContent=
      fmt(frame.time)+(i===frames.length-1?' · latest':'');

    // Clouds are lightweight once cached, so update/crossfade them immediately
    // while the thumb is moving. Radar + temperature remain debounced.
    // Debounce requests while scrubbing; retain the old clouds until tiles are ready.
    if($('windOn').checked) renderWind(frame.time);
    if(activeAccumulationHours()) queueRainfallRender(90);
  }

  if(timelineDebounceTimer) clearTimeout(timelineDebounceTimer);
  timelineDebounceTimer=setTimeout(()=>{
    applyFrame().catch(console.error);
    if($('cloudOn').checked) scheduleCloudPrecache();
  },90);
});

$('play').onclick=()=>playing?stop():start();
$('oldest').onclick=()=>{
  stop();requestCloudHistory();
  $('timeline').value=$('timeline').min;
  applyFrame().catch(console.error);
};
$('latest').onclick=()=>{
  stop();requestCloudHistory();
  $('timeline').value=$('timeline').max;
  applyFrame().catch(console.error);
};

$('refresh').onclick=async()=>{
  stop();
  $('mapStatus').textContent='Refreshing official weather data…';
  $('mapStatus').className='status';
  try{
    // A manual refresh should bypass the short LV/LT processed-image cache.
    if($('radarOn').checked) directRadarImageCache.clear();
    await loadOfficialRadarList();
    if($('tempOn').checked) await loadTemperatures(true);
    if($('warningOn').checked) await loadWarnings(true);
    if($('windOn').checked) await loadWind().catch(reportWindError);
    $('mapStatus').textContent='Refresh complete.';
    $('mapStatus').className='status ok';
  }catch(e){
    console.error(e);
    $('mapStatus').textContent='Radar refresh failed. See radar status.';
    $('mapStatus').className='status warn';
    $('radarStatus').textContent='Official KAIA API could not be reached from this browser: '+e.message;
    $('radarStatus').className='status bad';
  }finally{
    // Accumulation stays refreshable even when a national radar feed is offline.
    if(activeAccumulationHours()) await loadRainfall(true).catch(reportRainfallError);
    if($('cycloneOn').checked) await loadCyclones(true).catch(reportCycloneError);
  }
};

useSatellite();

setTimeout(()=>map.invalidateSize(true),100);
setTimeout(()=>map.invalidateSize(true),800);

async function bootstrap(){
  try{
    await ensureH5();
    await loadOfficialRadarList();
  }catch(e){
    console.error(e);
    $('radarStatus').textContent='Official KAIA radar could not start: '+e.message;
    $('radarStatus').className='status bad';
  }
}

bootstrap();

// Warm the temperature source data after the first map render. This is network
// work only; the heatmap image itself is still created on demand.
const startTemperaturePrefetch=()=>prefetchTemperatures();
if('requestIdleCallback' in window){
  requestIdleCallback(startTemperaturePrefetch,{timeout:7000});
}else{
  setTimeout(startTemperaturePrefetch,6000);
}
setInterval(()=>{if(!playing && Number($('timeline').value)===Number($('timeline').max))loadOfficialRadarList().catch(()=>{});},5*60*1000);
setInterval(()=>{
  if($('tempOn').checked) loadTemperatures(false).catch(()=>{});
},10*60*1000);

setInterval(()=>{
  if($('warningOn').checked) loadWarnings(true).catch(()=>{});
},15*60*1000);

setInterval(()=>{
  if($('windOn').checked) loadWind().catch(reportWindError);
},5*60*1000);
