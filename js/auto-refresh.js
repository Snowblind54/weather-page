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

// Blend fresh official wind observations into the modeled wind field.
(function(){
  if(typeof windAt!=='function'||typeof windGustAt!=='function'||!globalThis.WindObservationBlend)return;

  const modelWindAt=windAt,modelWindGustAt=windGustAt;
  const baseOfficialWindNeeded=typeof officialWindNeeded==='function'?officialWindNeeded:null;
  const baseLoadWind=typeof loadWind==='function'?loadWind:null;
  const baseLoadOfficialWind=typeof loadOfficialWind==='function'?loadOfficialWind:null;
  const baseHeatmapReset=typeof WindHeatmapLayer!=='undefined'?WindHeatmapLayer.prototype.reset:null;
  const correctionCache=new Map();
  let suppressIntegratedBlend=false;

  function sliceUnix(slice){
    if(!slice||!windData?.times?.length)return Math.floor(Date.now()/1000);
    if(Number.isFinite(slice.time))return slice.time;
    const a=windData.times[slice.i],b=windData.times[slice.i+1];
    return Number.isFinite(a)&&Number.isFinite(b)?a+(b-a)*slice.f:Math.floor(Date.now()/1000);
  }
  function correctionIndex(corrections){
    const cell=2,bins=new Map();
    for(const correction of corrections){
      const lon=((correction.lon+180)%360+360)%360-180;
      const key=Math.floor(correction.lat/cell)+','+Math.floor(lon/cell);
      if(!bins.has(key))bins.set(key,[]);
      bins.get(key).push(correction);
    }
    return {cell,bins,count:corrections.length};
  }
  function nearbyCorrections(index,lat,lon){
    if(!index?.count)return [];
    lon=((lon+180)%360+360)%360-180;
    const cy=Math.floor(lat/index.cell),cx=Math.floor(lon/index.cell),out=[];
    const radiusKm=globalThis.WindObservationBlend.RADIUS_KM||70;
    const latBins=Math.ceil((radiusKm/110.6)/index.cell)+1;
    const cos=Math.max(.08,Math.cos(lat*Math.PI/180));
    const lonBins=Math.ceil((radiusKm/(111.3*cos))/index.cell)+1;
    for(let dy=-latBins;dy<=latBins;dy++)for(let dx=-lonBins;dx<=lonBins;dx++){
      const rows=index.bins.get((cy+dy)+','+(cx+dx));
      if(rows)out.push(...rows);
    }
    return out;
  }
  function correctionsFor(unix,slice,mode){
    if(!officialWindData||typeof officialWindReading!=='function'||!windData)return {corrections:[],index:null};
    const now=Date.now()/1000;
    // A current observation should not rewrite a future forecast.
    if(unix>now+15*60)return {corrections:[],index:null};
    const modelStamp=windData.generatedAt||windData.savedAt||0;
    const key=[mode,officialWindData.generatedAt,modelStamp,Math.floor(unix/60),slice?.i,Math.round((slice?.f||0)*1000)].join('/');
    if(correctionCache.has(key))return correctionCache.get(key);
    const corrections=[];
    for(const station of officialWindData.stations){
      const reading=officialWindReading(station,unix);
      if(!reading)continue;
      const observed=mode==='gust'?reading[2]:reading[1];
      if(!Number.isFinite(observed))continue;
      let model=null;
      if(mode==='gust')model=modelWindGustAt(station.lat,station.lon,slice);
      else{
        const vector=modelWindAt(station.lat,station.lon,slice);
        if(vector)model=Math.hypot(vector[0],vector[1]);
      }
      if(!Number.isFinite(model))continue;
      const age=Math.max(0,Math.min(unix,now)-reading[0]);
      const correction=globalThis.WindObservationBlend.makeCorrection(
        station.lat,station.lon,observed,model,age
      );
      if(correction)corrections.push(correction);
    }
    const state={corrections,index:correctionIndex(corrections)};
    correctionCache.set(key,state);
    if(correctionCache.size>8){
      const oldest=correctionCache.keys().next().value;
      correctionCache.delete(oldest);
    }
    return state;
  }
  function adjustedSpeed(base,lat,lon,state){
    if(!Number.isFinite(base)||!state?.index?.count)return base;
    const nearby=nearbyCorrections(state.index,lat,lon);
    return nearby.length?globalThis.WindObservationBlend.adjustSpeed(base,lat,lon,nearby):base;
  }

  // Keep the heatmap's existing single-pass blending, but use the same cached
  // correction set and high-latitude-aware station lookup as the particle field.
  if(typeof windHeatmapCorrections==='function'){
    windHeatmapCorrections=(unix,slice,mode)=>correctionsFor(unix,slice,mode).corrections;
  }
  if(typeof windHeatmapCorrectionIndex==='function')windHeatmapCorrectionIndex=correctionIndex;
  if(typeof windHeatmapNearbyCorrections==='function')windHeatmapNearbyCorrections=nearbyCorrections;

  // wind.js already applies observations explicitly inside its heatmap reset.
  // Suppress the wrappers below during that reset so heatmap values are not
  // corrected twice.
  if(baseHeatmapReset){
    WindHeatmapLayer.prototype.reset=function(){
      suppressIntegratedBlend=true;
      try{return baseHeatmapReset.apply(this,arguments);}
      finally{suppressIntegratedBlend=false;}
    };
  }

  windAt=function(lat,lon,slice){
    const vector=modelWindAt(lat,lon,slice);
    if(suppressIntegratedBlend||!vector)return vector;
    const base=Math.hypot(vector[0],vector[1]);
    if(base<=0.01)return vector;
    const state=correctionsFor(sliceUnix(slice),slice,'sustained');
    const speed=adjustedSpeed(base,lat,lon,state);
    if(!Number.isFinite(speed)||Math.abs(speed-base)<1e-6)return vector;
    const scale=speed/base;
    return [vector[0]*scale,vector[1]*scale];
  };

  windGustAt=function(lat,lon,slice,details=false){
    const sample=modelWindGustAt(lat,lon,slice,true);
    if(!sample)return null;
    if(suppressIntegratedBlend)return details?sample:sample.value;
    const state=correctionsFor(sliceUnix(slice),slice,'gust');
    const value=adjustedSpeed(sample.value,lat,lon,state);
    const result={...sample,value};
    return details?result:value;
  };

  // The field now needs the lightweight measured snapshot even when station
  // number labels and the heatmap are both switched off.
  if(baseOfficialWindNeeded){
    officialWindNeeded=function(){
      return baseOfficialWindNeeded()||!!$('windOn')?.checked;
    };
  }

  function refreshFieldFromObservations(){
    correctionCache.clear();
    if(typeof windLayer!=='undefined'&&windLayer){
      windLayer.fieldKey='';
      windLayer.scheduleReset?.();
    }
    if(typeof windHeatmapLayer!=='undefined'&&windHeatmapLayer)windHeatmapLayer.scheduleReset?.();
    if(typeof updateWindPopup==='function')updateWindPopup();
  }

  if(baseLoadOfficialWind){
    loadOfficialWind=async function(force=false){
      const before=officialWindData?.generatedAt||0;
      const result=await baseLoadOfficialWind(force);
      const after=officialWindData?.generatedAt||0;
      if(after&&after!==before)refreshFieldFromObservations();
      return result;
    };
  }

  if(baseLoadWind){
    loadWind=async function(){
      // Do not hold up the model field while the small station snapshot arrives.
      if(typeof loadOfficialWind==='function'&&officialWindNeeded()){
        Promise.resolve(loadOfficialWind(false)).catch(error=>console.warn('Wind observation blend:',error.message));
      }
      return baseLoadWind.apply(this,arguments);
    };
  }

  if(typeof windPopupContent==='function'){
    const baseWindPopupContent=windPopupContent;
    windPopupContent=function(point,unix){
      let html=baseWindPopupContent(point,unix);
      const slice=windTimeSlice(unix);
      if(!slice)return html;
      const sustained=correctionsFor(unix,slice,'sustained');
      const gust=correctionsFor(unix,slice,'gust');
      const sustainedNearby=nearbyCorrections(sustained.index,point.lat,point.lng).length;
      const gustNearby=nearbyCorrections(gust.index,point.lat,point.lng).length;
      if(sustainedNearby)html=html.replace(
        '10 m model wind · interpolated estimate',
        `10 m model wind · locally corrected by ${sustainedNearby} official reading${sustainedNearby===1?'':'s'}`
      );
      if(gustNearby)html=html.replace(
        'Hourly model gust estimate',
        `Hourly model gust · locally corrected by ${gustNearby} official reading${gustNearby===1?'':'s'}`
      );
      return html;
    };
  }

  if(typeof document!=='undefined'&&document.title){
    document.title=document.title.replace(/v\d+(?:\.\d+)*/, 'v8.122');
  }
})();