// Completed-hour rain + showers, independent of the two-hour radar archive.
const RAIN_CACHE_KEY='balticWeatherRainAccumulationV814';
const RAIN_CACHE_TTL=30*60*1000;
const RAIN_PERIODS=[1,24,48];
const RAIN_COLOURS=[
  [0.1,[132,211,255]],[1,[46,146,247]],[5,[31,207,168]],
  [10,[204,224,53]],[25,[255,165,46]],[50,[239,68,71]],
  [100,[168,71,219]],[150,[246,84,187]]
];
let rainData=null;
let rainLoadPromise=null;
let rainRetryAt=0;
let rainModelError='';
let rainLayer=null;
let rainRenderGeneration=0;
let rainRenderTimer=null;
let rainPopup=null;
let rainProbe=null;
let rainCountryFeatures=null;
const rainImageCache=new Map();
const weatherGeometryCache=new WeakMap();
map.createPane('rainAccumulationPane');
map.getPane('rainAccumulationPane').style.zIndex='410';
map.getPane('rainAccumulationPane').style.pointerEvents='none';

function activeAccumulationHours(){
  return RAIN_PERIODS.find(hours=>$('rain'+hours+'h')?.checked)||0;
}

function rainWindowEnd(unix=selectedWindTime()){
  // API rain at 10:00 means the amount in 09:00–10:00. Never sum a future hour.
  return Math.floor(Math.min(unix,Date.now()/1000)/3600)*3600;
}

function rainColour(mm){
  if(mm<=RAIN_COLOURS[0][0]) return RAIN_COLOURS[0][1];
  for(let i=1;i<RAIN_COLOURS.length;i++){
    const [b,cb]=RAIN_COLOURS[i], [a,ca]=RAIN_COLOURS[i-1];
    if(mm<=b){
      const f=(mm-a)/(b-a);
      return ca.map((v,j)=>Math.round(v+(cb[j]-v)*f));
    }
  }
  return RAIN_COLOURS.at(-1)[1];
}

function normalizeRainSeries(item,point){
  const hourly=item?.hourly;
  if(item?.hourly_units?.rain!=='mm' || item?.hourly_units?.showers!=='mm' ||
     !Array.isArray(hourly?.time) || hourly.time.length<49 ||
     hourly.rain?.length!==hourly.time.length || hourly.showers?.length!==hourly.time.length ||
     !hourly.time.every((t,i)=>Number.isFinite(t) && t%3600===0 && (!i||t-hourly.time[i-1]===3600))){
    throw new Error('Incomplete hourly rainfall response');
  }
  const amounts=hourly.rain.map((rain,i)=>{
    const showers=hourly.showers[i];
    return typeof rain==='number' && typeof showers==='number' &&
      Number.isFinite(rain) && Number.isFinite(showers) && rain>=0 && showers>=0
      ?rain+showers:null;
  });
  return {lat:point[0],lon:point[1],times:hourly.time,amounts};
}

function rollingRainTotal(series,end,hours){
  if(!series || !RAIN_PERIODS.includes(hours) || end%3600!==0) return NaN;
  const last=series.times.indexOf(end),first=last-hours+1;
  if(first<0) return NaN;
  let total=0;
  for(let i=first;i<=last;i++){
    const amount=series.amounts[i];
    if(series.times[i]!==end-(last-i)*3600 || typeof amount!=='number' ||
       !Number.isFinite(amount) || amount<0) return NaN;
    total+=amount;
  }
  return total;
}

function validRainData(data,end){
  return data?.version===1 && Number.isFinite(data.savedAt) && data.savedAt<=Date.now()+300000 &&
    Date.now()-data.savedAt<RAIN_CACHE_TTL && TEMP_GRID_SPECS.every(spec=>{
      const series=data.grids?.[spec.id];
      return Array.isArray(series) && series.length===spec.points.length && series.every((s,i)=>
        s.lat===spec.points[i][0] && s.lon===spec.points[i][1] &&
        Array.isArray(s.times) && Array.isArray(s.amounts) && s.times.length===s.amounts.length &&
        s.times.every((t,j)=>Number.isFinite(t) && t%3600===0 && (!j||t-s.times[j-1]===3600)) &&
        s.amounts.every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0)) &&
        s.times.includes(end) && s.times.includes(end-47*3600));
    });
}

async function fetchRainSeries(points){
  const url='https://api.open-meteo.com/v1/forecast?latitude='+points.map(p=>p[0]).join(',')+
    '&longitude='+points.map(p=>p[1]).join(',')+
    '&hourly=rain,showers&past_hours=54&forecast_hours=1&timeformat=unixtime'+
    '&timezone=UTC&precipitation_unit=mm&cell_selection=land';
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!response.ok){
      const error=new Error(response.status===429
        ?'Rainfall service is busy. Please try again in a minute.'
        :'Rainfall service HTTP '+response.status);
      error.rateLimited=response.status===429;
      throw error;
    }
    const data=await response.json();
    const rows=Array.isArray(data)?data:[data];
    if(rows.length!==points.length) throw new Error('Rainfall grid points missing');
    return rows.map((item,i)=>normalizeRainSeries(item,points[i]));
  }finally{clearTimeout(timeout);}
}

async function loadRainfall(force=false){
  if(!activeAccumulationHours()) return;
  await loadOfficialRainfall(force);
  // Station numbers are usable before the slower model grid has loaded.
  renderOfficialRainLabels();
  const end=rainWindowEnd();
  if(!force && validRainData(rainData,end)) return queueRainfallRender(0);
  if(!force){
    try{
      const cached=JSON.parse(localStorage.getItem(RAIN_CACHE_KEY));
      if(validRainData(cached,end)){rainData=cached;return queueRainfallRender(0);}
    }catch(_){}
  }
  if(Date.now()<rainRetryAt){
    if(officialRainData?.stations.length && rainData) return queueRainfallRender(0);
    throw new Error('Rainfall service is cooling down. Please try again in a minute.');
  }
  if(!rainLoadPromise){
    rainLoadPromise=(async()=>{
      // Avoid competing with the startup temperature grid requests.
      if(temperatureLoadPromise) await temperatureLoadPromise.catch(()=>{});
      const grids={};
      for(const spec of TEMP_GRID_SPECS){
        if(!activeAccumulationHours()) return null;
        $('rainAccumStatus').textContent='Loading rainfall · '+spec.id+'…';
        $('rainAccumStatus').className='status';
        const rows=[];
        for(let i=0;i<spec.points.length;i+=80){
          if(!activeAccumulationHours()) return null;
          rows.push(...await fetchRainSeries(spec.points.slice(i,i+80)));
          await sleep(450);
        }
        grids[spec.id]=rows;
      }
      const data={version:1,savedAt:Date.now(),grids};
      if(!validRainData(data,rainWindowEnd())) throw new Error('Completed rainfall hours missing');
      rainData=data;rainModelError='';
      rainImageCache.clear();
      try{localStorage.setItem(RAIN_CACHE_KEY,JSON.stringify(data));}catch(_){}
      return data;
    })().catch(error=>{
      if(error.rateLimited) rainRetryAt=Date.now()+60000;
      if(officialRainData?.stations.length){
        rainModelError=error.message;
        if(!rainData) rainData={version:0,grids:Object.fromEntries(TEMP_GRID_SPECS.map(spec=>[spec.id,
          spec.points.map(([lat,lon])=>({lat,lon,times:[],amounts:[]}))]))};
        rainImageCache.clear();return rainData;
      }
      throw error;
    }).finally(()=>{rainLoadPromise=null;});
  }
  await rainLoadPromise;
  if(activeAccumulationHours() && rainData) queueRainfallRender(0);
}

// Point queries use the same country footprints as the heatmap, including holes.
function weatherPolygonParts(feature){
  if(weatherGeometryCache.has(feature)) return weatherGeometryCache.get(feature);
  const geometry=feature.geometry;
  const polys=geometry?.type==='Polygon'?[geometry.coordinates]:
    geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  const parts=polys.map(rings=>{
    let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
    for(const [lon,lat] of rings[0]||[]){west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);}
    return {rings,west,east,south,north};
  });
  weatherGeometryCache.set(feature,parts);
  return parts;
}

function weatherPointInRing(lat,lon,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    if(((yi>lat)!==(yj>lat)) && lon<(xj-xi)*(lat-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}

function weatherPointInFeature(lat,lon,feature){
  return weatherPolygonParts(feature).some(p=>lat>=p.south&&lat<=p.north&&lon>=p.west&&lon<=p.east&&
    weatherPointInRing(lat,lon,p.rings[0])&&!p.rings.slice(1).some(r=>weatherPointInRing(lat,lon,r)));
}

function rainfallSpecAt(lat,lon){
  if(!rainCountryFeatures) return null;
  return TEMP_GRID_SPECS.find(spec=>{
    const [[south,west],[north,east]]=spec.bounds;
    return lat>=south && lat<=north && lon>=west && lon<=east &&
      rainCountryFeatures.some(feature=>TEMP_REGION_COUNTRY_IDS[spec.id].has(String(feature.id))&&
        weatherPointInFeature(lat,lon,feature));
  })||null;
}

function rainTotalsAt(lat,lon,end){
  const spec=rainfallSpecAt(lat,lon),totals={};
  if(!spec || !rainData?.grids[spec.id]) return null;
  const latB=axisBracket(spec.latitudes,lat),lonB=axisBracket(spec.longitudes,lon);
  for(const hours of RAIN_PERIODS){
    const values=rainData.grids[spec.id].map(series=>rollingRainTotal(series,end,hours));
    // Incomplete weighted neighbours cannot be treated as dry or filled from farther away.
    const cols=spec.longitudes.length;
    const candidates=[
      [latB.i0*cols+lonB.i0,(1-latB.f)*(1-lonB.f)],
      [latB.i0*cols+lonB.i1,(1-latB.f)*lonB.f],
      [latB.i1*cols+lonB.i0,latB.f*(1-lonB.f)],
      [latB.i1*cols+lonB.i1,latB.f*lonB.f]
    ];
    totals[hours]=candidates.some(([i,w])=>w>1e-10&&!Number.isFinite(values[i]))?NaN:
      bilinearValue(values,cols,latB,lonB);
  }
  return totals;
}

async function createRainfallImages(hours,end,generation){
  const officialVersion=officialRainData && Date.now()/1000-officialRainData.generatedAt<=3*3600?officialRainData.generatedAt:0;
  const key=hours+'|'+end+'|'+officialVersion;
  if(rainImageCache.has(key)) return rainImageCache.get(key);
  const features=await loadTemperatureCountryFeatures();
  rainCountryFeatures=features;
  const rendered=[];
  for(const region of TEMP_REGIONS){
    const spec=TEMP_GRID_SPECS.find(s=>s.id===region.id);
    const series=rainData?.grids[region.id];
    if(!series || ![...TEMP_REGION_COUNTRY_IDS[region.id]].every(id=>features.some(f=>String(f.id)===id))){
      throw new Error('Rainfall coverage/coastline missing for '+region.id);
    }
    const values=series.map(s=>rollingRainTotal(s,end,hours));
    const countryMask=officialVersion?rainCountryMask(region,features):null;
    const cols=spec.longitudes.length,W=region.w,H=region.h;
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    const ctx=canvas.getContext('2d',{alpha:true}),image=ctx.createImageData(W,H);
    const west=region.bounds[0][1],east=region.bounds[1][1];
    const lonLookup=Array.from({length:W},(_,x)=>axisBracket(spec.longitudes,west+x/(W-1)*(east-west)));
    for(let y=0;y<H;y++){
      if(generation!==rainRenderGeneration) return null;
      const lat=rasterLatitudeForRow(region,y,H),latB=axisBracket(spec.latitudes,lat);
      for(let x=0;x<W;x++){
        const lonB=lonLookup[x],index=(y*W+x)*4;
        if(!latB||!lonB) continue;
        const indices=[latB.i0*cols+lonB.i0,latB.i0*cols+lonB.i1,latB.i1*cols+lonB.i0,latB.i1*cols+lonB.i1];
        const weights=[(1-latB.f)*(1-lonB.f),(1-latB.f)*lonB.f,latB.f*(1-lonB.f),latB.f*lonB.f];
        const countryId=countryMask?.ids[countryMask.pixels[index]-1];
        const lon=west+x/(W-1)*(east-west);
        const official=officialRainAt(lat,lon,hours,end,RAIN_COUNTRY_CODES[countryId]);
        if(!official && indices.some((i,j)=>weights[j]>1e-10&&!Number.isFinite(values[i]))) continue;
        const value=official?official.value:bilinearValue(values,cols,latB,lonB);
        if(!Number.isFinite(value) || value<0.05) continue; // Dry land is transparent.
        const colour=rainColour(value);
        image.data[index]=colour[0];image.data[index+1]=colour[1];image.data[index+2]=colour[2];
        image.data[index+3]=Math.round(220*Math.min(1,value/0.3));
      }
      if(y%45===0) await new Promise(requestAnimationFrame);
    }
    ctx.putImageData(image,0,0);
    if(!clipTemperatureToCountries(ctx,region,W,H,features)) throw new Error('Rainfall coastline mask unavailable');
    rendered.push({bounds:region.bounds,dataUrl:canvas.toDataURL('image/png')});
  }
  if(generation!==rainRenderGeneration) return null;
  rainImageCache.set(key,rendered);
  while(rainImageCache.size>12) rainImageCache.delete(rainImageCache.keys().next().value);
  return rendered;
}

function removeRainfallLayer(){
  if(rainLayer){map.removeLayer(rainLayer);rainLayer=null;}
}

async function renderRainfall(){
  const hours=activeAccumulationHours();
  if(!hours || !rainData) return;
  const end=rainWindowEnd(),generation=++rainRenderGeneration;
  const images=await createRainfallImages(hours,end,generation);
  if(!images || generation!==rainRenderGeneration || !activeAccumulationHours()) return;
  removeRainfallLayer();
  const opacity=Number($('rainAccumOpacity').value)/100;
  rainLayer=L.layerGroup(images.map(region=>L.imageOverlay(region.dataUrl,region.bounds,
    {pane:'rainAccumulationPane',interactive:false,opacity}))).addTo(map);
  $('rainAccumStatus').textContent=hours+' h accumulation · selected end '+fmt(end)+' · official gauges + model fallback';
  $('rainSourceStatus').textContent=officialRainSourceSummary(hours,end)+(rainModelError?' Model refresh unavailable: '+rainModelError:'');
  renderOfficialRainLabels();
  $('rainAccumStatus').className='status ok';
  updateAccumulationPopup();
}

function queueRainfallRender(delay=90){
  rainRenderGeneration++;
  if(rainRenderTimer) clearTimeout(rainRenderTimer);
  rainRenderTimer=setTimeout(()=>{
    if(activeAccumulationHours()) renderRainfall().catch(reportRainfallError);
  },delay);
}

function reportRainfallError(error){
  if(!activeAccumulationHours()) return;
  removeRainfallLayer();
  renderOfficialRainLabels();
  if(rainPopup && map.hasLayer(rainPopup)) map.removeLayer(rainPopup);
  $('rainAccumStatus').textContent='Rainfall unavailable: '+error.message;
  $('rainAccumStatus').className='status bad';
}

function rainfallPopupContent(point,end){
  const totals=rainTotalsAt(point.lat,point.lng,end),selected=activeAccumulationHours();
  const country=point.station?.country||RAIN_COUNTRY_CODES[String(rainfallCountryAt(point.lat,point.lng))];
  const details={};
  const readings='<div class="rain-popup-readings">'+RAIN_PERIODS.map(hours=>{
    const official=officialRainAt(point.lat,point.lng,hours,end,country);
    let value=official?.value??totals?.[hours];
    let source=official?official.source+(official.distance<0.1?' · measured':' · gauge estimate'):'Open-Meteo · model';
    let actualEnd=official?.end||end;
    // A gauge popup reports this gauge's measurements, not a nearby gauge or
    // model value presented as a measurement when this gauge has gaps.
    if(point.station){
      const station=officialRainData.stations.find(s=>s.country===point.station.country&&s.code===point.station.code)||point.station;
      const stationWindow=officialStationRainWindow(station,hours,end);
      value=stationWindow?.value;actualEnd=stationWindow?.end||end;
      source=(officialRainData.sources[country]?.name||country)+' · measured'+(stationWindow?.delayed?' · delayed reading':'');
    }
    details[hours]={official,value,actualEnd};
    return '<div class="'+(hours===selected?'selected':'')+'"><b>'+hours+' h</b><strong>'+
      (Number.isFinite(value)?value.toFixed(1)+' <small>mm</small>':'Unavailable')+'</strong>'+
      '<span class="rain-popup-source">'+htmlEscape(source)+'<br>Ending '+htmlEscape(fmt(actualEnd))+'</span></div>';
  }).join('')+'</div>';
  const current=details[selected],official=current?.official;
  const gauge=!point.station&&official?'<br>Nearest gauge: '+htmlEscape(official.nearest.name)+' ('+official.distance.toFixed(1)+' km) · '+
    official.nearestValue.toFixed(1)+' mm'+(official.trace?'<br>Includes trace precipitation below 0.1 mm.':''):'';
  const note=country?'Official totals: precipitation including snow water equivalent. Model totals: rain + showers, excluding snow.':
    'Accumulation data is available on land in the nine supported countries.';
  const wind=$('windOn').checked?'<hr>'+windPopupContent(point,selectedWindTime()):'';
  return '<div class="rain-popup"><b>'+(point.station?htmlEscape(point.station.name)+' · measured precipitation':'Accumulated rainfall / precipitation')+'</b>'+readings+
    '<div class="rain-popup-meta">'+point.lat.toFixed(3)+'°, '+point.lng.toFixed(3)+'°'+gauge+
    '<br>'+note+'<br>Between gauges: interpolated estimate. Model fallback beyond 100 km or when a period is incomplete.</div></div>'+wind;
}

function updateAccumulationPopup(){
  if(rainPopup && rainProbe && map.hasLayer(rainPopup)) rainPopup.setContent(rainfallPopupContent(rainProbe,rainWindowEnd()));
}

map.on('click',event=>{
  if(!activeAccumulationHours() || !rainData || !rainCountryFeatures) return;
  if(event.originalEvent?.target?.closest?.('.leaflet-interactive,.leaflet-marker-icon,.leaflet-popup')) return;
  rainProbe=event.latlng;
  if(!rainPopup) rainPopup=L.popup({maxWidth:350,className:'rain-popup-container',autoPan:false,keepInView:false});
  rainPopup.setLatLng(rainProbe).setContent(rainfallPopupContent(rainProbe,rainWindowEnd())).openOn(map);
});

function changeRainfallPeriod(hours){
  if($('rain'+hours+'h').checked){
    for(const other of RAIN_PERIODS) if(other!==hours) $('rain'+other+'h').checked=false;
  }
  const active=activeAccumulationHours();
  $('radarSection').classList.toggle('accumulation-enabled',Boolean(active));
  rainRenderGeneration++;
  clearTimeout(rainRenderTimer);
  removeRainfallLayer();
  removeOfficialRainLabels();
  if(active){loadRainfall().catch(reportRainfallError);updateAccumulationPopup();}
  else{
    if(rainPopup && map.hasLayer(rainPopup)) map.removeLayer(rainPopup);
    $('rainAccumStatus').textContent='Rainfall accumulation is off.';
    $('rainSourceStatus').textContent='';
    $('rainAccumStatus').className='status';
  }
}

for(const hours of RAIN_PERIODS) $('rain'+hours+'h').addEventListener('change',()=>changeRainfallPeriod(hours));
$('rainAccumOpacity').addEventListener('input',()=>{
  const opacity=Number($('rainAccumOpacity').value)/100;
  $('rainAccumOpacityVal').textContent=$('rainAccumOpacity').value+'%';
  rainLayer?.eachLayer(layer=>layer.setOpacity(opacity));
});
setInterval(()=>{
  if(activeAccumulationHours()) loadRainfall().catch(reportRainfallError);
},5*60*1000);
