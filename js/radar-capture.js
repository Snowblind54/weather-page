// Prepare radar without adding layers or changing the selected weather time.
let radarPreloadTimer=null,radarPreloadGeneration=0,radarPreloadRunning=false,radarPreloadAgain=false;
function radarPreloadVisible(bounds){return map.getBounds().intersects(L.latLngBounds(bounds));}
function radarPreloadAllowed(generation){
  return generation===radarPreloadGeneration&&!document.hidden&&!$('radarOn').checked;
}
function pauseRadarPreload(){
  radarPreloadGeneration++;clearTimeout(radarPreloadTimer);radarPreloadTimer=null;
}
function scheduleRadarPreload(delay=1200){
  pauseRadarPreload();
  if(document.hidden||$('radarOn').checked)return;
  radarPreloadTimer=setTimeout(()=>{
    radarPreloadTimer=null;
    if('requestIdleCallback' in window)requestIdleCallback(()=>preloadVisibleRadars(),{timeout:2000});
    else preloadVisibleRadars();
  },delay);
}
async function preloadVisibleRadars(){
  if(document.hidden||$('radarOn').checked)return;
  if(radarPreloadRunning){radarPreloadAgain=true;return;}
  radarPreloadRunning=true;
  const generation=radarPreloadGeneration,allowed=()=>radarPreloadAllowed(generation);
  const visible=NORDIC_RADAR_SOURCES.filter(nordicRadarVisible),edge=nordicRadarEdge();
  const latest=(typeof frames!=='undefined'?frames.at(-1)?.time:0)||Math.floor(Date.now()/1000/300)*300-300;
  const target=visible.some(source=>source.id==='is')?Math.floor(Date.now()/1000/300)*300-300:latest;
  const recent=navigator.connection?.saveData||typeof radarLightMode==='function'&&radarLightMode()?0:2;
  const tasks=[];
  try{
    // A slow metadata endpoint must not hold up other countries' latest images.
    const latestTasks=visible.map(async source=>{
      if(typeof preparedRadarFrame==='function'){
        const prepare=async back=>{if(!allowed())return null;return preparedRadarFrame(source.id,target-back*300,{background:true,canPrepare:allowed});};
        const ready=await prepare(0);
        if(ready){tasks.push(prepare);return;}
      }
      const records=await listNordicRadar(source);
      if(!allowed())return;
      for(const station of new Set(records.map(record=>record.station))){
        const observations=records.filter(record=>record.station===station);
        const prepare=async back=>{
          // Keep the latest full-resolution DMI canvas within the cache budget.
          if(source.id==='dk'&&edge>1400&&back)return;
          const record=radarObservationAt(observations,target-back*300);
          if(record&&radarRecordVisible(record))await nordicRadarFrame(record,edge,{background:true,canPrepare:allowed});
        };
        tasks.push(prepare);if(!allowed())break;
        await prepare(0);
      }
    });
    if(radarPreloadVisible(RADAR_BOUNDS)){
      const prepare=async back=>{
        const observations=typeof radarTimelineFrames!=='undefined'?radarTimelineFrames:frames;
        const frame=radarObservationAt(observations,target-back*300);
        if(frame?.url&&!(typeof preparedRadarFrame==='function'&&await preparedRadarFrame('ee',frame.time,{background:true,canPrepare:allowed})))await h5ToRadarImage(frame,{quiet:true});
      };tasks.push(prepare);latestTasks.push(prepare(0));
    }
    for(const source of visibleBalticRadarSources()){
      const prepare=back=>prepareBalticRadarFrame(source,target-back*300,latest);
      tasks.push(prepare);latestTasks.push(prepare(0));
    }
    await Promise.allSettled(latestTasks);
    for(let back=1;back<=recent&&allowed();back++){
      for(const prepare of tasks){
        if(!allowed())break;
        // Yield between conversions so the map and other layers stay usable.
        await new Promise(resolve=>setTimeout(resolve,80));
        if(!allowed())break;
        try{await prepare(back);}catch(_){/* Enabling radar reports source failures normally. */}
      }
    }
  }finally{
    radarPreloadRunning=false;
    const again=radarPreloadAgain||generation!==radarPreloadGeneration;radarPreloadAgain=false;
    if(!document.hidden&&!$('radarOn').checked)scheduleRadarPreload(again?500:120000);
  }
}
map.on('moveend',()=>scheduleRadarPreload());
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseRadarPreload();else scheduleRadarPreload();});


// Rolling playback window: selected frames retain priority over these jobs.
let radarPlaybackPreloadTimer=null,radarPlaybackPreloadGeneration=0,radarPlaybackPreloadRunning=false,radarPlaybackPreloadAgain=false;
let radarSelectedFrameTime=null,radarSelectedFrameReady=false,radarSelectedFrameGeneration=0;
function beginRadarSelectedFrame(time){
  radarSelectedFrameTime=time;radarSelectedFrameReady=false;
  invalidateRadarPlaybackPreload();
  return ++radarSelectedFrameGeneration;
}
function finishRadarSelectedFrame(time,generation){
  if(time!==radarSelectedFrameTime||generation!==radarSelectedFrameGeneration)return;
  radarSelectedFrameReady=true;scheduleRadarPlaybackPreload();
}
function scheduleRadarPlaybackPreload(){
  if(document.hidden||!$('radarOn').checked||!radarSelectedFrameReady)return;
  clearTimeout(radarPlaybackPreloadTimer);
  radarPlaybackPreloadTimer=setTimeout(()=>{radarPlaybackPreloadTimer=null;preloadRadarPlayback();},60);
}
function invalidateRadarPlaybackPreload(){
  radarPlaybackPreloadGeneration++;clearTimeout(radarPlaybackPreloadTimer);radarPlaybackPreloadTimer=null;
}
function radarPlaybackTargets(){
  const index=Number($('timeline').value),count=frames.length,saveData=navigator.connection?.saveData;
  if(!count)return [];
  const light=typeof radarLightMode==='function'&&radarLightMode();
  const offsets=saveData?[1]:light?[1,2,-1]:[1,2,3,4,5,6,-1,-2];
  return [...new Set(offsets.map(offset=>(index+offset+count)%count))].filter(i=>i!==index).map(i=>frames[i]);
}
async function preloadRadarPlayback(){
  if(document.hidden||!$('radarOn').checked||!radarSelectedFrameReady)return;
  if(radarPlaybackPreloadRunning){radarPlaybackPreloadAgain=true;return;}
  radarPlaybackPreloadRunning=true;
  const generation=radarPlaybackPreloadGeneration;
  const allowed=()=>generation===radarPlaybackPreloadGeneration&&!document.hidden&&$('radarOn').checked&&radarSelectedFrameReady;
  const targets=radarPlaybackTargets(),latest=frames.at(-1)?.time,edge=nordicRadarEdge();
  const visible=NORDIC_RADAR_SOURCES.filter(nordicRadarVisible);
  try{
  const tasks=visible.map(async source=>{
    const remaining=[];
    for(const target of targets){
      if(!allowed())return;
      if(!(typeof preparedRadarFrame==='function'&&await preparedRadarFrame(source.id,target.time,{background:true,canPrepare:allowed})))remaining.push(target);
    }
    if(!remaining.length)return;
    const records=await listNordicRadar(source);
    const stations=[...new Set(records.map(record=>record.station))];
    for(const target of remaining){
      if(!allowed())break;
      // Start the stations for this observation together so Iceland's three
      // scans can fill both preparation slots before moving to the next hour.
      await Promise.allSettled(stations.map(async station=>{
        if(!allowed())return;
        const record=radarObservationAt(records.filter(record=>record.station===station),target.time);
        if(record&&radarRecordVisible(record))await nordicRadarFrame(record,edge,{background:true,canPrepare:allowed});
      }));
    }
  });
  if(radarPreloadVisible(RADAR_BOUNDS))tasks.push((async()=>{
    for(const target of targets){if(!allowed())break;try{if(target.url&&!(typeof preparedRadarFrame==='function'&&await preparedRadarFrame('ee',target.time,{background:true,canPrepare:allowed})))await h5ToRadarImage(target,{quiet:true});}catch(_){}
      await new Promise(resolve=>setTimeout(resolve,80));}
  })());
  for(const source of visibleBalticRadarSources())tasks.push((async()=>{
    for(const target of targets){if(!allowed())break;try{await prepareBalticRadarFrame(source,target.time,latest);}catch(_){}}
  })());
  await Promise.allSettled(tasks);
  }finally{
    radarPlaybackPreloadRunning=false;
    const again=radarPlaybackPreloadAgain||generation!==radarPlaybackPreloadGeneration;radarPlaybackPreloadAgain=false;
    if(again)scheduleRadarPlaybackPreload();
  }
}
map.on('moveend',()=>{radarSelectedFrameReady=false;invalidateRadarPlaybackPreload();});
$('radarOn').addEventListener('change',()=>{invalidateRadarPlaybackPreload();if($('radarOn').checked)scheduleRadarPlaybackPreload();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidateRadarPlaybackPreload();else scheduleRadarPlaybackPreload();});
