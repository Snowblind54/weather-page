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
  if($('cloudOn').checked || ($('radarOn').checked && typeof NORDIC_RADAR_SOURCES!=='undefined')){
    // Wide satellite frames can take longer than one playback interval. Finish
    // the selected observation before advancing; never invalidate it on a clock.
    async function cloudStep(advance=false){
      if(!playing || generation!==playbackGeneration)return;
      if(advance){
        let i=Number($('timeline').value)+1;
        if(i>Number($('timeline').max))i=Number($('timeline').min);
        $('timeline').value=i;
      }
      try{await applyFrame({awaitCloud:true,awaitRadar:true});}catch(error){console.error(error);}
      if(playing && generation===playbackGeneration)timer=setTimeout(()=>cloudStep(true),900);
    }
    cloudStep();return;
  }
  let nextTick=performance.now()+900;
  function step(){
    if(!playing || generation!==playbackGeneration)return;
    let i=Number($('timeline').value)+1;
    if(i>Number($('timeline').max))i=Number($('timeline').min);
    $('timeline').value=i;
    // Network latency never controls the playback clock. Cloud frames only
    // replace the displayed observation once every visible tile is ready.
    applyFrame({cloudReadyOnly:true}).catch(console.error);
    nextTick+=900;
    if(nextTick<performance.now())nextTick=performance.now()+900;
    timer=setTimeout(step,Math.max(0,nextTick-performance.now()));
  }
  applyFrame().catch(console.error);
  timer=setTimeout(step,900);
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

async function updateTemperatureVisibility(){
  temperatureRenderToken++;
  if(temperatureDebounceTimer)clearTimeout(temperatureDebounceTimer);
  if(temperaturePrecacheTimer)clearTimeout(temperaturePrecacheTimer);
  if(!$('tempOn').checked && map.hasLayer(temperatureLabels))map.removeLayer(temperatureLabels);
  if(!$('heatmapOn').checked && temperatureLayer){map.removeLayer(temperatureLayer);temperatureLayer=null;}
  if(!temperatureEnabled()){
    $('tempStatus').textContent='Temperature layers are off.';
    $('tempStatus').className='status';return;
  }
  try{await loadTemperatures();}catch(e){
    $('tempStatus').textContent=e.rateLimited?'Temperature service is rate limited. Please try again in about a minute.':'Temperature could not load: '+e.message;
    $('tempStatus').className=e.rateLimited?'status warn':'status bad';
  }
}
$('tempOn').addEventListener('change',updateTemperatureVisibility);
$('heatmapOn').addEventListener('change',updateTemperatureVisibility);

$('windOn').addEventListener('change',()=>{
  if($('windOn').checked) loadWind().catch(reportWindError);
  else hideWind();
  updateAccumulationPopup();
});
$('windHeatmapOn').addEventListener('change',()=>{
  if($('windHeatmapOn').checked){
    loadWind().catch(reportWindError);
    if(typeof loadOfficialWind==='function')loadOfficialWind();
  }else hideWindHeatmap();
  updateAccumulationPopup();
});
$('windHeatmapOpacity').addEventListener('input',()=>{
  $('windHeatmapOpacityVal').textContent=$('windHeatmapOpacity').value+'%';
  windHeatmapLayer?.setOpacity(Number($('windHeatmapOpacity').value)/100);
});
$('windMode').addEventListener('change',()=>{
  showWindLegend();
  if($('windOn').checked) renderWind(selectedWindTime());
  if($('windHeatmapOn').checked) renderWindHeatmap(selectedWindTime());
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
  if($('radarOn').checked)pauseRadarPreload();
  // Immediately invalidate any Estonian frame currently downloading/decoding.
  radarRenderGeneration++;
  radarSwapGeneration++;

  if(!$('radarOn').checked){
    if(radarLayer){
      map.removeLayer(radarLayer);
      radarLayer=null;
    }
    clearDirectNationalRadars();
    clearNordicRadars();
    $('radarStatus').textContent='Rain radar: hidden.';
    $('radarStatus').className='status';
    scheduleRadarPreload();
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

    // Cached clouds follow the thumb immediately; uncached observations wait
    // until dragging pauses. Every preview invalidates older pending renders.
    if($('cloudOn').checked)drawCloud(frame,{cachedOnly:true,scrub:true}).catch(console.error);
    if($('windOn').checked) renderWind(frame.time);
    if($('windHeatmapOn').checked) renderWindHeatmap(frame.time);
    if(typeof renderOfficialWind==='function')renderOfficialWind();
    if(activeAccumulationHours()) queueRainfallRender(90);
  }

  if(timelineDebounceTimer)clearTimeout(timelineDebounceTimer);
  timelineDebounceTimer=setTimeout(settleTimelineSelection,140);
});
function settleTimelineSelection(){
  clearTimeout(timelineDebounceTimer);timelineDebounceTimer=null;
  const frame=frames[Number($('timeline').value)];
  if($('cloudOn').checked && frame)drawCloud(frame,{scrub:true}).catch(console.error);
  applyFrame({skipCloud:true}).catch(console.error);
}
// Mouse/touch release and keyboard commits settle without waiting for debounce.
$('timeline').addEventListener('change',settleTimelineSelection);

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
    directRadarImageCache.clear();nordicRadarLists.clear();nordicRadarArchive=null;
    lvRadarList=null;radarNativeImages.clear();
    await loadOfficialRadarList();
    if(temperatureEnabled()) await loadTemperatures(true);
    if($('warningOn').checked) await loadWarnings(true);
    if(windVisualEnabled()) await loadWind().catch(reportWindError);
    if(typeof officialWindNeeded==='function'&&officialWindNeeded())await loadOfficialWind(true);
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
    scheduleRadarPreload();
  }
};

useSatellite();

setTimeout(()=>map.invalidateSize(true),100);
setTimeout(()=>map.invalidateSize(true),800);

async function bootstrap(){
  try{
    await loadOfficialRadarList();
  }catch(e){
    console.error(e);
    $('radarStatus').textContent='Official KAIA radar could not start: '+e.message;
    $('radarStatus').className='status bad';
  }finally{
    scheduleRadarPreload();
  }
}

bootstrap();
// Start Nordic discovery even if Estonia's timeline is slow to respond.
scheduleRadarPreload(2000);

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
  if(temperatureEnabled()) loadTemperatures(false).catch(()=>{});
},10*60*1000);

setInterval(()=>{
  if($('warningOn').checked) loadWarnings(true).catch(()=>{});
},15*60*1000);

setInterval(()=>{
  if($('windOn').checked) loadWind().catch(reportWindError);
},5*60*1000);
