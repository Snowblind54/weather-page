const TEMP_BOUNDS=[[53.70,20.40],[59.90,28.50]];
const TEMP_REGIONS=[
  {id:'baltics',bounds:[[53.70,20.40],[59.90,28.50]],w:260,h:205},
  {id:'scandinavia',bounds:[[54.40,4.00],[71.60,32.20]],w:330,h:245},
  {id:'iceland',bounds:[[62.70,-25.20],[67.20,-12.40]],w:230,h:150}
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
  makeStructuredGrid('baltics',TEMP_REGIONS[0].bounds,0.40,0.60),
  makeStructuredGrid('scandinavia',TEMP_REGIONS[1].bounds,0.75,1.05),
  makeStructuredGrid('iceland',TEMP_REGIONS[2].bounds,0.50,0.75)
];

const temperatureGridData=new Map();
let temperatureCitySeries=[];
let temperatureCityMap=new Map();
let temperatureLoadPromise=null;

const TEMP_COUNTRIES_URL='https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
const TEMP_REGION_COUNTRY_IDS={
  baltics:new Set(['233','428','440']),       // Estonia, Latvia, Lithuania
  scandinavia:new Set(['246','752','578']),  // Finland, Sweden, Norway
  iceland:new Set(['352'])                   // Iceland
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
    return collection.features||[];
  })();

  return temperatureCountryFeaturesPromise;
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

const TEMP_CITY_POINTS=[...BALTIC_TEMP_POINTS,...NORDIC_TEMP_POINTS];

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

  const values=series.map(item=>sampleTemperatureAt(item,unix));
  const latB=axisBracket(spec.latitudes,lat);
  const lonB=axisBracket(spec.longitudes,lon);
  return bilinearValue(values,spec.longitudes.length,latB,lonB);
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

  // Major locations across the Baltics and Nordics.
  // At lower zooms use capitals/major hubs to keep labels readable.
  const labelPts = map.getZoom()<=6 ? [
    [59.44,24.75], // Tallinn
    [56.95,24.11], // Riga
    [54.69,25.28], // Vilnius
    [60.17,24.94], // Helsinki
    [59.33,18.07], // Stockholm
    [59.91,10.75], // Oslo
    [64.15,-21.94], // Reykjavik
    [65.01,25.47], // Oulu
    [69.65,18.96]  // Tromso
  ] : [
    // Estonia
    [59.44,24.75], // Tallinn
    [58.38,26.72], // Tartu
    [58.25,22.49], // Kuressaare
    [58.94,23.54], // Haapsalu
    [59.38,28.19], // Narva
    [58.88,25.56], // Paide
    [57.78,26.04], // Valga
    [58.36,24.50], // Parnu
    [59.18,27.28], // Johvi
    [58.00,25.93], // Viljandi

    // Latvia
    [56.95,24.11], // Riga
    [56.51,21.01], // Liepaja
    [57.39,21.56], // Ventspils
    [56.65,23.72], // Jelgava
    [55.87,26.52], // Daugavpils
    [57.54,25.43], // Valmiera
    [56.65,27.72], // Rezekne

    // Lithuania
    [54.69,25.28], // Vilnius
    [54.90,23.90], // Kaunas
    [55.70,21.14], // Klaipeda
    [55.93,23.32], // Siauliai
    [55.73,24.36], // Panevezys
    [54.40,24.04], // Alytus
    [55.29,23.97], // Kedainiai

    // Finland
    [60.17,24.94], // Helsinki
    [61.50,23.76], // Tampere
    [60.45,22.27], // Turku
    [65.01,25.47], // Oulu
    [66.50,25.73], // Rovaniemi
    [62.89,27.68], // Kuopio
    [63.10,21.62], // Vaasa
    [62.24,25.75], // Jyvaskyla

    // Sweden
    [59.33,18.07], // Stockholm
    [57.71,11.97], // Gothenburg
    [55.60,13.00], // Malmo
    [63.83,20.26], // Umea
    [65.58,22.15], // Lulea
    [60.67,17.14], // Gavle
    [67.85,20.23], // Kiruna

    // Norway
    [59.91,10.75], // Oslo
    [60.39,5.32], // Bergen
    [63.43,10.39], // Trondheim
    [69.65,18.96], // Tromso
    [58.97,5.73], // Stavanger
    [68.44,17.43], // Narvik
    [70.98,25.97], // Honningsvag

    // Iceland
    [64.15,-21.94], // Reykjavik
    [65.68,-18.09], // Akureyri
    [65.26,-14.40], // Egilsstadir
    [66.07,-23.12], // Isafjordur
    [64.25,-15.21], // Hofn
    [63.75,-20.22]  // Selfoss
  ];

  for(const [lat,lon] of labelPts){
    const t=interpolateTemp(lat,lon,unix);
    if(!Number.isFinite(t)) continue;

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

async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);

  if(temperatureImageCache.has(cacheKey)){
    const cached=temperatureImageCache.get(cacheKey);
    const stats=temperatureStatsCache.get(cacheKey);
    return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT};
  }

  const rendered=[];
  let globalMin=Infinity,globalMax=-Infinity;
  let countryFeatures=null;

  try{
    countryFeatures=await loadTemperatureCountryFeatures();
  }catch(e){
    console.warn('Temperature coastline mask unavailable:',e);
  }

  for(const region of TEMP_REGIONS){
    const spec=TEMP_GRID_SPECS.find(item=>item.id===region.id);
    const sourceSeries=temperatureGridData.get(region.id);
    if(!spec || !sourceSeries?.length) continue;

    // Sample the model timeline only once per source point for this frame.
    // Pixel interpolation below is then just four-number bilinear blending.
    const gridValues=sourceSeries.map(item=>sampleTemperatureAt(item,cacheKey));
    const cols=spec.longitudes.length;

    const W=region.w,H=region.h;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d',{alpha:true});
    const img=ctx.createImageData(W,H);
    const d=img.data;

    const west=region.bounds[0][1];
    const east=region.bounds[1][1];

    // Longitude bracket is identical for every row, so calculate it once.
    const lonLookup=Array.from({length:W},(_,x)=>{
      const lon=west+(x/(W-1))*(east-west);
      return axisBracket(spec.longitudes,lon);
    });

    for(let y=0;y<H;y++){
      if(token!==temperatureRenderToken) return null;

      const lat=rasterLatitudeForRow(region,y,H);
      const latB=axisBracket(spec.latitudes,lat);

      for(let x=0;x<W;x++){
        const value=bilinearValue(gridValues,cols,latB,lonLookup[x]);
        const i=(y*W+x)*4;

        if(!Number.isFinite(value)){
          d[i+3]=0;
          continue;
        }

        globalMin=Math.min(globalMin,value);
        globalMax=Math.max(globalMax,value);
        const c=tempColor(value);
        d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; d[i+3]=205;
      }

      // Yield only a few times; the new renderer is much cheaper than v7.7.
      if(y%40===0) await new Promise(requestAnimationFrame);
    }

    ctx.putImageData(img,0,0);
    const coastlineClipped=clipTemperatureToCountries(ctx,region,W,H,countryFeatures);

    rendered.push({
      id:region.id,
      bounds:region.bounds,
      coastlineClipped,
      dataUrl:canvas.toDataURL('image/png')
    });
  }

  if(token!==temperatureRenderToken) return null;
  temperatureImageCache.set(cacheKey,rendered);
  temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax});

  while(temperatureImageCache.size>TEMP_CACHE_LIMIT){
    const oldest=temperatureImageCache.keys().next().value;
    temperatureImageCache.delete(oldest);
    temperatureStatsCache.delete(oldest);
  }

  return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax};
}

async function buildTemperatureOverlay(unix,{precache=false}={}){
  if(!$('tempOn').checked || !temperatureSeries.length) return;

  const token=temperatureRenderToken;
  const result=await createTemperatureImage(unix,token);
  if(!result || token!==temperatureRenderToken || !$('tempOn').checked) return;
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

  $('tempStatus').textContent=
    `Temperature: terrain-aware source points + fast bilinear heatmap${$('heatmapOn')?.checked?' · coastline clipped':''} · ${result.minT.toFixed(1)} to ${result.maxT.toFixed(1)} °C · ${fmt(unix)}`;
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
    if(!$('tempOn').checked || !temperatureSeries.length) return;

    const center=nearestQuarterHour(centerUnix);
    const candidates=[
      center-900,
      center+900,
      center-1800,
      center+1800,
      center-2700,
      center+2700
    ];

    for(const t of candidates){
      if(!$('tempOn').checked) break;
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
            '&minutely_15=temperature_2m'+
            '&past_minutely_15=12'+
            '&forecast_minutely_15=4'+
            '&cell_selection=land'+
            '&timezone=UTC';

  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok) throw new Error('temperature API HTTP '+response.status);

  const json=await response.json();
  const arr=Array.isArray(json)?json:[json];

  // Preserve one output slot per requested point. Structured-grid interpolation
  // depends on row/column order even if an individual location fails.
  return points.map((point,i)=>{
    const item=arr[i];
    if(!item) return null;

    const times=(item.minutely_15?.time||[]).map(s=>Math.floor(Date.parse(s+'Z')/1000));
    const temps=(item.minutely_15?.temperature_2m||[]).map(Number);
    if(!times.length || !temps.some(Number.isFinite)) return null;

    return {lat:point[0],lon:point[1],times,temps};
  });
}

async function fetchTemperatureChunks(points,chunkSize=100,maxConcurrent=4){
  const chunks=[];
  for(let i=0;i<points.length;i+=chunkSize) chunks.push(points.slice(i,i+chunkSize));

  const results=new Array(chunks.length);
  let next=0;

  async function worker(){
    while(true){
      const index=next++;
      if(index>=chunks.length) return;
      results[index]=await fetchTemperatureSeries(chunks[index]);
    }
  }

  const workers=Array.from(
    {length:Math.min(maxConcurrent,chunks.length)},
    ()=>worker()
  );
  await Promise.all(workers);
  return results.flat();
}

async function fetchAllTemperatureData(){
  const cityPromise=fetchTemperatureChunks(TEMP_CITY_POINTS,100,2);
  const gridPromises=TEMP_GRID_SPECS.map(spec=>
    fetchTemperatureChunks(spec.points,100,4)
      .then(series=>[spec.id,series])
  );

  const [citySeries,gridPairs]=await Promise.all([
    cityPromise,
    Promise.all(gridPromises)
  ]);

  temperatureGridData.clear();
  for(const [id,series] of gridPairs) temperatureGridData.set(id,series);

  temperatureCitySeries=citySeries.filter(Boolean);
  temperatureCityMap=new Map(
    temperatureCitySeries.map(item=>[
      temperatureCoordKey(item.lat,item.lon),
      item
    ])
  );

  temperatureSeries=[
    ...temperatureCitySeries,
    ...gridPairs.flatMap(([,series])=>series.filter(Boolean))
  ];

  if(!temperatureGridData.get('baltics')?.some(Boolean))
    throw new Error('no Baltic temperature grid returned');
  if(!temperatureGridData.get('scandinavia')?.some(Boolean))
    throw new Error('no Scandinavian temperature grid returned');
  if(!temperatureGridData.get('iceland')?.some(Boolean))
    throw new Error('no Iceland temperature grid returned');

  temperatureLoadedAt=Date.now();
  temperatureImageCache.clear();
  temperatureStatsCache.clear();
}

async function ensureTemperatureData(force=false){
  const fresh=temperatureSeries.length &&
              Date.now()-temperatureLoadedAt<10*60*1000;

  if(!force && fresh) return;
  if(temperatureLoadPromise) return temperatureLoadPromise;

  temperatureLoadPromise=(async()=>{
    if($('tempOn')?.checked){
      $('tempStatus').textContent='Temperature: loading higher-detail regional data…';
      $('tempStatus').className='status';
    }
    await Promise.all([
      fetchAllTemperatureData(),
      loadTemperatureCountryFeatures().catch(()=>null)
    ]);
  })();

  try{
    await temperatureLoadPromise;
  }finally{
    temperatureLoadPromise=null;
  }
}

async function loadTemperatures(force=false){
  await ensureTemperatureData(force);

  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame && $('tempOn').checked) queueTemperatureRender(frame.time,0);
}

async function prefetchTemperatures(){
  try{
    await ensureTemperatureData(false);
  }catch(e){
    // Prefetch is optional; if it fails, the normal Temperature toggle will retry.
    console.warn('Temperature background prefetch skipped:',e);
  }
}

