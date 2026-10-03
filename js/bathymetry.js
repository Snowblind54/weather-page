// Sparse numeric depth samples. No added contour lines or land elevation labels.
const SEA_DEPTH_CACHE_KEY='weatherMapDepthSamplesV814';
const SEA_DEPTH_CACHE_TTL=30*24*60*60*1000;
const seaDepthSamples=new Map();
const seaDepthRequests=new Map();
const seaDepthLabels=L.layerGroup();
let seaDepthLabelGeneration=0;
let seaDepthLabelTimer=null;
map.createPane('depthLabelPane');
map.getPane('depthLabelPane').style.zIndex='300';
map.getPane('depthLabelPane').style.pointerEvents='none';
try{
  const cache=JSON.parse(localStorage.getItem(SEA_DEPTH_CACHE_KEY));
  if(Number.isFinite(cache?.at) && Date.now()-cache.at<SEA_DEPTH_CACHE_TTL){
    for(const [key,value] of cache.samples||[]){
      if(typeof key==='string' && (value===null||(Number.isFinite(value)&&value>0&&value<12000))) seaDepthSamples.set(key,value);
    }
  }
}catch(_){}

function parseSeaDepth(sample){
  // Current EMODnet samples use signed seabed elevation: negative is under water.
  const value=sample?.avg;
  return typeof value==='number' && Number.isFinite(value) && value<0 && value>-12000?-value:null;
}

async function fetchSeaDepth(lat,lon){
  const key=lat.toFixed(5)+','+lon.toFixed(5);
  if(seaDepthSamples.has(key)) return seaDepthSamples.get(key);
  if(seaDepthRequests.has(key)) return seaDepthRequests.get(key);
  const promise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const geom='POINT('+lon.toFixed(5)+' '+lat.toFixed(5)+')';
      const response=await fetch('https://rest.emodnet-bathymetry.eu/depth_sample?geom='+encodeURIComponent(geom),
        {signal:controller.signal,cache:'force-cache'});
      if(!response.ok) throw new Error('Depth source HTTP '+response.status);
      const depth=parseSeaDepth(await response.json());
      seaDepthSamples.set(key,depth);
      while(seaDepthSamples.size>1200) seaDepthSamples.delete(seaDepthSamples.keys().next().value);
      return depth;
    }finally{clearTimeout(timer);}
  })().finally(()=>seaDepthRequests.delete(key));
  seaDepthRequests.set(key,promise);
  return promise;
}

function seaDepthLabelStep(value){
  const base=10**Math.floor(Math.log10(value));
  return [1,2,5,10].map(n=>n*base).reduce((a,b)=>Math.abs(a-value)<Math.abs(b-value)?a:b);
}

function seaDepthLabelPoints(features){
  const bounds=map.getBounds(),zoom=map.getZoom();
  const degrees=360/(256*2**zoom)*105;
  const lonStep=seaDepthLabelStep(degrees);
  const latStep=seaDepthLabelStep(degrees*Math.max(0.08,Math.cos(map.getCenter().lat*Math.PI/180)));
  const points=[],panel=document.querySelector('.panel')?.getBoundingClientRect();
  const west=Math.max(-70,bounds.getWest()),east=Math.min(43,bounds.getEast());
  const south=Math.max(11,bounds.getSouth()),north=Math.min(85,bounds.getNorth());
  for(let lat=Math.ceil(south/latStep)*latStep;lat<north;lat+=latStep){
    for(let lon=Math.ceil(west/lonStep)*lonStep;lon<east;lon+=lonStep){
      const pixel=map.latLngToContainerPoint([lat,lon]);
      if(panel && pixel.x<panel.right+25 && pixel.y<panel.bottom+15) continue;
      if(features.some(feature=>weatherPointInFeature(lat,lon,feature))) continue;
      points.push([+lat.toFixed(5),+lon.toFixed(5)]);
    }
  }
  // Bound requests even on a very large display. Spread labels across the view.
  const stride=Math.max(1,Math.ceil(points.length/48));
  return points.filter((_,i)=>i%stride===0).slice(0,48);
}

async function renderSeaDepthLabels(generation){
  if(!map.hasLayer(street)||map.getZoom()<5) return;
  const features=await loadTemperatureCountryFeatures();
  if(generation!==seaDepthLabelGeneration||!map.hasLayer(street)) return;
  const points=seaDepthLabelPoints(features);
  seaDepthLabels.clearLayers();seaDepthLabels.addTo(map);
  let next=0,count=0,failed=0;
  const worker=async()=>{
    while(next<points.length && generation===seaDepthLabelGeneration && map.hasLayer(street)){
      const [lat,lon]=points[next++];
      try{
        const depth=await fetchSeaDepth(lat,lon);
        if(generation!==seaDepthLabelGeneration||!map.hasLayer(street)) return;
        if(depth!==null){
          L.marker([lat,lon],{pane:'depthLabelPane',interactive:false,
            icon:L.divIcon({className:'',html:'<span class="sea-depth-number">'+Math.round(depth)+' m</span>',iconSize:[44,16],iconAnchor:[22,8]})
          }).addTo(seaDepthLabels);
          count++;
        }
      }catch(_){failed++;}
    }
  };
  await Promise.all(Array.from({length:4},worker));
  if(generation!==seaDepthLabelGeneration||!map.hasLayer(street)) return;
  $('depthLabelsStatus').textContent=failed && !count?'Depth numbers unavailable right now.':
    count?'Sea-depth numbers in metres · EMODnet':'Sea-depth numbers appear over covered seas from zoom 5.';
  try{localStorage.setItem(SEA_DEPTH_CACHE_KEY,JSON.stringify({at:Date.now(),samples:[...seaDepthSamples]}));}catch(_){}
}

function syncSeaDepthLabels(){
  const generation=++seaDepthLabelGeneration;
  clearTimeout(seaDepthLabelTimer);
  const visible=map.hasLayer(street);
  $('depthLabelsStatus').hidden=!visible;
  if(!visible||map.getZoom()<5){
    if(map.hasLayer(seaDepthLabels)) map.removeLayer(seaDepthLabels);
    seaDepthLabels.clearLayers();
    if(visible) $('depthLabelsStatus').textContent='Zoom in for sea-depth numbers.';
    return;
  }
  $('depthLabelsStatus').textContent='Loading sea-depth numbers…';
  seaDepthLabelTimer=setTimeout(()=>renderSeaDepthLabels(generation).catch(()=>{
    if(generation===seaDepthLabelGeneration) $('depthLabelsStatus').textContent='Depth numbers unavailable right now.';
  }),250);
}
map.on('moveend zoomend',syncSeaDepthLabels);
