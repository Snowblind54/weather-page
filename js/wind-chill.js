// Wind-chill mode for the Temperature section.
// Official labels use measured air temperature + measured sustained wind from
// nearby official stations. The heatmap starts from the model field and is
// locally corrected toward those paired official observations.
(function installWindChillMode(){
  if(typeof $!=='function'||typeof map==='undefined'||typeof renderTemperatureLabels!=='function'||typeof buildTemperatureOverlay!=='function'){
    setTimeout(installWindChillMode,50);return;
  }

  const WIND_CHILL_PAIR_RADIUS_KM=25;
  const WIND_CHILL_PAIR_TIME_SEC=45*60;
  const WIND_CHILL_EXACT_STATION_TIME_SEC=75*60;
  const WIND_CHILL_MAX_AGE_SEC=95*60;
  const WIND_CHILL_MODEL_EDGE_TOLERANCE_SEC=90*60;
  const WIND_CHILL_MODEL_URL='data/model-wind.json';
  let windChillModelPromise=null;

  function windChillMode(){return $('tempMode')?.value==='windchill';}

  // Environment Canada / WMO-style wind chill index. The published equation
  // is intended for T <= 10 C and wind > 4.8 km/h; outside that domain the
  // displayed wind-chill value simply remains the measured/model air temp.
  function windChillC(tempC,windMs){
    if(!Number.isFinite(tempC)||!Number.isFinite(windMs))return NaN;
    const windKmh=Math.max(0,windMs)*3.6;
    if(tempC>10||windKmh<=4.8)return tempC;
    const p=Math.pow(windKmh,0.16);
    return 13.12+0.6215*tempC-11.37*p+0.3965*tempC*p;
  }
  window.windChillC=windChillC;

  function distanceKm(a,b){
    return temperatureObservationDistanceKm(a.lat,a.lon,b.lat,b.lon);
  }

  function officialWindForTemperatureStation(tempStation,unix){
    if(!officialWindData?.stations?.length)return null;
    let best=null,bestDistance=Infinity;
    for(const windStation of officialWindData.stations){
      if(windStation.country!==tempStation.country)continue;
      const reading=officialWindReading(windStation,unix);
      if(!reading||!Number.isFinite(reading[1]))continue;

      const exactStation=!!(tempStation.code&&windStation.code&&String(tempStation.code)===String(windStation.code));
      const tempTime=Number(tempStation.time),windTime=Number(reading[0]);
      const maxTimeDifference=exactStation?WIND_CHILL_EXACT_STATION_TIME_SEC:WIND_CHILL_PAIR_TIME_SEC;
      if(Number.isFinite(tempTime)&&Math.abs(tempTime-windTime)>maxTimeDifference)continue;
      if(unix-windTime>WIND_CHILL_MAX_AGE_SEC)continue;

      let d=exactStation?0:distanceKm(tempStation,windStation);
      if(d<=WIND_CHILL_PAIR_RADIUS_KM&&d<bestDistance){bestDistance=d;best={station:windStation,reading,distance:d,exactStation};}
    }
    return best;
  }

  function officialWindChillStations(unix){
    if(typeof officialStationsNearTime!=='function')return [];
    const out=[];
    for(const tempStation of officialStationsNearTime(unix)){
      const pair=officialWindForTemperatureStation(tempStation,unix);
      if(pair){
        const chill=windChillC(tempStation.temp,pair.reading[1]);
        if(!Number.isFinite(chill))continue;
        out.push({...tempStation,windChill:chill,windSpeed:pair.reading[1],windTime:pair.reading[0],windStation:pair.station,windDistanceKm:pair.distance,windExactStation:pair.exactStation,windSource:'official'});
        continue;
      }

      // Do not blank the wind-chill field just because two national station
      // networks do not share a station/time. The air temperature remains an
      // official observation; only the missing sustained wind falls back to
      // the same shared 10 m model field used by the map background.
      const modelSpeed=modelWindSpeedAt(tempStation.lat,tempStation.lon,unix);
      if(!Number.isFinite(modelSpeed))continue;
      const chill=windChillC(tempStation.temp,modelSpeed);
      if(!Number.isFinite(chill))continue;
      out.push({...tempStation,windChill:chill,windSpeed:modelSpeed,windTime:unix,windStation:null,windDistanceKm:null,windExactStation:false,windSource:'model'});
    }
    return out;
  }
  window.officialWindChillStations=officialWindChillStations;

  async function ensureModelWind(force=false){
    if(!force&&windData&&Date.now()-windData.savedAt<45*60*1000)return windData;
    if(windChillModelPromise)return windChillModelPromise;
    windChillModelPromise=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const bucket=Math.floor(Date.now()/(5*60*1000));
        const response=await fetch(`${WIND_CHILL_MODEL_URL}?v=${bucket}`,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('wind model HTTP '+response.status);
        const data=await response.json();
        if(typeof validWindData==='function'&&!validWindData(data))throw new Error('invalid shared wind model');
        data.generatedAt=data.savedAt;data.savedAt=Date.now();windData=data;windRetryAt=0;
        try{localStorage.setItem(WIND_CACHE_KEY,JSON.stringify(data));}catch(_){}
        return data;
      }finally{clearTimeout(timer);}
    })();
    try{return await windChillModelPromise;}finally{windChillModelPromise=null;}
  }

  const baseOfficialWindNeeded=typeof officialWindNeeded==='function'?officialWindNeeded:null;
  if(baseOfficialWindNeeded){officialWindNeeded=function(){return baseOfficialWindNeeded()||windChillMode();};}

  async function ensureWindChillInputs(force=false){
    const tasks=[ensureModelWind(force),loadAmericasTemperatureData(force||!TEMP_GRID_SPECS.filter(s=>s.shared).every(s=>temperatureGridData.get(s.id)?.some(p=>p.wind)))];
    if(typeof loadOfficialWind==='function')tasks.push(loadOfficialWind(force));
    const results=await Promise.allSettled(tasks);
    // Model wind is mandatory for the continuous field. Official wind is an
    // enhancement for labels and may fail without disabling wind chill.
    if(results[0]?.status==='rejected'&&!TEMP_GRID_SPECS.filter(s=>s.shared).some(s=>temperatureGridData.get(s.id)?.some(p=>p.wind)))throw results[0].reason;
    return results;
  }

  function modelWindSlice(unix){
    if(!windData?.times?.length)return null;
    let slice=windTimeSlice(unix);
    if(slice)return slice;
    const first=windData.times[0],last=windData.times.at(-1);
    const edge=unix<first?first:(unix>last?last:null);
    if(edge===null||Math.abs(unix-edge)>WIND_CHILL_MODEL_EDGE_TOLERANCE_SEC)return null;
    return windTimeSlice(edge);
  }

  const americasWindSlices=new Map();
  function sharedWindSpeedAt(lat,lon,unix){
    const spec=TEMP_GRID_SPECS.find(s=>s.shared&&axisBracket(s.latitudes,lat)&&axisBracket(s.longitudes,lon));
    if(!spec)return null;
    const series=temperatureGridData.get(spec.id);
    if(!series?.length||!series[0].wind)return NaN;
    let cached=americasWindSlices.get(spec.id);
    if(!cached||cached.time!==unix||cached.series!==series){
      const components=[[],[]];
      for(const p of series){
        let vector=null;
        if(p.wind&&unix>=p.times[0]&&unix<=p.times.at(-1)){
          const bracket=axisBracket(p.times,unix);
          const a=p.wind[bracket.i0],b=p.wind[bracket.i1];
          vector=[0,1].map(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])?a[k]+(b[k]-a[k])*bracket.f:NaN);
        }
        components[0].push(vector?.[0]??NaN);components[1].push(vector?.[1]??NaN);
      }
      cached={time:unix,series,components};americasWindSlices.set(spec.id,cached);
    }
    const latB=axisBracket(spec.latitudes,lat),lonB=axisBracket(spec.longitudes,lon);
    return Math.hypot(...cached.components.map(values=>bilinearValue(values,spec.longitudes.length,latB,lonB)));
  }
  function modelWindSpeedAt(lat,lon,unix){
    const shared=sharedWindSpeedAt(lat,lon,unix);
    if(shared!==null)return shared;
    if(!windData)return NaN;
    const vector=windAt(lat,lon,modelWindSlice(unix));
    return vector?Math.hypot(vector[0],vector[1]):NaN;
  }

  function modelWindChillAt(lat,lon,unix,tempOverride=NaN){
    const temp=Number.isFinite(tempOverride)?tempOverride:interpolateTemp(lat,lon,unix);
    return windChillC(temp,modelWindSpeedAt(lat,lon,unix));
  }

  function windChillCorrections(unix){
    const out=[];
    for(const station of officialWindChillStations(unix)){
      const model=modelWindChillAt(station.lat,station.lon,unix);
      if(!Number.isFinite(model))continue;
      const ageWeight=temperatureObservationAgeWeight(Math.max(0,unix-Math.min(station.time,station.windTime)));
      if(ageWeight<=0)continue;
      out.push({lat:station.lat,lon:station.lon,ageWeight,bias:Math.max(-15,Math.min(15,station.windChill-model))});
    }
    return out;
  }

  const baseCreateTemperatureImage=createTemperatureImage;
  createTemperatureImage=async function(unix,token){
    if(!windChillMode())return baseCreateTemperatureImage(unix,token);
    await ensureWindChillInputs(false);
    const cacheTime=nearestQuarterHour(unix),cacheKey='windchill/'+cacheTime;
    if(temperatureImageCache.has(cacheKey)){
      const cached=temperatureImageCache.get(cacheKey),stats=temperatureStatsCache.get(cacheKey);
      return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT,correctionCount:stats.correctionCount||0};
    }

    const corrections=windChillCorrections(cacheTime),rendered=[];
    let globalMin=Infinity,globalMax=-Infinity;
    const countryFeatures=await loadTemperatureCountryFeatures();

    for(const region of TEMP_REGIONS){
      const spec=TEMP_GRID_SPECS.find(item=>item.id===region.id),sourceSeries=temperatureGridData.get(region.id);
      if(!spec||!sourceSeries?.length)continue;
      const tempValues=sourceSeries.map(item=>sampleTemperatureGridPoint(spec,item,cacheTime));
      const cols=spec.longitudes.length,W=region.w,H=region.h;
      const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
      const ctx=canvas.getContext('2d',{alpha:true}),img=ctx.createImageData(W,H),d=img.data;
      const west=region.bounds[0][1],east=region.bounds[1][1];
      const lonValues=Array.from({length:W},(_,x)=>west+(x/(W-1))*(east-west));
      const lonLookup=lonValues.map(lon=>axisBracket(spec.longitudes,lon));
      const latValues=Array.from({length:H},(_,y)=>rasterLatitudeForRow(region,y,H));
      const latLookup=latValues.map(lat=>axisBracket(spec.latitudes,lat));
      const correctionRaster=buildTemperatureCorrectionRaster(region,W,H,corrections,latValues,lonValues);

      for(let y=0;y<H;y++){
        if(token!==temperatureRenderToken)return null;
        const latB=latLookup[y],lat=latValues[y];
        for(let x=0;x<W;x++){
          const temp=bilinearValue(tempValues,cols,latB,lonLookup[x]),i=(y*W+x)*4;
          if(!Number.isFinite(temp)){d[i+3]=0;continue;}
          let value=modelWindChillAt(lat,lonValues[x],cacheTime,temp);
          if(!Number.isFinite(value)){d[i+3]=0;continue;}
          if(corrections.length){const p=y*W+x;value=temperatureAdjustedFromRaster(value,p,correctionRaster.weightedBias,correctionRaster.weightTotal);}
          globalMin=Math.min(globalMin,value);globalMax=Math.max(globalMax,value);
          const c=tempColor(value);d[i]=c[0];d[i+1]=c[1];d[i+2]=c[2];d[i+3]=205;
        }
        if(y%64===0)await new Promise(requestAnimationFrame);
      }
      ctx.putImageData(img,0,0);
      if(!clipTemperatureToCountries(ctx,region,W,H,countryFeatures))throw new Error('coastline mask missing for '+region.id);
      rendered.push({id:region.id,bounds:region.bounds,coastlineClipped:true,dataUrl:canvas.toDataURL('image/png')});
    }
    if(token!==temperatureRenderToken)return null;
    temperatureImageCache.set(cacheKey,rendered);
    temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax,correctionCount:corrections.length});
    while(temperatureImageCache.size>TEMP_CACHE_LIMIT){const oldest=temperatureImageCache.keys().next().value;temperatureImageCache.delete(oldest);temperatureStatsCache.delete(oldest);}
    return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax,correctionCount:corrections.length};
  };

  const baseRenderTemperatureLabels=renderTemperatureLabels;
  renderTemperatureLabels=function(unix){
    if(!windChillMode()){
      // Air-temperature numbers should mean one thing: official measured
      // station observations. stations.js also adds non-interactive model
      // labels as filler; remove those synchronously so they cannot flash in
      // first and then disappear when the official snapshot finishes loading.
      baseRenderTemperatureLabels(unix);
      const modelLabels=[];
      temperatureLabels.eachLayer(layer=>{
        if(layer?.options?.interactive===false)modelLabels.push(layer);
      });
      for(const layer of modelLabels)temperatureLabels.removeLayer(layer);
      return;
    }
    if(map.hasLayer(temperatureLabels))map.removeLayer(temperatureLabels);temperatureLabels.clearLayers();
    if(!$('tempOn').checked)return;
    const bounds=map.getBounds(),occupied=[];
    const zoom=map.getZoom(),gapX=zoom>=9?46:zoom>=7?52:58,gapY=zoom>=9?23:28;
    const pairs=officialWindChillStations(unix).filter(s=>bounds.contains([s.lat,s.lon])).sort((a,b)=>a.windChill-b.windChill);
    for(const station of pairs){
      const p=map.latLngToContainerPoint([station.lat,station.lon]);
      if(occupied.some(q=>Math.abs(q.x-p.x)<gapX&&Math.abs(q.y-p.y)<gapY))continue;occupied.push(p);
      const marker=L.marker([station.lat,station.lon],{interactive:true,keyboard:true,title:`${station.name} · official wind chill`,icon:L.divIcon({className:'',html:`<div class="temp-label temp-label-observed"><span class="temp-observed-dot">●</span>${(globalThis.WeatherUnits?.temperature(station.windChill,0)??Math.round(station.windChill)+'°C')}</div>`,iconSize:[58,22],iconAnchor:[29,11]})});
      const tempTime=Number.isFinite(station.time)?fmt(station.time):'unavailable';
      const officialWind=station.windSource==='official'&&station.windStation;
      const windTime=officialWind?fmt(station.windTime):fmt(unix);
      const pairing=officialWind
        ? (station.windExactStation?'Same official station':`Wind station ${station.windDistanceKm.toFixed(0)} km away`)
        : 'Model wind at temperature station';
      const windLabel=officialWind?'Official measured sustained wind':'Model 10 m sustained wind';
      const sourceLine=officialWind
        ? `Wind chill calculated from paired official observations. ${htmlEscape(pairing)} · ${htmlEscape(station.windStation.name)}`
        : 'Wind chill calculated from official measured air temperature plus the shared 10 m model wind field.';
      marker.bindPopup(`<div class="temp-station-popup"><b>${htmlEscape(station.name)}</b><div style="font-size:24px;font-weight:800;margin:5px 0">Wind chill ${(globalThis.WeatherUnits?.temperature(station.windChill,1)??station.windChill.toFixed(1)+'°C')}</div><div>Official measured air temperature: ${(globalThis.WeatherUnits?.temperature(station.temp,1)??station.temp.toFixed(1)+'°C')}</div><div>${windLabel}: ${(globalThis.WeatherUnits?.wind(station.windSpeed,1)??station.windSpeed.toFixed(1)+' m/s')}</div><div class="wind-popup-meta">Temperature observed ${htmlEscape(tempTime)}<br>Wind time ${htmlEscape(windTime)}</div><div class="wind-popup-meta">${sourceLine}</div></div>`,{maxWidth:310,className:'wind-popup-container',autoPan:false});
      marker.addTo(temperatureLabels);
    }
    temperatureLabels.addTo(map);
  };

  const baseBuildTemperatureOverlay=buildTemperatureOverlay;
  buildTemperatureOverlay=async function(unix,options={}){
    if(windChillMode())await ensureWindChillInputs(false);
    const result=await baseBuildTemperatureOverlay(unix,options);
    if(!windChillMode()||options.precache)return result;
    const pairs=officialWindChillStations(unix);
    if($('tempStatus').classList.contains('ok')){
      $('tempStatus').textContent=`Wind chill: model background + ${pairs.length} paired official temperature/wind observations${$('heatmapOn')?.checked?' · coastline clipped':''} · ${fmt(unix)}`;
    }
    return result;
  };

  const baseLoadTemperatures=loadTemperatures;
  loadTemperatures=async function(force=false){
    await baseLoadTemperatures(force);
    if(windChillMode()){
      await ensureWindChillInputs(force);
      const frame=frames[Number($('timeline').value)];if(frame&&temperatureEnabled())queueTemperatureRender(frame.time,0);
    }
  };

  // stations.js predates Latvia temperature observations. Include Latvia in
  // the compact source summary as soon as the new shared snapshot provides it.
  const baseOfficialStationSourceSummary=typeof officialStationSourceSummary==='function'?officialStationSourceSummary:null;
  if(baseOfficialStationSourceSummary){
    officialStationSourceSummary=function(){
      const summary=baseOfficialStationSourceSummary();
      const lv=officialTemperatureSourceState?.LV;
      if(lv?.ok&&lv.count&&!summary.good.includes('LV'))summary.good.push('LV');
      else if(lv&&!lv.ok&&!summary.bad.includes('LV'))summary.bad.push('LV');
      return summary;
    };
  }

  // Add one compact selector to the existing Temperature controls.
  if(!$('tempMode')){
    const details=$('tempSection')?.querySelector('.details');
    if(details){
      const wrap=document.createElement('div');
      wrap.innerHTML='<label class="small" for="tempMode">Temperature field</label><select id="tempMode" aria-label="Temperature field"><option value="temperature">Air temperature</option><option value="windchill">Wind chill</option></select>';
      details.insertBefore(wrap,details.firstChild);
      $('tempMode').addEventListener('change',async()=>{
        invalidateTemperatureHeatmapCache();temperatureRenderToken++;
        if(temperatureDebounceTimer)clearTimeout(temperatureDebounceTimer);
        if(temperaturePrecacheTimer)clearTimeout(temperaturePrecacheTimer);
        if(temperatureLayer){map.removeLayer(temperatureLayer);temperatureLayer=null;}
        if(map.hasLayer(temperatureLabels))map.removeLayer(temperatureLabels);
        temperatureLabels.clearLayers();

        const frame=frames[Number($('timeline').value)]||frames.at(-1);
        if(!temperatureEnabled()||!frame)return;

        $('tempStatus').textContent=windChillMode()
          ? 'Wind chill: loading temperature and wind data…'
          : 'Air temperature: updating…';
        $('tempStatus').className='status';

        try{
          await loadTemperatures(false);
          if(windChillMode())await ensureWindChillInputs(false);
          queueTemperatureRender(frame.time,0);
        }catch(error){
          console.error(error);
          $('tempStatus').textContent=windChillMode()
            ? 'Wind chill could not load: '+error.message
            : 'Temperature could not load: '+error.message;
          $('tempStatus').className='status bad';
        }
      });
    }
  }
})();
