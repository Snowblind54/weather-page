// Daily official IMS archive. At most three decoded day bundles remain in memory.
let snowHistoryActive=false,snowHistoryFrames=[],snowHistoryIndex=-1;
let snowHistoryGeneration=0,snowHistoryPlaying=false,snowHistoryTimer=null,snowHistoryManifestRequest=null;
const snowHistoryCache=new Map(),snowHistoryPending=new Map();
const SNOW_EMPTY_TILE='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const SnowHistoryLayer=L.GridLayer.extend({
  createTile(coords,done){
    const tile=document.createElement('img');tile.alt='';tile.setAttribute('role','presentation');
    tile.onload=()=>done(null,tile);tile.onerror=()=>done(new Error('Snow archive tile failed'),tile);
    const n=2**coords.z,x=((coords.x%n)+n)%n;
    const encoded=this.bundle.tiles[coords.z+'/'+x+'/'+coords.y];
    tile.src=encoded?'data:image/png;base64,'+encoded:SNOW_EMPTY_TILE;
    return tile;
  }
});
let snowHistoryLayer=null,snowHistoryLoading=false,snowHistorySliderTimer=null;
function snowHistoryControls(){
  const slider=$('snowHistorySlider'),count=snowHistoryFrames.length;
  slider.max=String(Math.max(0,count-1));slider.disabled=!count;
  slider.value=String(Math.max(0,snowHistoryIndex<0?count-1:snowHistoryIndex));
  $('snowHistoryPrev').disabled=!count || (snowHistoryActive && snowHistoryIndex<=0);
  $('snowHistoryNext').disabled=!count || !snowHistoryActive || snowHistoryIndex>=count-1;
  $('snowHistoryPlay').disabled=count<2;
  $('snowHistoryPlay').textContent=snowHistoryPlaying?'Pause':'Play';
  $('snowHistoryPlay').setAttribute('aria-pressed',String(snowHistoryPlaying));
  $('snowHistoryLatest').disabled=!snowHistoryActive && !snowHistoryLoading;
  $('snowHistoryRange').textContent=count?snowHistoryFrames[0].date+' → '+snowHistoryFrames[count-1].date+' UTC':'Daily archive unavailable';
  const date=snowHistoryActive?snowHistoryFrames[snowHistoryIndex]?.date:'Latest · 1 km';
  $('snowHistorySelected').textContent=date||'Loading daily analysis…';
  slider.setAttribute('aria-valuetext',snowHistoryFrames[Number(slider.value)]?.date+' UTC');
}
async function loadSnowHistory(force=false){
  if(snowHistoryFrames.length && !force){snowHistoryControls();return;}
  try{
    if(!snowHistoryManifestRequest){
      snowHistoryManifestRequest=fetch('data/snow-history.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)})
        .then(async response=>{if(!response.ok)throw new Error('Snow archive HTTP '+response.status);return response.json();})
        .finally(()=>{snowHistoryManifestRequest=null;});
    }
    const manifest=await snowHistoryManifestRequest;
    if(manifest.version!==1 || !Array.isArray(manifest.frames))throw new Error('Invalid archive manifest');
    const frames=manifest.frames.filter(f=>/^\d{4}-\d{2}-\d{2}$/.test(f.date) && /^data\/snow-history\/[\w.-]+\.json\.gz$/.test(f.url))
      .sort((a,b)=>a.date.localeCompare(b.date));
    if(!frames.length)throw new Error('No archived analyses');
    // Refreshing the manifest must not silently replace the selected date.
    const selected=snowHistoryFrames[snowHistoryIndex]?.date;
    if(snowHistoryActive && !frames.some(f=>f.date===selected))snowHistoryLatest();
    snowHistoryFrames=frames;snowHistoryIndex=selected?frames.findIndex(f=>f.date===selected):-1;
    $('snowHistoryNote').textContent='Daily 4 km archive · '+frames.length+' available dates. Station depths are shown in Latest only.';
    snowHistoryControls();
  }catch(error){
    $('snowHistoryNote').textContent='Daily archive update unavailable. '+(snowHistoryFrames.length?'Cached dates remain available.':'Latest snow coverage still works.');
    snowHistoryControls();console.warn('Snow archive unavailable',error);
  }
}
async function getSnowHistoryBundle(frame){
  if(snowHistoryCache.has(frame.url)){
    const bundle=snowHistoryCache.get(frame.url);snowHistoryCache.delete(frame.url);snowHistoryCache.set(frame.url,bundle);return bundle;
  }
  if(snowHistoryPending.has(frame.url))return snowHistoryPending.get(frame.url);
  const request=(async()=>{
    const response=await fetch(frame.url,{signal:AbortSignal.timeout(30000),cache:'force-cache'});
    if(!response.ok)throw new Error('Snow archive HTTP '+response.status);
    // GitHub Pages serves gzip files as bytes. Also tolerate a host which decodes them.
    const bytes=new Uint8Array(await response.arrayBuffer());
    const blob=new Blob([bytes]);
    const stream=bytes[0]===31 && bytes[1]===139?blob.stream().pipeThrough(new DecompressionStream('gzip')):blob.stream();
    const bundle=await new Response(stream).json();
    if(bundle.date!==frame.date || bundle.maxZoom!==5 || !bundle.tiles || typeof bundle.tiles!=='object')throw new Error('Invalid daily snow tiles');
    snowHistoryCache.set(frame.url,bundle);
    while(snowHistoryCache.size>3)snowHistoryCache.delete(snowHistoryCache.keys().next().value);
    return bundle;
  })().finally(()=>snowHistoryPending.delete(frame.url));
  snowHistoryPending.set(frame.url,request);return request;
}
function stopSnowHistoryPlayback(){snowHistoryPlaying=false;clearTimeout(snowHistoryTimer);snowHistoryTimer=null;snowHistoryControls();}
async function selectSnowHistory(index){
  if(!snowMode || !snowHistoryFrames[index])return false;
  const generation=++snowHistoryGeneration,frame=snowHistoryFrames[index];
  snowHistoryLoading=true;snowHistoryControls();
  snowStatus('Loading '+frame.date+' UTC snow coverage…');
  try{
    const bundle=await getSnowHistoryBundle(frame);
    if(!snowMode || generation!==snowHistoryGeneration)return false;
    const layer=new SnowHistoryLayer({pane:'snowPane',opacity:Number($('snowOpacity').value)/100,
      maxNativeZoom:5,maxZoom:18,bounds:[[0,-180],[85.05112878,180]],keepBuffer:1,
      attribution:'Daily snow & ice: NOAA / USNIC IMS · NSIDC archive (4 km)'});
    layer.bundle=bundle;
    const previous=snowHistoryLayer;
    snowHistoryLoading=false;snowHistoryActive=true;snowHistoryIndex=index;snowHistoryLayer=layer;
    map.removeLayer(snowLayer);if(previous)map.removeLayer(previous);
    if(typeof hideSnowDepth==='function')hideSnowDepth();
    $('snowDepthStatus').textContent='Station depths are hidden on historical maps. Choose Latest for current measurements.';
    layer.addTo(map);
    layer.on('tileerror',()=>{if(snowHistoryLayer===layer)snowStatus(frame.date+' UTC · some archive tiles could not load','bad');});
    $('snowDate').textContent=frame.date+' 00:00 UTC · archived IMS analysis · 4 km';
    snowStatus(frame.date+' UTC · daily IMS archive · 4 km · snow cover, not depth','ok');
    snowHistoryControls();
    const next=snowHistoryFrames[index+1];
    if(next)getSnowHistoryBundle(next).catch(()=>{});
    return true;
  }catch(error){
    if(snowMode && generation===snowHistoryGeneration){snowHistoryLoading=false;snowStatus(frame.date+' could not load. Previous map retained; try again.','bad');stopSnowHistoryPlayback();}
    return false;
  }
}
function snowHistoryLatest(){
  ++snowHistoryGeneration;snowHistoryLoading=false;clearTimeout(snowHistorySliderTimer);stopSnowHistoryPlayback();snowHistoryActive=false;snowHistoryIndex=-1;
  if(snowHistoryLayer)map.removeLayer(snowHistoryLayer);snowHistoryLayer=null;
  if(snowMode){snowLayer.addTo(map);$('snowDate').textContent=snowSourceLabel;snowTileStatus();if(typeof loadSnowDepth==='function')loadSnowDepth();}
  snowHistoryControls();
}
function exitSnowHistory(){
  ++snowHistoryGeneration;snowHistoryLoading=false;clearTimeout(snowHistorySliderTimer);stopSnowHistoryPlayback();snowHistoryActive=false;snowHistoryIndex=-1;
  if(snowHistoryLayer)map.removeLayer(snowHistoryLayer);snowHistoryLayer=null;snowHistoryControls();
}
async function snowHistoryStep(){
  if(!snowHistoryPlaying || !snowMode)return;
  if(document.hidden){snowHistoryTimer=setTimeout(snowHistoryStep,1000);return;}
  const index=!snowHistoryActive || snowHistoryIndex>=snowHistoryFrames.length-1?0:snowHistoryIndex+1;
  await selectSnowHistory(index);
  if(snowHistoryPlaying && snowMode)snowHistoryTimer=setTimeout(snowHistoryStep,1000);
}
$('snowHistorySlider').addEventListener('input',()=>{const index=Number($('snowHistorySlider').value);stopSnowHistoryPlayback();$('snowHistorySlider').value=String(index);++snowHistoryGeneration;clearTimeout(snowHistorySliderTimer);snowHistorySliderTimer=setTimeout(()=>selectSnowHistory(index),150);});
$('snowHistoryPrev').addEventListener('click',()=>{stopSnowHistoryPlayback();selectSnowHistory(snowHistoryActive?Math.max(0,snowHistoryIndex-1):snowHistoryFrames.length-1);});
$('snowHistoryNext').addEventListener('click',()=>{stopSnowHistoryPlayback();selectSnowHistory(Math.min(snowHistoryFrames.length-1,snowHistoryIndex+1));});
$('snowHistoryPlay').addEventListener('click',()=>{if(snowHistoryPlaying)stopSnowHistoryPlayback();else{snowHistoryPlaying=true;snowHistoryControls();snowHistoryStep();}});
$('snowHistoryLatest').addEventListener('click',snowHistoryLatest);
snowHistoryControls();
