// Station measurements are independent of the satellite snow-cover colours.
const snowDepthLabels=L.layerGroup();
const snowDepthSources={
  EE:{name:'Keskkonnaagentuur',url:'https://www.ilmateenistus.ee/'},
  FI:{name:'Finnish Meteorological Institute (FMI)',url:'https://en.ilmatieteenlaitos.fi/open-data'},
  SE:{name:'SMHI',url:'https://www.smhi.se/data/meteorologi/sno'}
};
let snowDepthData=null,snowDepthLoadedAt=0,snowDepthRequest=null,snowDepthRenderTimer=null;
const snowDepthMaxAge=7*24*3600;
function snowDepthEnabled(){return snowMode && $('snowDepthOn').checked;}
function snowDepthEscape(value){
  return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function snowDepthValid(s,now=Date.now()/1000){
  if(!s || !snowDepthSources[s.country] || !s.name || !Number.isFinite(s.lat) || !Number.isFinite(s.lon))return false;
  if(s.lat<53 || s.lat>72 || s.lon<10 || s.lon>33 || !Number.isFinite(s.time) || s.time>now || now-s.time>snowDepthMaxAge)return false;
  if(['trace','patchy'].includes(s.state))return s.depthCm===null;
  return Number.isFinite(s.depthCm) && s.depthCm>=0 && s.depthCm<=1500;
}
function snowDepthText(s){
  if(s.state==='trace')return '<0.5 cm';
  if(s.state==='patchy')return 'Patchy';
  return new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(s.depthCm)+' cm';
}
function snowDepthPopup(s){
  const source=snowDepthSources[s.country],age=Date.now()/1000-s.time;
  const date=new Date(s.time*1000);
  const stamp=s.timePrecision==='day'
    ?date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})+' (observation day)'
    :date.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const quality=s.quality==='provisional'?'Provisional official reading':s.quality==='approved'?'Quality checked':'Official station observation';
  return '<div class="snow-depth-popup"><strong>'+snowDepthEscape(s.name)+'</strong><div class="snow-depth-value">'+snowDepthEscape(snowDepthText(s))+'</div>'+
    (s.note?'<p>'+snowDepthEscape(s.note)+'</p>':'')+
    '<p>'+snowDepthEscape(stamp)+'</p>'+
    (age>36*3600?'<p class="snow-depth-old">Older reading · more than 36 hours ago</p>':'')+
    '<p>'+quality+'</p><a href="'+source.url+'" target="_blank" rel="noopener">'+source.name+' ↗</a></div>';
}
function hideSnowDepth(){
  clearTimeout(snowDepthRenderTimer);snowDepthRenderTimer=null;
  snowDepthLabels.clearLayers();
  if(map.hasLayer(snowDepthLabels))map.removeLayer(snowDepthLabels);
}
function renderSnowDepth(){
  hideSnowDepth();
  if(!snowDepthEnabled())return;
  const status=$('snowDepthStatus');
  if(!snowDepthData){status.textContent='Loading station snow depths…';return;}
  const now=Date.now()/1000;
  const stations=snowDepthData.stations.filter(s=>snowDepthValid(s,now));
  const zero=$('snowDepthZero').checked;
  const visible=stations.filter(s=>zero || s.depthCm!==0);
  // Higher depths take precedence when labels would overlap in the overview.
  visible.sort((a,b)=>(b.depthCm??.1)-(a.depthCm??.1));
  const occupied=[],bounds=map.getBounds(),size=map.getSize(),center=map.getCenter().lng;
  for(const s of visible){
    const lng=s.lon+360*Math.round((center-s.lon)/360),ll=L.latLng(s.lat,lng);
    if(!bounds.contains(ll))continue;
    const point=map.latLngToContainerPoint(ll);
    if(point.x<0 || point.y<0 || point.x>size.x || point.y>size.y)continue;
    const gap=map.getZoom()<5?58:48;
    if(occupied.some(p=>Math.abs(p.x-point.x)<gap && Math.abs(p.y-point.y)<25))continue;
    occupied.push(point);
    const old=now-s.time>36*3600;
    const label=snowDepthText(s);
    const icon=L.divIcon({className:'snow-depth-marker',html:'<span class="snow-depth-label'+(old?' snow-depth-stale':'')+(s.depthCm===0?' snow-depth-zero':'')+'">'+snowDepthEscape(label)+'</span>',
      iconSize:[58,24],iconAnchor:[29,12]});
    L.marker(ll,{icon,title:s.name+' · '+label,keyboard:true}).bindPopup(snowDepthPopup(s),{maxWidth:300}).addTo(snowDepthLabels);
  }
  snowDepthLabels.addTo(map);
  const counts=Object.entries(snowDepthSources).map(([country,source])=>{
    const n=stations.filter(s=>s.country===country).length;
    const provider=snowDepthData.providers?.[country];
    return country+': '+n+(provider?.status==='unavailable'?' (feed unavailable)':'');
  });
  status.textContent=stations.length
    ?stations.length+' recent official stations · '+counts.join(' · ')+'. Zoom in for more labels. Dashed labels are older than 36 hours.'
    :'No recent official snow-depth readings are available. Missing data is not zero snow.';
  status.className='status'+(stations.length?'':' warn');
}
async function loadSnowDepth(force=false){
  if(!snowDepthEnabled()){hideSnowDepth();return;}
  if(!force && snowDepthData && Date.now()-snowDepthLoadedAt<15*60*1000){renderSnowDepth();return;}
  $('snowDepthStatus').textContent='Loading station snow depths…';
  try{
    if(!snowDepthRequest){
      snowDepthRequest=fetch('data/official-snow-depth.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)})
        .then(async response=>{
          if(!response.ok)throw new Error('Snow-depth snapshot HTTP '+response.status);
          const data=await response.json();
          if(!Array.isArray(data.stations))throw new Error('Invalid snow-depth snapshot');
          snowDepthData=data;snowDepthLoadedAt=Date.now();
        }).finally(()=>{snowDepthRequest=null;});
    }
    await snowDepthRequest;renderSnowDepth();
  }catch(error){
    if(!snowDepthEnabled())return;
    if(snowDepthData)renderSnowDepth();
    $('snowDepthStatus').textContent='Station snow-depth update unavailable.'+(snowDepthData?' Previously downloaded readings retain their original dates.':' Please try Refresh snow.');
    $('snowDepthStatus').className='status bad';
    console.warn(error);
  }
}
$('snowDepthOn').addEventListener('change',()=>loadSnowDepth());
$('snowDepthZero').addEventListener('change',renderSnowDepth);
$('snowDepthRegion').addEventListener('click',()=>{
  $('snowDepthOn').checked=true;
  map.fitBounds([[57,11],[71,32]],{padding:[30,30],animate:false});
  loadSnowDepth();
});
map.on('moveend zoomend',()=>{
  if(!snowDepthEnabled())return;
  clearTimeout(snowDepthRenderTimer);
  snowDepthRenderTimer=setTimeout(renderSnowDepth,100);
});
