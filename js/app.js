function stop(){
  playing=false;$('play').textContent='▶ Play';
  if(timer)clearInterval(timer);timer=null;
}
function start(){
  playing=true;$('play').textContent='❚❚ Pause';
  timer=setInterval(async()=>{
    let i=Number($('timeline').value)+1;
    if(i>Number($('timeline').max)) i=Number($('timeline').min);
    $('timeline').value=i;
    applyFrame().catch(console.error);
  },850);
}

$('locateBtn').addEventListener('click',showMyLocation);
$('streetBtn').onclick=useStreet;
$('satBtn').onclick=useSatellite;



// Compact weather cards expand only while enabled.
for(const [toggleId,sectionId] of [
  ['tempOn','tempSection'],
  ['cloudOn','cloudSection'],
  ['radarOn','radarSection'],
  ['balticRadarOn','balticRadarSection'],
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
    $('warningList').innerHTML='';
    $('warningStatus').textContent='Estonian warnings layer is off.';
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
    $('tempStatus').textContent='Temperature layer could not load: '+e.message;
    $('tempStatus').className='status bad';
  }
});

$('heatmapOn').addEventListener('change',()=>{
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame && $('tempOn').checked) queueTemperatureRender(frame.time,0);
});

$('tempOpacity').addEventListener('input',()=>{
  $('tempOpacityVal').textContent=$('tempOpacity').value+'%';
  if(temperatureLayer) temperatureLayer.setOpacity(Number($('tempOpacity').value)/100);
});

$('cloudOpacity').addEventListener('input',()=>{
  $('cloudOpacityVal').textContent=$('cloudOpacity').value+'%';
  updateCloudBlendOpacity();
});
$('radarOpacity').addEventListener('input',()=>{
  $('radarOpacityVal').textContent=$('radarOpacity').value+'%';
  if(radarLayer)radarLayer.setOpacity(Number($('radarOpacity').value)/100);
});
$('balticRadarOpacity').addEventListener('input',()=>{
  $('balticRadarOpacityVal').textContent=$('balticRadarOpacity').value+'%';
  if(balticRadarLayer) balticRadarLayer.setOpacity(Number($('balticRadarOpacity').value)/100);
});

$('balticRadarOn').addEventListener('change',async()=>{
  if(!$('balticRadarOn').checked){
    if(balticRadarLayer){map.removeLayer(balticRadarLayer);balticRadarLayer=null;}
    $('balticRadarStatus').textContent='Latvia + Lithuania radar is off.';
    $('balticRadarStatus').className='status';
    return;
  }
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame) await drawBalticRadar(frame.time);
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
  // Immediately invalidate any frame currently downloading/decoding.
  radarRenderGeneration++;
  radarSwapGeneration++;

  if(!$('radarOn').checked){
    if(radarLayer){
      map.removeLayer(radarLayer);
      radarLayer=null;
    }
    $('radarStatus').textContent='Radar: hidden.';
    $('radarStatus').className='status';
    return;
  }

  await applyFrame();
});
$('timeline').addEventListener('input',()=>{
  stop();

  const i=Number($('timeline').value);
  const frame=frames[i];

  if(frame){
    $('timeLabel').textContent=
      fmt(frame.time)+(i===frames.length-1?' · latest':'');

    // Clouds are lightweight once cached, so update/crossfade them immediately
    // while the thumb is moving. Radar + temperature remain debounced.
    if($('cloudOn').checked) drawCloud(frame,i).catch(console.error);
  }

  if(timelineDebounceTimer) clearTimeout(timelineDebounceTimer);
  timelineDebounceTimer=setTimeout(()=>{
    applyFrame({skipCloud:true}).catch(console.error);
    if($('cloudOn').checked) scheduleCloudPrecache();
  },90);
});
$('play').onclick=()=>playing?stop():start();
$('oldest').onclick=()=>{
  stop();
  $('timeline').value=$('timeline').min;
  applyFrame().catch(console.error);
};
$('latest').onclick=()=>{
  stop();
  $('timeline').value=$('timeline').max;
  applyFrame().catch(console.error);
};
$('refresh').onclick=async()=>{
  stop();
  $('mapStatus').textContent='Refreshing official weather data…';
  $('mapStatus').className='status';
  try{
    await loadOfficialRadarList();
    if($('balticRadarOn').checked){ await loadBalticRadarManifest(true); const f=frames[Number($('timeline').value)]; if(f) await drawBalticRadar(f.time); }
    if($('tempOn').checked) await loadTemperatures(true);
    if($('warningOn').checked) await loadWarnings(true);
    $('mapStatus').textContent='Refresh complete.';
    $('mapStatus').className='status ok';
  }catch(e){
    console.error(e);
    $('mapStatus').textContent='Radar refresh failed. See radar status.';
    $('mapStatus').className='status warn';
    $('radarStatus').textContent='Official KAIA API could not be reached from this browser: '+e.message;
    $('radarStatus').className='status bad';
  }
};

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
setInterval(()=>loadOfficialRadarList().catch(()=>{}),5*60*1000);
setInterval(()=>{
  if($('tempOn').checked) loadTemperatures(false).catch(()=>{});
},10*60*1000);

setInterval(()=>{
  if($('warningOn').checked) loadWarnings(true).catch(()=>{});
},15*60*1000);
