from pathlib import Path

p=Path('js/temperature.js')
text=p.read_text()

anchor="""async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);
"""
if anchor not in text:
    raise SystemExit('createTemperatureImage anchor missing')

helpers="""const TEMP_OBS_RADIUS_KM=70;
const TEMP_OBS_FULL_WEIGHT_SEC=20*60;
const TEMP_OBS_MAX_AGE_SEC=95*60;
const TEMP_OBS_MAX_BIAS_C=12;

function temperatureObservationDistanceKm(lat1,lon1,lat2,lon2){
  const rad=Math.PI/180;
  const p1=lat1*rad,p2=lat2*rad;
  const dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad;
  const a=Math.sin(dLat/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
}

function temperatureObservationAgeWeight(ageSec){
  if(!Number.isFinite(ageSec) || ageSec<0 || ageSec>TEMP_OBS_MAX_AGE_SEC) return 0;
  if(ageSec<=TEMP_OBS_FULL_WEIGHT_SEC) return 1;
  return Math.max(0,1-(ageSec-TEMP_OBS_FULL_WEIGHT_SEC)/(TEMP_OBS_MAX_AGE_SEC-TEMP_OBS_FULL_WEIGHT_SEC));
}

function temperatureHeatmapCorrections(unix){
  if(typeof officialStationsNearTime!=='function') return [];
  const corrections=[];
  for(const station of officialStationsNearTime(unix)){
    if(!Number.isFinite(station?.time) || !Number.isFinite(station?.temp)) continue;
    const model=interpolateTemp(station.lat,station.lon,unix);
    if(!Number.isFinite(model)) continue;
    const ageWeight=temperatureObservationAgeWeight(Math.abs(station.time-unix));
    if(ageWeight<=0) continue;
    corrections.push({
      lat:station.lat,lon:station.lon,ageWeight,
      bias:Math.max(-TEMP_OBS_MAX_BIAS_C,Math.min(TEMP_OBS_MAX_BIAS_C,station.temp-model))
    });
  }
  return corrections;
}

function temperatureCorrectionIndex(corrections){
  const index=new Map();
  for(const correction of corrections){
    const key=Math.floor(correction.lat)+'/'+Math.floor(correction.lon);
    if(!index.has(key)) index.set(key,[]);
    index.get(key).push(correction);
  }
  return index;
}

function temperatureNearbyCorrections(index,lat,lon){
  const out=[];
  const y=Math.floor(lat),x=Math.floor(lon);
  for(let dy=-1;dy<=1;dy++){
    for(let dx=-3;dx<=3;dx++){
      const rows=index.get((y+dy)+'/'+(x+dx));
      if(rows) out.push(...rows);
    }
  }
  return out;
}

function temperatureAdjustedValue(model,lat,lon,corrections){
  let sum=0,total=0;
  for(const correction of corrections){
    const distance=temperatureObservationDistanceKm(lat,lon,correction.lat,correction.lon);
    if(distance>=TEMP_OBS_RADIUS_KM) continue;
    const x=distance/TEMP_OBS_RADIUS_KM;
    const spatial=1-(3*x*x-2*x*x*x);
    const weight=spatial*correction.ageWeight;
    sum+=correction.bias*weight;
    total+=weight;
  }
  if(total<=0) return model;
  const blend=Math.min(1,total);
  return model+(sum/total)*blend;
}

function invalidateTemperatureHeatmapCache(){
  temperatureImageCache.clear();
  temperatureStatsCache.clear();
}

"""
text=text.replace(anchor,helpers+anchor,1)

old="""async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);

  if(temperatureImageCache.has(cacheKey)){
    const cached=temperatureImageCache.get(cacheKey);
    const stats=temperatureStatsCache.get(cacheKey);
    return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT};
  }

  const rendered=[];
  let globalMin=Infinity,globalMax=-Infinity;
  // Never display rectangular heatmap tiles over the sea if the mask fails.
  const countryFeatures=await loadTemperatureCountryFeatures();
"""
new="""async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);

  if(temperatureImageCache.has(cacheKey)){
    const cached=temperatureImageCache.get(cacheKey);
    const stats=temperatureStatsCache.get(cacheKey);
    return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT,correctionCount:stats.correctionCount||0};
  }

  const corrections=temperatureHeatmapCorrections(cacheKey);
  const correctionIndex=temperatureCorrectionIndex(corrections);
  const rendered=[];
  let globalMin=Infinity,globalMax=-Infinity;
  // Never display rectangular heatmap tiles over the sea if the mask fails.
  const countryFeatures=await loadTemperatureCountryFeatures();
"""
if old not in text:
    raise SystemExit('create image opening block missing')
text=text.replace(old,new,1)

old="""    // Longitude bracket is identical for every row, so calculate it once.
    const lonLookup=Array.from({length:W},(_,x)=>{
      const lon=west+(x/(W-1))*(east-west);
      return axisBracket(spec.longitudes,lon);
    });
"""
new="""    // Longitude coordinate and bracket are identical for every row, so calculate them once.
    const lonValues=Array.from({length:W},(_,x)=>west+(x/(W-1))*(east-west));
    const lonLookup=lonValues.map(lon=>axisBracket(spec.longitudes,lon));
"""
if old not in text:
    raise SystemExit('longitude lookup block missing')
text=text.replace(old,new,1)

old="""      for(let x=0;x<W;x++){
        const value=bilinearValue(gridValues,cols,latB,lonLookup[x]);
        const i=(y*W+x)*4;

        if(!Number.isFinite(value)){
          d[i+3]=0;
          continue;
        }

        globalMin=Math.min(globalMin,value);
        globalMax=Math.max(globalMax,value);
        const c=tempColor(value);
"""
new="""      for(let x=0;x<W;x++){
        let value=bilinearValue(gridValues,cols,latB,lonLookup[x]);
        const i=(y*W+x)*4;

        if(!Number.isFinite(value)){
          d[i+3]=0;
          continue;
        }

        if(corrections.length){
          const nearby=temperatureNearbyCorrections(correctionIndex,lat,lonValues[x]);
          if(nearby.length) value=temperatureAdjustedValue(value,lat,lonValues[x],nearby);
        }

        globalMin=Math.min(globalMin,value);
        globalMax=Math.max(globalMax,value);
        const c=tempColor(value);
"""
if old not in text:
    raise SystemExit('pixel block missing')
text=text.replace(old,new,1)

old="""  temperatureImageCache.set(cacheKey,rendered);
  temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax});
"""
new="""  temperatureImageCache.set(cacheKey,rendered);
  temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax,correctionCount:corrections.length});
"""
if old not in text:
    raise SystemExit('cache stats block missing')
text=text.replace(old,new,1)

old="""  return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax};
}

async function buildTemperatureOverlay"""
new="""  return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax,correctionCount:corrections.length};
}

async function buildTemperatureOverlay"""
if old not in text:
    raise SystemExit('return result block missing')
text=text.replace(old,new,1)

old="""  $('tempStatus').textContent=
    `Temperature: terrain-aware hourly model + fast bilinear heatmap${$('heatmapOn')?.checked?' · coastline clipped':''}${temperatureUsingStaleCache?' · cached fallback':''} · ${result.minT.toFixed(1)} to ${result.maxT.toFixed(1)} °C · ${fmt(unix)}`;
"""
new="""  const observationNote=result.correctionCount?` + ${result.correctionCount} fresh official station corrections`:'';
  $('tempStatus').textContent=
    `Temperature: terrain-aware hourly model${observationNote} + fast bilinear heatmap${$('heatmapOn')?.checked?' · coastline clipped':''}${temperatureUsingStaleCache?' · cached fallback':''} · ${result.minT.toFixed(1)} to ${result.maxT.toFixed(1)} °C · ${fmt(unix)}`;
"""
if old not in text:
    raise SystemExit('status block missing')
text=text.replace(old,new,1)
p.write_text(text)

p=Path('js/stations.js')
text=p.read_text()
old="""    loadTemperaturesModelOnly(force),
    $('tempOn').checked?loadOfficialTemperatureStations(force):Promise.resolve()
"""
new="""    loadTemperaturesModelOnly(force),
    temperatureEnabled()?loadOfficialTemperatureStations(force):Promise.resolve()
"""
if old not in text:
    raise SystemExit('temperature load condition missing')
text=text.replace(old,new,1)

old="""      officialTemperatureLoadedAt=Date.now();
      saveOfficialTemperatureCache();
      return officialTemperatureStations;
"""
new="""      officialTemperatureLoadedAt=Date.now();
      saveOfficialTemperatureCache();
      if(typeof invalidateTemperatureHeatmapCache==='function') invalidateTemperatureHeatmapCache();
      return officialTemperatureStations;
"""
if old not in text:
    raise SystemExit('official cache save block missing')
text=text.replace(old,new,1)

old="""buildTemperatureOverlay=async function(unix,options={}){
  const result=await buildTemperatureOverlayModelOnly(unix,options);
  if(options.precache || !$('tempOn').checked) return result;

  const visibleOfficial=officialStationsNearTime(unix);
"""
new="""buildTemperatureOverlay=async function(unix,options={}){
  const result=await buildTemperatureOverlayModelOnly(unix,options);
  if(options.precache) return result;

  const visibleOfficial=officialStationsNearTime(unix);
"""
if old not in text:
    raise SystemExit('overlay wrapper guard missing')
text=text.replace(old,new,1)

old="""  if(visibleOfficial.length && $('tempStatus').classList.contains('ok')){
    $('tempStatus').textContent+=` · ${visibleOfficial.length} official station readings (${summary.good.join('/')})`;
"""
new="""  if(visibleOfficial.length && $('tempStatus').classList.contains('ok')){
    const label=$('tempOn').checked?'official station readings':'official stations used for heatmap';
    $('tempStatus').textContent+=` · ${visibleOfficial.length} ${label} (${summary.good.join('/')})`;
"""
if old not in text:
    raise SystemExit('station status block missing')
text=text.replace(old,new,1)
p.write_text(text)

p=Path('index.html')
text=p.read_text()
repls=[
 ('<title>Northern Weather Map v8.67</title>','<title>Northern Weather Map v8.68</title>'),
 ('js/temperature.js?v=8.26','js/temperature.js?v=8.68'),
 ('js/stations.js?v=8.67','js/stations.js?v=8.68'),
 ('The heatmap remains a terrain-aware hourly model field. Numeric labels prefer recent official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Norway, Iceland, Poland and Denmark. Click an official reading for station name, exact measured temperature, observation time, station ID, coordinates and source. Latvia currently keeps model-based labels where an official observation feed is not available.',
  'The heatmap starts from the terrain-aware hourly model field and is locally corrected toward fresh official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Norway, Iceland, Poland and Denmark. Corrections fade smoothly with distance and observation age; the existing country/coastline mask still clips the heatmap to land. Click an official reading for station name, exact measured temperature, observation time, station ID, coordinates and source. Latvia currently keeps model-based temperatures where an official observation feed is not available.')
]
for old,new in repls:
    if old not in text:
        raise SystemExit('index marker missing: '+old[:100])
    text=text.replace(old,new,1)
p.write_text(text)
