// Refresh enabled layers without reloading the page or moving the map.
(function(){
  const jobs=[];
  const latest=()=>!playing && Number($('timeline').value)===Number($('timeline').max);
  const enabled=id=>!!$(id)?.checked;
  function add(name,period,needed,run){jobs.push({name,period,needed,run,last:Date.now(),busy:false});}
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
