const $ = id => document.getElementById(id);

if (!window.L) {
  document.body.innerHTML='<div style="padding:24px;color:white;background:#111;font:16px Arial"><b>Leaflet could not load.</b><br>Internet access to cdn.jsdelivr.net is required.</div>';
  throw new Error("Leaflet missing");
}

const map = L.map('map',{center:[57.25,24.75],zoom:6,minZoom:2,maxZoom:18,zoomControl:true,worldCopyJump:true});
map.createPane('warningPane');
map.getPane('warningPane').style.zIndex='625';
map.getPane('warningPane').style.pointerEvents='auto';

const street = L.tileLayer(
  'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  {
    subdomains:'abc',
    maxZoom:17,
    attribution:'Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)'
  }
);

const aerial = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {maxZoom:19,attribution:'Tiles © Esri'}
).addTo(map);

const satTransport = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  {maxZoom:19,opacity:0.95,attribution:'Reference © Esri'}
).addTo(map);

const satPlaces = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  {maxZoom:19,opacity:0.95,attribution:'Reference © Esri'}
).addTo(map);

// Transparent sea-only depth shading, underneath all weather overlays.
map.createPane('bathymetryPane');
map.getPane('bathymetryPane').style.zIndex='250';
map.getPane('bathymetryPane').style.pointerEvents='none';
const seaDepth=L.tileLayer(
  'https://tiles.emodnet-bathymetry.eu/v12/mean_multicolour/web_mercator/{z}/{x}/{y}.png',
  {pane:'bathymetryPane',opacity:.65,maxNativeZoom:15,maxZoom:18,
   attribution:'Sea depth © EMODnet Bathymetry (2024 DTM)'}
);

let cloudLayer=null; // compatibility alias for the foremost cloud layer
let cloudLayerLow=null;
let cloudLayerHigh=null;
let cloudLayerLowSlot=null;
let cloudLayerHighSlot=null;
let cloudBlendFraction=0;
const cloudImageCache=new Map();
const cloudFramePromises=new Map();
const CLOUD_CACHE_LIMIT=18;
let cloudPrecacheTimer=null;
let cloudPrecacheGeneration=0;
let cloudProcessingLabel='';
let radarLayer=null;
let balticRadarLayer=null;
let rainviewerData=null;
let locationMarker=null;
let locationAccuracy=null;
let locationWatchId=null;
let locationBestFix=null;
let locationFinishTimer=null;

let warningLayerGroup=L.layerGroup();
let warningRecords=[];
let lithuaniaWarnings=[];
let lithuaniaBoundaryGeo=null;
let lithuaniaWarningLoadedAt=0;
let warningLoadedAt=0;
let warningLoadGeneration=0;

let temperatureLayer=null;
let temperatureLabels=L.layerGroup();
let temperatureSeries=[];
let temperatureLoadedAt=0;

// Performance caches for the temperature layer.
const temperatureImageCache=new Map();
const temperatureStatsCache=new Map();
const TEMP_CACHE_LIMIT=16;
let temperatureRenderToken=0;
let temperatureDebounceTimer=null;
let temperaturePrecacheTimer=null;
let frames=[];
let playing=false;
let timer=null;
let h5Ready=null;

let timelineDebounceTimer=null;
let cloudRenderGeneration=0;
let radarSwapGeneration=0;

// Incremented whenever a radar render should become obsolete.
// This prevents an older async HDF5 decode from adding itself back
// after the radar has been switched off or the timeline has moved.
let radarRenderGeneration=0;
const radarImageCache=new Map();
const MAX_CACHE=6;

function fmt(unix){
  return new Intl.DateTimeFormat(undefined,{
    weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'
  }).format(new Date(unix*1000));
}

function iso10(unix){
  const d=new Date(unix*1000);
  d.setUTCSeconds(0,0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes()/10)*10);
  return d.toISOString().replace('.000Z','Z');
}

function iso15(unix){
  const d=new Date(unix*1000);
  d.setUTCSeconds(0,0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes()/15)*15);
  return d.toISOString().replace('.000Z','Z');
}


function weatherFront(){
  if(temperatureLayer && map.hasLayer(temperatureLayer) && temperatureLayer.bringToFront) temperatureLayer.bringToFront();

  if(cloudLayerLow && map.hasLayer(cloudLayerLow) && cloudLayerLow.bringToFront) cloudLayerLow.bringToFront();
  if(cloudLayerHigh && map.hasLayer(cloudLayerHigh) && cloudLayerHigh.bringToFront) cloudLayerHigh.bringToFront();
  if(radarLayer && map.hasLayer(radarLayer) && radarLayer.bringToFront) radarLayer.bringToFront();

  if(map.hasLayer(warningLayerGroup)){
    warningLayerGroup.eachLayer(layer=>{
      if(layer.bringToFront) layer.bringToFront();
      if(layer.eachLayer) layer.eachLayer(sub=>sub.bringToFront?.());
    });
  }

  // L.LayerGroup itself has no bringToFront(). Re-add labels last so they sit above overlays.
  if(map.hasLayer(temperatureLabels)){
    map.removeLayer(temperatureLabels);
    temperatureLabels.addTo(map);
  }
}

function useStreet(){
  if(map.hasLayer(aerial)) map.removeLayer(aerial);
  if(map.hasLayer(satTransport)) map.removeLayer(satTransport);
  if(map.hasLayer(satPlaces)) map.removeLayer(satPlaces);
  if(!map.hasLayer(street)) street.addTo(map);
  if(!map.hasLayer(seaDepth)) seaDepth.addTo(map);

  $('streetBtn').classList.add('active');
  $('satBtn').classList.remove('active');

  weatherFront();
}
function useSatellite(){
  if(map.hasLayer(seaDepth)) map.removeLayer(seaDepth);
  if(map.hasLayer(street)) map.removeLayer(street);
  if(!map.hasLayer(aerial)) aerial.addTo(map);
  if(!map.hasLayer(satTransport)) satTransport.addTo(map);
  if(!map.hasLayer(satPlaces)) satPlaces.addTo(map);

  $('streetBtn').classList.remove('active');
  $('satBtn').classList.add('active');

  weatherFront();
}




function clearLocationMarker(){
  if(locationMarker){
    map.removeLayer(locationMarker);
    locationMarker=null;
  }
  if(locationAccuracy){
    map.removeLayer(locationAccuracy);
    locationAccuracy=null;
  }
}

function applyLocationFix(pos,{recenter=true}={}){
  const lat=pos.coords.latitude;
  const lon=pos.coords.longitude;
  const accuracy=Math.max(1,pos.coords.accuracy||0);

  clearLocationMarker();

  locationAccuracy=L.circle([lat,lon],{
    radius:accuracy,
    color:'#2387ff',
    weight:1,
    opacity:.6,
    fillColor:'#2387ff',
    fillOpacity:.12,
    interactive:false
  }).addTo(map);

  locationMarker=L.marker([lat,lon],{
    icon:L.divIcon({
      className:'',
      html:'<div class="location-dot"></div>',
      iconSize:[16,16],
      iconAnchor:[8,8]
    }),
    title:'My location'
  }).addTo(map);

  if(recenter){
    map.setView([lat,lon],Math.max(map.getZoom(),12));
  }

  return accuracy;
}

function finishLocationWatch(){
  if(locationWatchId!==null){
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId=null;
  }
  if(locationFinishTimer){
    clearTimeout(locationFinishTimer);
    locationFinishTimer=null;
  }

  if(locationBestFix){
    const acc=applyLocationFix(locationBestFix,{recenter:false});
    $('locationStatus').textContent=
      `Location ready · best accuracy about ${Math.round(acc)} m`;
    $('locationStatus').className='status ok';
  }
}

function showMyLocation(){
  const status=$('locationStatus');

  if(!navigator.geolocation){
    status.textContent='Location is not supported by this browser.';
    status.className='status bad';
    return;
  }

  if(locationWatchId!==null){
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId=null;
  }
  if(locationFinishTimer){
    clearTimeout(locationFinishTimer);
    locationFinishTimer=null;
  }

  locationBestFix=null;
  let firstFixShown=false;

  status.textContent='Getting your location…';
  status.className='status';

  locationWatchId=navigator.geolocation.watchPosition(
    pos=>{
      const acc=pos.coords.accuracy||Infinity;

      // Show the first available location immediately.
      if(!firstFixShown){
        firstFixShown=true;
        locationBestFix=pos;
        applyLocationFix(pos,{recenter:true});

        status.textContent=
          `Quick location found · about ${Math.round(acc)} m accuracy · refining…`;
        status.className='status';
      }else if(!locationBestFix ||
               acc < (locationBestFix.coords.accuracy||Infinity)){
        // Improve the marker whenever a better fix arrives.
        locationBestFix=pos;
        applyLocationFix(pos,{recenter:false});

        status.textContent=
          `Location improved · about ${Math.round(acc)} m accuracy · refining…`;
        status.className='status';
      }

      if(acc<=20){
        finishLocationWatch();
      }
    },
    err=>{
      let msg='Location request failed.';
      if(err.code===1) msg='Location permission was denied.';
      else if(err.code===2) msg='Your location is currently unavailable.';
      else if(err.code===3) msg='Location request timed out.';

      if(location.protocol==='file:'){
        msg+=' Local file mode can also limit browser location support.';
      }

      status.textContent=msg;
      status.className='status warn';

      if(locationWatchId!==null){
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId=null;
      }
    },
    {
      enableHighAccuracy:true,
      timeout:12000,
      maximumAge:15000
    }
  );

  // Keep improving briefly, but never delay the first marker.
  locationFinishTimer=setTimeout(finishLocationWatch,7000);
}



map.on('zoomend',()=>{
  if($('tempOn')?.checked && temperatureSeries.length){
    const i=Number($('timeline').value);
    const frame=frames[i];
    if(frame) renderTemperatureLabels(frame.time);
  }
});

function setWeatherSectionState(id,on){
  const el=$(id);
  if(!el) return;
  el.classList.toggle('enabled',!!on);
}

