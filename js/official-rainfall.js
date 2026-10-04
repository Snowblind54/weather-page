// Official gauge histories are published as a same-origin snapshot by Actions.
const RAIN_COUNTRY_CODES={'233':'EE','428':'LV','440':'LT','246':'FI','752':'SE','578':'NO','352':'IS','616':'PL','208':'DK'};
const RAIN_COUNTRY_NAMES={EE:'Estonia',LV:'Latvia',LT:'Lithuania',FI:'Finland',SE:'Sweden',NO:'Norway',IS:'Iceland',PL:'Poland',DK:'Denmark'};
const OFFICIAL_RAIN_RADIUS_KM=100;
let officialRainData=null,officialRainLoadedAt=0,officialRainLoadPromise=null;
let officialRainLabels=null;
const officialRainWindows=new Map();
const rainCountryMasks=new Map();

function validOfficialRainSnapshot(data){
  if(data?.version!==1 || !Number.isFinite(data.generatedAt) || data.generatedAt>Date.now()/1000+300 ||
     !Array.isArray(data.stations) || !data.sources) return false;
  return data.stations.every(s=>RAIN_COUNTRY_NAMES[s.country] && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
    s.lat>=48 && s.lat<=72.5 && s.lon>=-26 && s.lon<=33 && typeof s.code==='string' &&
    Array.isArray(s.times) && Array.isArray(s.amounts) && s.times.length===s.amounts.length &&
    s.times.every((t,i)=>Number.isFinite(t)&&t%3600===0&&(!i||t>s.times[i-1])) &&
    s.amounts.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1000));
}

async function loadOfficialRainfall(force=false){
  if(!force && Date.now()-officialRainLoadedAt<10*60*1000) return;
  if(!officialRainLoadPromise){
    officialRainLoadPromise=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch('data/official-rainfall.json',{cache:'no-store',signal:controller.signal});
        if(!response.ok) throw new Error('official snapshot HTTP '+response.status);
        const data=await response.json();
        if(!validOfficialRainSnapshot(data)) throw new Error('invalid official rainfall snapshot');
        if(officialRainData?.generatedAt!==data.generatedAt){
          officialRainData=data;officialRainWindows.clear();rainImageCache.clear();rainRenderGeneration++;
        }
      }catch(error){console.warn('Official rainfall: model fallback',error.message);}
      finally{clearTimeout(timer);officialRainLoadedAt=Date.now();}
    })().finally(()=>{officialRainLoadPromise=null;});
  }
  await officialRainLoadPromise;
}

function rainfallCountryAt(lat,lon){
  return rainCountryFeatures?.find(f=>RAIN_COUNTRY_CODES[String(f.id)]&&weatherPointInFeature(lat,lon,f))?.id;
}

function officialRainWindow(country,hours,end){
  const key=country+'|'+hours+'|'+end;
  if(!officialRainData || Date.now()/1000-officialRainData.generatedAt>3*3600) return null;
  if(officialRainWindows.has(key)) return officialRainWindows.get(key);
  let result=null;
  if(officialRainData && Date.now()/1000-officialRainData.generatedAt<=3*3600){
    const stations=officialRainData.stations.filter(s=>s.country===country);
    // National reporting can lag. Use a consistent country window and display
    // its actual end; never label an older measurement as the selected hour.
    for(let offset=0;offset<=2;offset++){
      const actualEnd=end-offset*3600;
      const rows=stations.map(station=>({station,value:rollingRainTotal(station,actualEnd,hours)})).filter(s=>Number.isFinite(s.value));
      if(rows.length>=3){result={rows,end:actualEnd,country,source:officialRainData.sources[country]?.name||country};break;}
    }
  }
  officialRainWindows.set(key,result);
  while(officialRainWindows.size>100) officialRainWindows.delete(officialRainWindows.keys().next().value);
  return result;
}

function officialRainAt(lat,lon,hours,end,country){
  if(!country) return null;
  const window=officialRainWindow(country,hours,end);
  if(!window) return null;
  const neighbours=[],cos=Math.cos(lat*Math.PI/180);
  for(const row of window.rows){
    const s=row.station;
    const dy=(s.lat-lat)*111.2,dx=(s.lon-lon)*111.2*cos,d2=dx*dx+dy*dy;
    if(d2>OFFICIAL_RAIN_RADIUS_KM**2) continue;
    const sample={...row,d2};
    let i=0;while(i<neighbours.length&&neighbours[i].d2<d2)i++;
    neighbours.splice(i,0,sample);if(neighbours.length>6)neighbours.pop();
  }
  if(!neighbours.length) return null;
  const nearest=neighbours[0];
  let value=nearest.value;
  // A station click gives its actual reading; elsewhere this is an estimate.
  if(nearest.d2>0.01){
    let sum=0,weights=0;
    for(const s of neighbours){const weight=1/Math.max(0.01,s.d2);sum+=s.value*weight;weights+=weight;}
    value=sum/weights;
  }
  return {value,end:window.end,country,source:window.source,nearest:nearest.station,
    nearestValue:nearest.value,distance:Math.sqrt(nearest.d2),count:neighbours.length,
    trace:neighbours.some(n=>(n.station.traces||[]).some(t=>t<=window.end&&t>window.end-hours*3600))};
}

function rainCountryMask(region,features){
  if(rainCountryMasks.has(region.id)) return rainCountryMasks.get(region.id);
  const canvas=document.createElement('canvas');canvas.width=region.w;canvas.height=region.h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const ids=[...TEMP_REGION_COUNTRY_IDS[region.id]];
  ids.forEach((id,i)=>{
    const feature=features.find(f=>String(f.id)===id);if(!feature)return;
    ctx.beginPath();addMaskGeometry(ctx,feature.geometry,region,region.w,region.h);
    ctx.fillStyle='rgb('+(i+1)+',0,0)';ctx.fill('evenodd');
  });
  const pixels=ctx.getImageData(0,0,region.w,region.h).data;
  const result={pixels,ids};rainCountryMasks.set(region.id,result);return result;
}

function officialRainSourceSummary(hours,end){
  const official=[],model=[];
  for(const [country,name] of Object.entries(RAIN_COUNTRY_NAMES)){
    const window=officialRainWindow(country,hours,end);
    if(window) official.push(name+' ('+window.rows.length+' gauges; ending '+fmt(window.end)+')');
    else model.push(name);
  }
  return 'Official precipitation: '+(official.join('; ')||'none for this period')+'. Open-Meteo rain fallback: '+
    (model.join(', ')||'gaps only')+'. Model also fills areas beyond 100 km from a reporting gauge. '+
    'Official precipitation includes snow water equivalent; model fallback is rain + showers.';
}

function removeOfficialRainLabels(){
  if(officialRainLabels){map.removeLayer(officialRainLabels);officialRainLabels=null;}
}

// A number at a gauge is a measurement, independent of whether there are enough
// neighbours for a heatmap. Preserve a delayed complete window with its true end.
function officialStationRainWindow(station,hours,end){
  for(let i=station.times.length-1;i>=0;i--){
    const actualEnd=station.times[i];
    if(actualEnd>end)continue;
    if(end-actualEnd>24*3600)break;
    const value=rollingRainTotal(station,actualEnd,hours);
    if(Number.isFinite(value))return {value,end:actualEnd,delayed:end-actualEnd>2*3600};
  }
  return null;
}

function renderOfficialRainLabels(){
  removeOfficialRainLabels();
  const hours=activeAccumulationHours();
  const status=$('rainGaugeStatus');
  if(!hours){if(status)status.textContent='';return;}
  if(!officialRainData){if(status)status.textContent='No official station observations available yet.';return;}
  const end=rainWindowEnd(),occupied=[],markers=[],ends=[];let delayed=0;
  const panel=document.querySelector('.weather-panel:not([hidden])')?.getBoundingClientRect();
  const mapRect=map.getContainer().getBoundingClientRect();
  for(const s of officialRainData.stations){
      if(!map.getBounds().contains([s.lat,s.lon]))continue;
      const window=officialStationRainWindow(s,hours,end);if(!window)continue;
      const value=window.value,source=officialRainData.sources[s.country]?.name||s.country;
      const p=map.latLngToContainerPoint([s.lat,s.lon]);
      const underPanel=panel&&p.x+mapRect.x>=panel.left-25&&p.x+mapRect.x<=panel.right+25&&p.y+mapRect.y>=panel.top-12&&p.y+mapRect.y<=panel.bottom+12;
      if(underPanel || occupied.some(q=>Math.abs(q.x-p.x)<76&&Math.abs(q.y-p.y)<30))continue;
      occupied.push(p);ends.push(window.end);if(window.delayed)delayed++;
      const title=s.name+' · '+hours+' h: '+value.toFixed(1)+' mm · '+source+' · Ending '+fmt(window.end)+(window.delayed?' · delayed reading':'');
      const marker=L.marker([s.lat,s.lon],{title,icon:L.divIcon({className:'',iconSize:[70,22],iconAnchor:[35,11],
        html:'<span class="rain-station-label'+(window.delayed?' rain-station-delayed':'')+'" title="'+htmlEscape(title)+'">'+value.toFixed(1)+' mm'+(window.delayed?' <small aria-hidden="true">◷</small>':'')+'</span>'})});
      marker.on('click',()=>{
        rainProbe={lat:s.lat,lng:s.lon,station:s};
        if(!rainPopup)rainPopup=L.popup({maxWidth:350,className:'rain-popup-container',autoPan:false,keepInView:false});
        rainPopup.setLatLng(rainProbe).setContent(rainfallPopupContent(rainProbe,rainWindowEnd())).openOn(map);
        requestAnimationFrame(renderOfficialRainLabels);
      });markers.push(marker);
  }
  officialRainLabels=L.layerGroup(markers).addTo(map);
  if(status){
    const first=Math.min(...ends),last=Math.max(...ends);
    status.textContent=markers.length?'Measured station numbers: '+markers.length+' in view · '+hours+' h ending '+fmt(first)+(last!==first?' to '+fmt(last):'')+
      (delayed?' · ◷ marks '+delayed+' delayed readings.':''):'No complete '+hours+' h station totals in this view. Missing hours are never counted as zero.';
  }
}
map.on('moveend zoomend',()=>{if(activeAccumulationHours())renderOfficialRainLabels();});
