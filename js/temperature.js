function temperatureEnabled(){return $('tempOn').checked || $('heatmapOn').checked;}
const TEMP_BOUNDS=[[53.70,20.40],[59.90,28.50]];
const TEMP_REGIONS=[
  {id:'baltics',bounds:[[53.70,20.40],[59.90,28.50]],w:260,h:205},
  {id:'scandinavia',bounds:[[54.40,4.00],[71.60,32.20]],w:330,h:245},
  {id:'iceland',bounds:[[62.70,-25.20],[67.20,-12.40]],w:230,h:150},
  {id:'poland',bounds:[[48.80,14.00],[55.00,24.50]],w:320,h:260},
  {id:'denmark',bounds:[[54.40,7.80],[57.90,15.30]],w:320,h:220},
  {id:'canada',bounds:[[41,-142],[84,-52]],w:580,h:400},
  {id:'greenland',bounds:[[59,-74],[84,-10]],w:350,h:390}
];

function mercatorY(lat){
  const clamped=Math.max(-85.05112878,Math.min(85.05112878,lat));
  const rad=clamped*Math.PI/180;
  return Math.log(Math.tan(Math.PI/4+rad/2));
}

function inverseMercatorY(y){
  return Math.atan(Math.sinh(y))*180/Math.PI;
}

function rasterLatitudeForRow(region,row,height){
  const south=region.bounds[0][0];
  const north=region.bounds[1][0];
  const northY=mercatorY(north);
  const southY=mercatorY(south);
  const f=row/(height-1);
  return inverseMercatorY(northY+f*(southY-northY));
}

function rasterYForLatitude(region,lat,height){
  const south=region.bounds[0][0];
  const north=region.bounds[1][0];
  const northY=mercatorY(north);
  const southY=mercatorY(south);
  const y=mercatorY(lat);
  return ((northY-y)/(northY-southY))*height;
}

function makeAxis(start,end,step){
  const values=[];
  for(let v=start;v<end-1e-8;v+=step) values.push(+v.toFixed(4));
  if(!values.length || Math.abs(values[values.length-1]-end)>1e-6) values.push(+end.toFixed(4));
  return values;
}

function makeStructuredGrid(id,bounds,latStep,lonStep){
  const south=bounds[0][0],west=bounds[0][1];
  const north=bounds[1][0],east=bounds[1][1];
  const latitudes=makeAxis(south,north,latStep);
  const longitudes=makeAxis(west,east,lonStep);
  const points=[];

  for(const lat of latitudes){
    for(const lon of longitudes) points.push([lat,lon]);
  }

  return {id,bounds,latitudes,longitudes,points};
}

// Denser source grids than v7.7. Open-Meteo applies terrain-aware downscaling
// at each requested coordinate; bilinear interpolation then blends only the
// four surrounding samples instead of every point in Northern Europe.
const TEMP_GRID_SPECS=[
  makeStructuredGrid('baltics',TEMP_REGIONS[0].bounds,0.90,1.20),
  makeStructuredGrid('poland',TEMP_REGIONS[3].bounds,1.10,1.40),
  makeStructuredGrid('denmark',TEMP_REGIONS[4].bounds,0.80,1.20),
  makeStructuredGrid('scandinavia',TEMP_REGIONS[1].bounds,1.50,2.00),
  makeStructuredGrid('iceland',TEMP_REGIONS[2].bounds,0.90,1.40),
  {...makeStructuredGrid('canada',TEMP_REGIONS[5].bounds,3,4),shared:true},
  {...makeStructuredGrid('greenland',TEMP_REGIONS[6].bounds,2,3),shared:true}
];

const temperatureGridData=new Map();
let temperatureCitySeries=[];
let temperatureCityMap=new Map();
let temperatureLoadPromise=null;
let americasTemperaturePromise=null;
let americasTemperatureLoadedAt=0;

function validateAmericasTemperatureSnapshot(data){
  if(data?.version!==1 || !Number.isFinite(data.generatedAt) ||
     data.generatedAt>Date.now()/1000+600 || Date.now()/1000-data.generatedAt>12*3600) return false;
  return TEMP_GRID_SPECS.filter(spec=>spec.shared).every(spec=>{
    const grid=data.grids?.[spec.id];
    return grid && JSON.stringify(grid.latitudes)===JSON.stringify(spec.latitudes) &&
      JSON.stringify(grid.longitudes)===JSON.stringify(spec.longitudes) &&
      Array.isArray(grid.series) && grid.series.length===spec.points.length &&
      grid.series.every((item,i)=>item?.lat===spec.points[i][0] && item.lon===spec.points[i][1] &&
        Array.isArray(item.times) && item.times.length>=2 && item.times.every((t,j)=>Number.isFinite(t)&&(!j||t>item.times[j-1])) &&
        Array.isArray(item.temps) && item.temps.length===item.times.length &&
        item.temps.every(t=>t===null||(Number.isFinite(t)&&t>-90&&t<60)) && item.temps.some(Number.isFinite) && (!item.wind || (Array.isArray(item.wind)&&item.wind.length===item.times.length&&item.wind.every(r=>Array.isArray(r)&&r.length===3&&r.every((v,k)=>v===null||(Number.isFinite(v)&&Math.abs(v)<=100&&(k<2||v>=0)))))));
  });
}

async function loadAmericasTemperatureData(force=false){
  if(!force && Date.now()-americasTemperatureLoadedAt<30*60*1000) return;
  if(americasTemperaturePromise) return americasTemperaturePromise;
  americasTemperaturePromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('data/temperature-americas-model.json?v='+Math.floor(Date.now()/(10*60*1000)),{cache:'no-store',signal:controller.signal});
      if(!response.ok) throw new Error('Canada/Greenland heatmap snapshot HTTP '+response.status);
      const data=await response.json();
      if(!validateAmericasTemperatureSnapshot(data)) throw new Error('Invalid Canada/Greenland heatmap snapshot');
      for(const spec of TEMP_GRID_SPECS.filter(spec=>spec.shared)) temperatureGridData.set(spec.id,data.grids[spec.id].series);
      americasTemperatureLoadedAt=Date.now();
      temperatureImageCache.clear();temperatureStatsCache.clear();
    }finally{clearTimeout(timer);}
  })();
  try{await americasTemperaturePromise;}finally{americasTemperaturePromise=null;}
}

const TEMP_DATA_CACHE_KEY='balticWeatherTemperatureDataV812';
const TEMP_DATA_CACHE_MAX_AGE=30*60*1000;
const TEMP_DATA_STALE_MAX_AGE=6*60*60*1000;
const TEMP_REQUEST_GAP_MS=450;
let temperatureUsingStaleCache=false;

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function serializeTemperatureState(){
  return {
    savedAt:Date.now(),
    citySeries:temperatureCitySeries,
    grids:Object.fromEntries(
      [...temperatureGridData.entries()]
    )
  };
}

function saveTemperatureState(){
  try{
    localStorage.setItem(
      TEMP_DATA_CACHE_KEY,
      JSON.stringify(serializeTemperatureState())
    );
  }catch(e){
    // Storage can be unavailable/private; runtime data still works.
  }
}

function restoreTemperatureState(maxAge=TEMP_DATA_CACHE_MAX_AGE){
  try{
    const raw=localStorage.getItem(TEMP_DATA_CACHE_KEY);
    if(!raw) return false;

    const cached=JSON.parse(raw);
    if(!cached?.savedAt ||
       Date.now()-cached.savedAt>maxAge ||
       !Array.isArray(cached.citySeries) ||
       !cached.grids){
      return false;
    }

    // Validate before replacing grids, and retain a separately loaded Americas
    // snapshot when an older European cache is used after an upstream failure.
    for(const spec of TEMP_GRID_SPECS){
      const series=cached.grids[spec.id];
      if(spec.shared && !series) continue;
      if(!Array.isArray(series) || series.length!==spec.points.length) return false;
    }
    for(const spec of TEMP_GRID_SPECS){
      const series=cached.grids[spec.id];
      if(spec.shared && !series) continue; // Existing European caches remain usable.
      if(!Array.isArray(series) || series.length!==spec.points.length){
        return false;
      }
      temperatureGridData.set(spec.id,series);
    }

    temperatureCitySeries=cached.citySeries.filter(Boolean);
    temperatureCityMap=new Map(
      temperatureCitySeries.map(item=>[
        temperatureCoordKey(item.lat,item.lon),
        item
      ])
    );

    temperatureSeries=[
      ...temperatureCitySeries,
      ...TEMP_GRID_SPECS.flatMap(spec=>
        (temperatureGridData.get(spec.id)||[]).filter(Boolean)
      )
    ];

    temperatureLoadedAt=cached.savedAt;
    return temperatureSeries.length>0;
  }catch(e){
    return false;
  }
}

const TEMP_COUNTRIES_URL='https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
const TEMP_REGION_COUNTRY_IDS={
  baltics:new Set(['233','428','440']),       // Estonia, Latvia, Lithuania
  scandinavia:new Set(['246','752','578']),  // Finland, Sweden, Norway
  iceland:new Set(['352']),                 // Iceland
  poland:new Set(['616']),                  // Poland
  denmark:new Set(['208']),                 // Denmark, including its islands
  canada:new Set(['124']),
  greenland:new Set(['304'])
};
let temperatureCountryFeaturesPromise=null;

async function loadTemperatureCountryFeatures(){
  if(temperatureCountryFeaturesPromise) return temperatureCountryFeaturesPromise;

  temperatureCountryFeaturesPromise=(async()=>{
    const response=await fetch(TEMP_COUNTRIES_URL,{cache:'force-cache'});
    if(!response.ok) throw new Error('country coastline data HTTP '+response.status);
    const topology=await response.json();

    if(!window.topojson?.feature || !topology?.objects?.countries){
      throw new Error('country coastline decoder unavailable');
    }

    const collection=topojson.feature(topology,topology.objects.countries);
    if(!collection.features?.length) throw new Error('empty country coastline data');
    return collection.features;
  })();

  try{
    return await temperatureCountryFeaturesPromise;
  }catch(error){
    temperatureCountryFeaturesPromise=null; // Allow the next refresh to retry.
    throw error;
  }
}

function addMaskRing(ctx,ring,region,w,h){
  if(!ring?.length) return;

  const west=region.bounds[0][1];
  const east=region.bounds[1][1];

  for(let i=0;i<ring.length;i++){
    const lon=ring[i][0];
    const lat=ring[i][1];
    const x=((lon-west)/(east-west))*w;
    const y=rasterYForLatitude(region,lat,h);

    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  }
  ctx.closePath();
}

function addMaskGeometry(ctx,geometry,region,w,h){
  if(!geometry) return;

  if(geometry.type==='Polygon'){
    for(const ring of geometry.coordinates) addMaskRing(ctx,ring,region,w,h);
    return;
  }

  if(geometry.type==='MultiPolygon'){
    for(const polygon of geometry.coordinates){
      for(const ring of polygon) addMaskRing(ctx,ring,region,w,h);
    }
  }
}

function clipTemperatureToCountries(ctx,region,w,h,countryFeatures){
  const wanted=TEMP_REGION_COUNTRY_IDS[region.id];
  if(!wanted || !countryFeatures?.length) return false;

  ctx.save();
  ctx.globalCompositeOperation='destination-in';
  ctx.beginPath();

  let matched=0;
  for(const feature of countryFeatures){
    if(!wanted.has(String(feature.id))) continue;
    addMaskGeometry(ctx,feature.geometry,region,w,h);
    matched++;
  }

  if(matched){
    ctx.fillStyle='#fff';
    ctx.fill('evenodd');
  }
  ctx.restore();

  return matched>0;
}


// Extra exact sampling points for Nordic temperature readouts.
// Keeping these as direct Open-Meteo points means each displayed city uses
// its own model value instead of extrapolating from the Baltic grid.
const BALTIC_TEMP_POINTS=[
  [59.44,24.75],[58.38,26.72],[58.25,22.49],[58.94,23.54],[59.38,28.19],
  [58.88,25.56],[57.78,26.04],[58.36,24.50],[59.18,27.28],[58.00,25.93],
  [56.95,24.11],[56.51,21.01],[57.39,21.56],[56.65,23.72],[55.87,26.52],
  [57.54,25.43],[56.65,27.72],[54.69,25.28],[54.90,23.90],[55.70,21.14],
  [55.93,23.32],[55.73,24.36],[54.40,24.04],[55.29,23.97]
];

const NORDIC_TEMP_POINTS=[
  [60.17,24.94],[61.50,23.76],[60.45,22.27],[65.01,25.47],
  [66.50,25.73],[62.89,27.68],[63.10,21.62],[62.24,25.75],
  [59.33,18.07],[57.71,11.97],[55.60,13.00],[63.83,20.26],
  [65.58,22.15],[60.67,17.14],[67.85,20.23],
  [59.91,10.75],[60.39,5.32],[63.43,10.39],[69.65,18.96],
  [58.97,5.73],[68.44,17.43],[70.98,25.97],
  [64.15,-21.94],[65.68,-18.09],[65.26,-14.40],
  [66.07,-23.12],[64.25,-15.21],[63.75,-20.22]
];

const POLAND_DENMARK_TEMP_POINTS=[
  [52.23,21.01],[50.06,19.94],[54.35,18.65],[52.41,16.93],
  [51.11,17.04],[53.43,14.55],[51.76,19.46],[53.13,23.16],
  [55.68,12.57],[56.16,10.20],[55.40,10.39],[57.05,9.92],
  [55.47,8.45],[55.10,14.70]
];

const TEMP_CITY_POINTS=[...BALTIC_TEMP_POINTS,...NORDIC_TEMP_POINTS,...POLAND_DENMARK_TEMP_POINTS];

const EXTRA_TEMP_POINTS=[
  // Estonia: islands, coast and inland towns
  [59.35,24.05],[59.30,24.42],[59.43,24.55],[59.51,24.83],
  [59.56,25.72],[59.35,26.36],[59.26,25.96],[59.07,26.25],
  [58.90,24.43],[59.00,22.75],[58.82,22.78],[58.61,23.18],
  [58.13,22.25],[58.50,23.28],[58.65,25.97],[58.75,26.39],
  [58.06,27.07],[57.84,27.00],[58.05,26.50],[58.00,26.21],
  [57.75,27.33],[58.15,24.96],[58.37,25.60],
  // Latvia
  [57.75,24.36],[57.51,24.72],[57.31,25.27],[57.15,24.86],
  [57.25,22.59],[56.97,23.16],[56.97,23.80],[56.41,24.19],
  [56.60,25.26],[56.50,25.86],[56.85,26.22],[57.42,27.05],
  [56.55,27.72],[56.41,21.60],[56.73,22.40],
  // Lithuania
  [55.92,21.07],[55.89,21.24],[55.25,22.29],[55.98,22.25],
  [56.31,22.33],[56.20,24.76],[55.50,25.60],[55.25,26.16],
  [54.56,23.35],[54.02,23.97],[55.07,22.77],[55.35,21.48],
  // Finland
  [60.39,25.66],[60.87,26.70],[60.98,25.66],[61.06,28.19],
  [61.69,27.27],[61.87,28.88],[62.60,29.76],[64.23,27.73],
  [64.68,24.48],[63.84,23.13],[62.79,22.84],[61.49,21.80],
  [60.10,19.94],[65.74,24.56],[67.37,26.63],[68.91,27.03],
  [69.06,20.79],[66.37,29.18],
  // Sweden
  [56.05,12.69],[56.88,14.81],[56.66,16.36],[57.64,18.30],
  [58.41,15.62],[59.27,15.21],[59.61,16.55],[59.86,17.64],
  [59.38,13.50],[60.61,15.63],[62.39,17.31],[63.18,14.64],
  [64.75,20.95],[66.61,19.82],[68.36,18.83],
  // Norway
  [58.15,8.00],[59.21,9.61],[60.79,10.69],[61.12,10.47],
  [62.47,6.15],[62.74,7.16],[64.02,11.50],[66.31,14.14],
  [67.28,14.40],[68.23,14.57],[69.97,23.27],[70.66,23.68],
  [70.07,29.75],[69.73,30.05],
  // Poland
  [54.18,15.57],[54.46,17.03],[53.78,20.48],[53.12,18.01],
  [51.25,22.57],[50.04,22.00],[50.26,19.02],[50.87,20.63],
  [49.30,19.95],[51.94,15.51],
  // Denmark: Jutland, Funen, Zealand, Lolland and Bornholm
  [57.44,10.53],[56.36,8.62],[56.45,9.40],[55.71,9.54],
  [55.25,9.49],[55.65,12.09],[55.23,11.76],[54.77,11.87],
  [55.06,14.98],
  // Iceland
  [64.56,-21.90],[64.89,-23.71],[65.75,-19.65],[66.04,-17.34],
  [65.04,-14.22],[63.42,-19.01],[63.83,-20.40],[63.84,-22.56]
];

function temperatureCoordKey(lat,lon){
  return Number(lat).toFixed(2)+','+Number(lon).toFixed(2);
}

function tempColor(t){
  const stops=[
    [-20,[75,60,167]],[-10,[40,95,201]],[0,[49,167,223]],
    [10,[87,198,106]],[20,[240,218,59]],[30,[246,139,44]],[40,[220,61,61]]
  ];
  if(t<=stops[0][0]) return stops[0][1];
  if(t>=stops.at(-1)[0]) return stops.at(-1)[1];
  for(let i=0;i<stops.length-1;i++){
    const [a,ca]=stops[i], [b,cb]=stops[i+1];
    if(t>=a && t<=b){
      const f=(t-a)/(b-a);
      return ca.map((v,j)=>Math.round(v+(cb[j]-v)*f));
    }
  }
  return [255,255,255];
}

function sampleTemperatureAt(series, unix){
  if(!series) return NaN;
  const times=series.times;
  const temps=series.temps;
  if(!times.length) return NaN;

  if(unix<=times[0]) return temps[0];
  if(unix>=times[times.length-1]) return temps[temps.length-1];

  for(let i=0;i<times.length-1;i++){
    const a=times[i], b=times[i+1];
    if(unix>=a && unix<=b){
      const ta=temps[i], tb=temps[i+1];
      if(!Number.isFinite(ta)) return tb;
      if(!Number.isFinite(tb)) return ta;
      const f=(unix-a)/(b-a);
      return ta+(tb-ta)*f;
    }
  }
  return NaN;
}

function axisBracket(axis,value){
  if(!axis?.length || value<axis[0] || value>axis[axis.length-1]) return null;
  if(axis.length===1) return {i0:0,i1:0,f:0};

  let lo=0,hi=axis.length-1;
  while(hi-lo>1){
    const mid=(lo+hi)>>1;
    if(axis[mid]<=value) lo=mid;
    else hi=mid;
  }

  const a=axis[lo],b=axis[hi];
  return {i0:lo,i1:hi,f:b===a?0:(value-a)/(b-a)};
}

function bilinearValue(values,cols,latB,lonB){
  if(!latB || !lonB) return NaN;

  const candidates=[
    [latB.i0*cols+lonB.i0,(1-latB.f)*(1-lonB.f)],
    [latB.i0*cols+lonB.i1,(1-latB.f)*lonB.f],
    [latB.i1*cols+lonB.i0,latB.f*(1-lonB.f)],
    [latB.i1*cols+lonB.i1,latB.f*lonB.f]
  ];

  let sum=0,weight=0;
  for(const [index,w] of candidates){
    const v=values[index];
    if(Number.isFinite(v) && w>0){
      sum+=v*w;
      weight+=w;
    }
  }
  return weight?sum/weight:NaN;
}

function gridSpecForPoint(lat,lon){
  // Prefer the tighter Baltic grid where it overlaps the Nordic rectangle.
  for(const spec of TEMP_GRID_SPECS){
    const [[south,west],[north,east]]=spec.bounds;
    if(lat>=south && lat<=north && lon>=west && lon<=east) return spec;
  }
  return null;
}

function sampleGridTemperature(spec,lat,lon,unix){
  const series=temperatureGridData.get(spec.id);
  if(!series?.length) return NaN;

  const values=series.map(item=>sampleTemperatureGridPoint(spec,item,unix));
  const latB=axisBracket(spec.latitudes,lat);
  const lonB=axisBracket(spec.longitudes,lon);
  return bilinearValue(values,spec.longitudes.length,latB,lonB);
}

function sampleTemperatureGridPoint(spec,item,unix){
  // Do not present the final forecast hour as indefinitely current data.
  if(spec.shared && (!item || unix<item.times[0] || unix>item.times.at(-1))) return NaN;
  return sampleTemperatureAt(item,unix);
}

function interpolateTemp(lat,lon,unix){
  // Labels use exact API requests at their coordinates whenever available.
  const exact=temperatureCityMap.get(temperatureCoordKey(lat,lon));
  const exactValue=sampleTemperatureAt(exact,unix);
  if(Number.isFinite(exactValue)) return exactValue;

  const spec=gridSpecForPoint(lat,lon);
  return spec?sampleGridTemperature(spec,lat,lon,unix):NaN;
}

function nearestQuarterHour(unix){
  return Math.round(unix/900)*900;
}

function setTempCache(key,dataUrl,minT,maxT){
  temperatureImageCache.set(key,dataUrl);
  temperatureStatsCache.set(key,{minT,maxT});

  while(temperatureImageCache.size>TEMP_CACHE_LIMIT){
    const oldest=temperatureImageCache.keys().next().value;
    temperatureImageCache.delete(oldest);
    temperatureStatsCache.delete(oldest);
  }
}

function renderTemperatureLabels(unix){
  if(map.hasLayer(temperatureLabels)) map.removeLayer(temperatureLabels);
  temperatureLabels.clearLayers();

  if(!$('tempOn').checked || !temperatureSeries.length) return;

  // Reuse the existing model grid for extra towns: no extra API quota.
  // Major hubs get priority, then reveal regional towns as the map zooms in.
  const majorPoints=[
    [59.44,24.75],[56.95,24.11],[54.69,25.28],[60.17,24.94],
    [59.33,18.07],[59.91,10.75],[64.15,-21.94],[65.01,25.47],[69.65,18.96],
    [52.23,21.01],[55.68,12.57]
  ];
  const zoom=map.getZoom();
  const labelPts=zoom<=5 ? majorPoints :
    zoom<=6 ? [...majorPoints,...TEMP_CITY_POINTS] :
    [...majorPoints,...TEMP_CITY_POINTS,...EXTRA_TEMP_POINTS];
  const seen=new Set();
  const occupied=[];
  const bounds=map.getBounds();
  const gapX=zoom>=9?50:60;
  const gapY=28;

  for(const [lat,lon] of labelPts){
    const key=temperatureCoordKey(lat,lon);
    if(seen.has(key) || !bounds.contains([lat,lon])) continue;
    seen.add(key);
    const pixel=map.latLngToContainerPoint([lat,lon]);
    if(occupied.some(p=>Math.abs(p.x-pixel.x)<gapX && Math.abs(p.y-pixel.y)<gapY)) continue;
    const t=interpolateTemp(lat,lon,unix);
    if(!Number.isFinite(t)) continue;

    occupied.push(pixel);
    L.marker([lat,lon],{
      interactive:false,
      icon:L.divIcon({
        className:'',
        html:`<div class="temp-label">${Math.round(t)}°C</div>`,
        iconSize:[46,22],
        iconAnchor:[23,11]
      })
    }).addTo(temperatureLabels);
  }

  temperatureLabels.addTo(map);
}

const TEMP_OBS_RADIUS_KM=70;
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

function buildTemperatureCorrectionRaster(region,W,H,corrections,latValues,lonValues){
  const weightedBias=new Float32Array(W*H);
  const weightTotal=new Float32Array(W*H);
  if(!corrections.length) return {weightedBias,weightTotal};

  const south=region.bounds[0][0],west=region.bounds[0][1];
  const north=region.bounds[1][0],east=region.bounds[1][1];

  for(const correction of corrections){
    if(correction.lat<TEMP_REGIONS[0]?.bounds?.[0]?.[0]-20) continue;
    const latPad=TEMP_OBS_RADIUS_KM/111;
    const cosLat=Math.max(0.18,Math.cos(correction.lat*Math.PI/180));
    const lonPad=TEMP_OBS_RADIUS_KM/(111*cosLat);
    if(correction.lat+latPad<south || correction.lat-latPad>north ||
       correction.lon+lonPad<west || correction.lon-lonPad>east) continue;

    const x0=Math.max(0,Math.floor(((correction.lon-lonPad-west)/(east-west))*(W-1)));
    const x1=Math.min(W-1,Math.ceil(((correction.lon+lonPad-west)/(east-west))*(W-1)));
    const yA=rasterYForLatitude(region,correction.lat+latPad,H);
    const yB=rasterYForLatitude(region,correction.lat-latPad,H);
    const y0=Math.max(0,Math.floor(Math.min(yA,yB)));
    const y1=Math.min(H-1,Math.ceil(Math.max(yA,yB)));

    for(let y=y0;y<=y1;y++){
      const lat=latValues[y];
      const row=y*W;
      for(let x=x0;x<=x1;x++){
        const distance=temperatureObservationDistanceKm(lat,lonValues[x],correction.lat,correction.lon);
        if(distance>=TEMP_OBS_RADIUS_KM) continue;
        const f=distance/TEMP_OBS_RADIUS_KM;
        const spatial=1-(3*f*f-2*f*f*f);
        const weight=spatial*correction.ageWeight;
        const i=row+x;
        weightedBias[i]+=correction.bias*weight;
        weightTotal[i]+=weight;
      }
    }
  }
  return {weightedBias,weightTotal};
}

function temperatureAdjustedFromRaster(model,index,weightedBias,weightTotal){
  const total=weightTotal[index];
  if(total<=0) return model;
  const blend=Math.min(1,total);
  return model+(weightedBias[index]/total)*blend;
}

function invalidateTemperatureHeatmapCache(){
  temperatureImageCache.clear();
  temperatureStatsCache.clear();
}

async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);

  if(temperatureImageCache.has(cacheKey)){
    const cached=temperatureImageCache.get(cacheKey);
    const stats=temperatureStatsCache.get(cacheKey);
    return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT,correctionCount:stats.correctionCount||0};
  }

  const corrections=temperatureHeatmapCorrections(cacheKey);
  const rendered=[];
  let globalMin=Infinity,globalMax=-Infinity;
  // Never display rectangular heatmap tiles over the sea if the mask fails.
  const countryFeatures=await loadTemperatureCountryFeatures();

  for(const region of TEMP_REGIONS){
    const spec=TEMP_GRID_SPECS.find(item=>item.id===region.id);
    const sourceSeries=temperatureGridData.get(region.id);
    if(!spec || !sourceSeries?.length) continue;

    // Sample the model timeline only once per source point for this frame.
    // Pixel interpolation below is then just four-number bilinear blending.
    const gridValues=sourceSeries.map(item=>sampleTemperatureGridPoint(spec,item,cacheKey));
    const cols=spec.longitudes.length;

    const W=region.w,H=region.h;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d',{alpha:true});
    const img=ctx.createImageData(W,H);
    const d=img.data;

    const west=region.bounds[0][1];
    const east=region.bounds[1][1];

    // Pixel coordinates and model brackets are fixed for this raster.
    const lonValues=Array.from({length:W},(_,x)=>west+(x/(W-1))*(east-west));
    const lonLookup=lonValues.map(lon=>axisBracket(spec.longitudes,lon));
    const latValues=Array.from({length:H},(_,y)=>rasterLatitudeForRow(region,y,H));
    const latLookup=latValues.map(lat=>axisBracket(spec.latitudes,lat));
    const correctionRaster=buildTemperatureCorrectionRaster(region,W,H,corrections,latValues,lonValues);

    for(let y=0;y<H;y++){
      if(token!==temperatureRenderToken) return null;

      const latB=latLookup[y];

      for(let x=0;x<W;x++){
        let value=bilinearValue(gridValues,cols,latB,lonLookup[x]);
        const i=(y*W+x)*4;

        if(!Number.isFinite(value)){
          d[i+3]=0;
          continue;
        }

        if(corrections.length){
          const pixelIndex=y*W+x;
          value=temperatureAdjustedFromRaster(
            value,pixelIndex,correctionRaster.weightedBias,correctionRaster.weightTotal
          );
        }

        globalMin=Math.min(globalMin,value);
        globalMax=Math.max(globalMax,value);
        const c=tempColor(value);
        d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; d[i+3]=205;
      }

      // Keep the UI responsive while large rasters are generated.
      if(y%64===0) await new Promise(requestAnimationFrame);
    }

    ctx.putImageData(img,0,0);
    const coastlineClipped=clipTemperatureToCountries(ctx,region,W,H,countryFeatures);
    if(!coastlineClipped) throw new Error('coastline mask missing for '+region.id);

    rendered.push({
      id:region.id,
      bounds:region.bounds,
      coastlineClipped,
      dataUrl:canvas.toDataURL('image/png')
    });
  }

  if(token!==temperatureRenderToken) return null;
  temperatureImageCache.set(cacheKey,rendered);
  temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax,correctionCount:corrections.length});

  while(temperatureImageCache.size>TEMP_CACHE_LIMIT){
    const oldest=temperatureImageCache.keys().next().value;
    temperatureImageCache.delete(oldest);
    temperatureStatsCache.delete(oldest);
  }

  return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax,correctionCount:corrections.length};
}

async function buildTemperatureOverlay(unix,{precache=false}={}){
  if(!temperatureEnabled() || !temperatureSeries.length) return;

  // Station readings do not depend on loading or rendering a heatmap.
  if(!$('heatmapOn')?.checked){
    if(precache) return;
    if(temperatureLayer){
      map.removeLayer(temperatureLayer);
      temperatureLayer=null;
    }
    renderTemperatureLabels(unix);
    $('tempStatus').textContent=`Temperature: hourly model + official observations${temperatureUsingStaleCache?' · cached fallback':''} · ${fmt(unix)}`;
    $('tempStatus').className='status ok';
    weatherFront();
    return;
  }

  renderTemperatureLabels(unix);
  const token=temperatureRenderToken;
  const result=await createTemperatureImage(unix,token);
  if(!result || token!==temperatureRenderToken || !temperatureEnabled()) return;
  if(precache) return;

  if(temperatureLayer){
    map.removeLayer(temperatureLayer);
    temperatureLayer=null;
  }

  if($('heatmapOn')?.checked){
    const opacity=Number($('tempOpacity').value)/100;
    const layers=result.regions.map(region=>L.imageOverlay(region.dataUrl,region.bounds,{
      opacity,
      interactive:false
    }));
    temperatureLayer=L.layerGroup(layers).addTo(map);
    temperatureLayer.setOpacity=value=>temperatureLayer.eachLayer(layer=>layer.setOpacity(value));
  }

  // Numeric readings stay visible even when the heatmap is switched off.
  renderTemperatureLabels(unix);

  const observationNote=result.correctionCount?` + ${result.correctionCount} fresh official station corrections`:'';
  $('tempStatus').textContent=
    `Temperature: terrain-aware hourly model${observationNote} + fast bilinear heatmap${$('heatmapOn')?.checked?' · coastline clipped':''}${temperatureUsingStaleCache?' · cached fallback':''} · ${result.minT.toFixed(1)} to ${result.maxT.toFixed(1)} °C · ${fmt(unix)}`;
  $('tempStatus').className='status ok';
  weatherFront();
}

function queueTemperatureRender(unix,delay=90){
  if(temperatureDebounceTimer) clearTimeout(temperatureDebounceTimer);

  temperatureDebounceTimer=setTimeout(async()=>{
    temperatureRenderToken++;
    const myToken=temperatureRenderToken;

    try{
      await buildTemperatureOverlay(unix);
      if(myToken===temperatureRenderToken) scheduleTemperaturePrecache(unix);
    }catch(e){
      if(myToken!==temperatureRenderToken) return;
      console.error(e);
      $('tempStatus').textContent='Temperature render failed: '+e.message;
      $('tempStatus').className='status bad';
    }
  },delay);
}

function scheduleTemperaturePrecache(centerUnix){
  if(temperaturePrecacheTimer) clearTimeout(temperaturePrecacheTimer);

  temperaturePrecacheTimer=setTimeout(async()=>{
    if(!$('heatmapOn').checked || !temperatureSeries.length) return;

    const center=nearestQuarterHour(centerUnix);
    const candidates=[
      center-900,
      center+900,
      center-1800,
      center+1800
    ];

    for(const t of candidates){
      if(!$('heatmapOn').checked) break;
      if(temperatureImageCache.has(t)) continue;

      // Give the UI a moment between background frames.
      await new Promise(resolve=>setTimeout(resolve,40));
      const token=temperatureRenderToken;
      await buildTemperatureOverlay(t,{precache:true});
      if(token!==temperatureRenderToken) break;
    }
  },250);
}

async function fetchTemperatureSeries(points){
  const lats=points.map(p=>p[0]).join(',');
  const lons=points.map(p=>p[1]).join(',');

  const url='https://api.open-meteo.com/v1/forecast?latitude='+encodeURIComponent(lats)+
            '&longitude='+encodeURIComponent(lons)+
            '&hourly=temperature_2m'+
            '&past_hours=4'+
            '&forecast_hours=2'+
            '&cell_selection=land'+
            '&timezone=UTC';

  const response=await fetch(url,{cache:'no-store'});

  if(response.status===429){
    const error=new Error('temperature API is temporarily rate limited');
    error.rateLimited=true;
    throw error;
  }

  if(!response.ok) throw new Error('temperature API HTTP '+response.status);

  const json=await response.json();
  const arr=Array.isArray(json)?json:[json];

  return points.map((point,i)=>{
    const item=arr[i];
    if(!item) return null;

    const times=(item.hourly?.time||[]).map(s=>
      Math.floor(Date.parse(s+'Z')/1000)
    );
    const temps=(item.hourly?.temperature_2m||[]).map(Number);
    if(!times.length || !temps.some(Number.isFinite)) return null;

    return {lat:point[0],lon:point[1],times,temps};
  });
}

async function fetchTemperatureChunks(points,chunkSize=110){
  const out=[];

  // One global sequential queue is intentional. The previous version launched
  // many requests at once and could trigger Open-Meteo HTTP 429 rate limits.
  for(let i=0;i<points.length;i+=chunkSize){
    if(i>0) await sleep(TEMP_REQUEST_GAP_MS);
    const chunk=points.slice(i,i+chunkSize);
    out.push(...await fetchTemperatureSeries(chunk));
  }

  return out;
}

async function fetchAllTemperatureData(){
  for(const spec of TEMP_GRID_SPECS) if(!spec.shared) temperatureGridData.delete(spec.id);

  // Heatmap grids first. This critical path stays comfortably below the
  // Open-Meteo free-tier per-minute location budget.
  for(const spec of TEMP_GRID_SPECS){
    if(spec.shared) continue; // These larger grids are fetched once centrally.
    const series=await fetchTemperatureChunks(spec.points,100);
    temperatureGridData.set(spec.id,series);
  }

  for(const spec of TEMP_GRID_SPECS){
    if(spec.shared) continue;
    if(!temperatureGridData.get(spec.id)?.some(Boolean)){
      throw new Error('no '+spec.id+' temperature grid returned');
    }
  }

  // The grid is enough for the heatmap and for interpolated city labels.
  temperatureCitySeries=[];
  temperatureCityMap=new Map();
  temperatureSeries=TEMP_GRID_SPECS.flatMap(spec=>
    (temperatureGridData.get(spec.id)||[]).filter(Boolean)
  );

  temperatureLoadedAt=Date.now();
  temperatureUsingStaleCache=false;
  temperatureImageCache.clear();
  temperatureStatsCache.clear();
  saveTemperatureState();

  // Exact city-coordinate readings are a non-critical refinement. If the free
  // API is busy, the map keeps working with grid-interpolated labels.
  try{
    await sleep(1200);
    const citySeries=await fetchTemperatureChunks(TEMP_CITY_POINTS,100);
    temperatureCitySeries=citySeries.filter(Boolean);
    temperatureCityMap=new Map(
      temperatureCitySeries.map(item=>[
        temperatureCoordKey(item.lat,item.lon),
        item
      ])
    );
    temperatureSeries=[
      ...temperatureCitySeries,
      ...TEMP_GRID_SPECS.flatMap(spec=>
        (temperatureGridData.get(spec.id)||[]).filter(Boolean)
      )
    ];
    saveTemperatureState();
  }catch(e){
    console.warn('Exact city temperature refinement skipped:',e);
  }
}

async function ensureTemperatureData(force=false){
  if(!temperatureSeries.length && !force){
    if(restoreTemperatureState()){
      temperatureUsingStaleCache=false;
    }
  }

  const fresh=temperatureSeries.length &&
              Date.now()-temperatureLoadedAt<TEMP_DATA_CACHE_MAX_AGE;

  if(!force && fresh) return;
  if(temperatureLoadPromise) return temperatureLoadPromise;

  temperatureLoadPromise=(async()=>{
    if(temperatureEnabled()){
      $('tempStatus').textContent='Temperature: loading regional model data…';
      $('tempStatus').className='status';
    }

    try{
      await Promise.all([
        fetchAllTemperatureData(),
        loadTemperatureCountryFeatures().catch(()=>null)
      ]);
    }catch(e){
      // A previously successful dataset is still useful for a regional heatmap.
      // Prefer it to a blank layer when the public API is temporarily limited.
      if(restoreTemperatureState(TEMP_DATA_STALE_MAX_AGE)){
        temperatureUsingStaleCache=true;
        console.warn('Using cached temperature data after API failure:',e);
        return;
      }
      throw e;
    }
  })();

  try{
    await temperatureLoadPromise;
  }finally{
    temperatureLoadPromise=null;
  }
}

async function loadTemperatures(force=false){
  const americas=loadAmericasTemperatureData(force).then(()=>{
    // Show the shared regions immediately; a slower European API request must
    // not hold back Greenland or Canadian stations and heatmaps.
    temperatureSeries=[...temperatureCitySeries,...TEMP_GRID_SPECS.flatMap(spec=>(temperatureGridData.get(spec.id)||[]).filter(Boolean))];
    const frame=frames[Number($('timeline').value)];
    if(frame && temperatureEnabled()) queueTemperatureRender(frame.time,0);
  });
  const results=await Promise.allSettled([ensureTemperatureData(force),americas]);
  temperatureSeries=[...temperatureCitySeries,...TEMP_GRID_SPECS.flatMap(spec=>(temperatureGridData.get(spec.id)||[]).filter(Boolean))];
  if(!temperatureSeries.length) throw results.find(result=>result.status==='rejected')?.reason||new Error('Temperature data unavailable');
  for(const result of results) if(result.status==='rejected') console.warn('Regional temperature source:',result.reason);

  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame && temperatureEnabled()) queueTemperatureRender(frame.time,0);
}

async function prefetchTemperatures(){
  // Never spend public API quota just because the page opened.
  // Only warm a dataset that already exists in this browser.
  if(!temperatureSeries.length && !restoreTemperatureState()) return;

  try{
    await loadTemperatureCountryFeatures().catch(()=>null);
    const frame=frames[Number($('timeline').value)] || frames.at(-1);
    if(frame && !temperatureImageCache.has(nearestQuarterHour(frame.time))){
      const token=temperatureRenderToken;
      await createTemperatureImage(frame.time,token);
    }
  }catch(e){
    console.warn('Temperature cache warm-up skipped:',e);
  }
}


// Panning reveals nearby labels without rebuilding the heatmap or fetching data.
map.on('moveend',()=>{
  const frame=frames[Number($('timeline').value)];
  if(frame && $('tempOn').checked) renderTemperatureLabels(frame.time);
});

