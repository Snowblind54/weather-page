// Refresh enabled layers without reloading the page or moving the map.
(function(){
  const jobs=[];
  const latest=()=>!playing && Number($('timeline').value)===Number($('timeline').max);
  const enabled=id=>!!$(id)?.checked;
  function add(name,period,needed,run){jobs.push({name,period,needed,run,last:Date.now(),busy:false});}

  // Measured wind must react immediately to its own controls. The shared
  // snapshot is deliberately lightweight; the 24 h history remains lazy and
  // is fetched only by the station popup in official-wind.js.
  function updateMeasuredWind(id){
    if(typeof syncWindFieldToOfficial==='function')syncWindFieldToOfficial(id);
    if(typeof renderOfficialWind==='function')renderOfficialWind();
    if(typeof officialWindNeeded==='function'&&officialWindNeeded()&&typeof loadOfficialWind==='function'){
      Promise.resolve(loadOfficialWind(false)).catch(error=>console.warn('Measured wind load:',error.message));
    }
  }
  for(const id of ['officialWindSustained','officialWindGusts']){
    $(id)?.addEventListener('change',()=>updateMeasuredWind(id));
  }

  // Station labels are viewport-cropped for performance, so rebuild them after
  // every completed pan/zoom. Without this, only the viewport that happened to
  // trigger the previous render would retain labels.
  const refreshMeasuredWindViewport=()=>{
    if(typeof officialWindEnabled==='function'&&officialWindEnabled()&&typeof renderOfficialWind==='function'){
      renderOfficialWind();
    }
  };
  map.on('moveend',refreshMeasuredWindViewport);
  map.on('zoomend',refreshMeasuredWindViewport);

  add('timeline',120000,()=>!playing && (enabled('radarOn')||enabled('cloudOn')||temperatureEnabled()||windVisualEnabled()),
    ()=>loadOfficialRadarList({preserveSelection:true,skipCloud:true,automatic:true}));
  add('satellite',120000,()=>enabled('cloudOn')&&latest(),async()=>{
    await cloudEnsureMetadata(true);
    // A user may have selected history or switched clouds off during discovery.
    if(document.hidden||!enabled('cloudOn')||!latest())return;
    await drawCloud({time:Math.floor(Date.now()/1000)});
  });
  add('temperature',300000,()=>temperatureEnabled(),()=>loadTemperatures(false));
  add('wind',300000,()=>windVisualEnabled(),()=>loadWind());
  add('measured wind',300000,
    ()=>typeof officialWindNeeded==='function'&&officialWindNeeded(),
    ()=>typeof loadOfficialWind==='function'?loadOfficialWind(false):undefined);
  add('warnings',600000,()=>enabled('warningOn'),()=>loadWarnings(true));
  add('cyclones',600000,()=>enabled('cycloneOn'),()=>loadCyclones(false));
  add('rainfall',300000,()=>!!activeAccumulationHours(),()=>loadRainfall(false));
  function tick(wake=false){
    if(document.hidden)return;
    for(const job of jobs){
      if(job.busy||!job.needed()||(!wake&&Date.now()-job.last<job.period))continue;
      job.busy=true;job.last=Date.now();
      Promise.resolve().then(job.run).catch(error=>console.warn('Automatic '+job.name+' refresh:',error.message))
        .finally(()=>{job.busy=false;});
    }
  }
  setInterval(()=>tick(),30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick(true);});
  window.addEventListener('online',()=>tick(true));
  window.addEventListener('pageshow',event=>{if(event.persisted)tick(true);});
})();
