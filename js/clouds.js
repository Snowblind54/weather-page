// Transparent satellite tiles. Only the visible viewport is requested.
const CLOUD_PADDING=8;
function cloudTileResolution(coords){return coords.z<=4?128:256;}
function cloudTileSide(coords){return cloudTileResolution(coords)*17/16;}
const CLOUD_TILE_CACHE_LIMIT=768, CLOUD_CACHE_BYTES=48*1024*1024, CLOUD_CONCURRENCY=4;
function cloudCacheBytes(){return [...cloudTileCache.values()].reduce((n,t)=>n+(t.canvas.width||256)*(t.canvas.height||256)*4,0);}
function cloudCacheCapacity(tiles){
  const bytes=tiles.reduce((n,t)=>n+cloudTileResolution(t.coords)**2*4,0);
  return Math.max(1,Math.min(Math.floor(CLOUD_CACHE_BYTES/Math.max(1,bytes)),Math.floor(CLOUD_TILE_CACHE_LIMIT/Math.max(1,tiles.length))));
}
const CLOUD_EUMET='https://view.eumetsat.int/geoserver/wms';
const CLOUD_NOAA='https://nowcoast.noaa.gov/geoserver/observations/satellite/ows';
const CLOUD_GIBS='https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const cloudTileCache=new Map(), cloudTilePromises=new Map(), cloudTileRetryAt=new Map();
const cloudControllers=new Set(), cloudQueue=[];
let cloudActiveJobs=0, cloudSession=0;
let cloudHistoryRequested=false, cloudPrecacheTimer=null;
let cloudRequestedTime=null, cloudFrameGeneration=0;
const cloudProducts={
  eumet:{endpoint:CLOUD_EUMET,day:'mtg_fd:rgb_geocolour',night:'mtg_fd:ir105_hrfi',cadence:600},
  noaa:{endpoint:CLOUD_NOAA,day:'goes_visible_imagery',night:'goes_longwave_imagery',cadence:300},
  gibs:{endpoint:CLOUD_GIBS,day:'GOES-East_ABI_GeoColor',night:'GOES-East_ABI_Band13_Clean_Infrared',cadence:600}
};
function cloudGuideSld(){
  // The Cloud Mask is never shown. It is only a soft guide for photographic extraction.
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
 xmlns="http://www.opengis.net/sld"
 xmlns:ogc="http://www.opengis.net/ogc"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <NamedLayer>
    <Name>msg_fes:clm</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="values">
              <ColorMapEntry color="#000000" quantity="0" opacity="0.0"/>
              <ColorMapEntry color="#000000" quantity="1" opacity="0.0"/>
              <ColorMapEntry color="#FFFFFF" quantity="2" opacity="1.0"/>
              <ColorMapEntry color="#000000" quantity="3" opacity="0.0"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;
}

function cloudTileSources(coords){
  const ids=new Set();
  // Sample the tile interior: transition bands can fall between its corners.
  for(let y=0;y<=256;y+=32) for(let x=0;x<=256;x+=32){
    const p=cloudTileLocation(coords,x,y), weights=cloudSourceWeights(p.lat,p.lon);
    for(const id of Object.keys(weights)) if(weights[id]>0) ids.add(id);
  }
  return [...ids];
}
function cloudTileBbox(coords){
  const world=20037508.342789244, span=world*2/2**coords.z;
  const pad=span*CLOUD_PADDING/256;
  return [coords.x*span-world-pad,world-(coords.y+1)*span-pad,
    (coords.x+1)*span-world+pad,world-coords.y*span+pad].join(',');
}
function cloudAvailableTime(product,name,requested){
  const dimension=product.times?.[name];
  if(dimension?.length){
    let selected=null;
    for(const t of dimension) if(t<=requested && (selected===null || t>selected)) selected=t;
    // Do not borrow a future observation when replaying missing history.
    if(selected===null) throw new Error('No satellite observation at this time');
    return selected;
  }
  const latest=product.latest?.[name];
  if(!Number.isFinite(latest))throw new Error('Satellite observation timestamps unavailable');
  return Math.floor(Math.min(requested,latest)/product.cadence)*product.cadence;
}
function cloudTimeEntries(text){
  const times=[];
  for(const entry of text.split(',')){
    const parts=entry.trim().split('/');
    if(parts.length===1){const t=Date.parse(parts[0])/1000;if(Number.isFinite(t))times.push(t);}
    else{
      const start=Date.parse(parts[0])/1000,end=Date.parse(parts[1])/1000;
      const cadence=/PT(\d+)M/.exec(parts[2]||'');
      if(Number.isFinite(start)&&Number.isFinite(end)){
        const step=cadence?Number(cadence[1])*60:600;
        for(let t=Math.max(start,end-4*3600);t<=end;t+=step) times.push(t);
      }
    }
  }
  return times.filter(t=>t>=Date.now()/1000-5*3600).sort((a,b)=>a-b);
}
async function cloudFetch(url,type='text',timeout=12000){
  const session=cloudSession;
  let lastError;
  // Reuse the same CORS relay as national radar/station layers when direct access fails.
  for(const candidate of [url,'https://proxy.cors.dev/'+url]){
    const ctrl=new AbortController();cloudControllers.add(ctrl);
    const timer=setTimeout(()=>ctrl.abort(),timeout);
    try{
      const response=await fetch(candidate,{signal:ctrl.signal,cache:'default'});
      if(!response.ok)throw new Error('Satellite HTTP '+response.status);
      if(type==='blob'){
        const blob=await response.blob();
        if(!blob.type.startsWith('image/'))throw new Error('Satellite returned non-image data');
        return blob;
      }
      return await response.text();
    }catch(error){
      lastError=error;
      if(session!==cloudSession)throw error;
      if(error.message==='Satellite HTTP 429')throw error;
    }finally{clearTimeout(timer);cloudControllers.delete(ctrl);}
  }
  throw lastError;
}
function cloudViewportSources(){
  const z=Math.min(6,Math.round(map.getZoom())),bounds=map.getBounds();
  const nw=map.project(bounds.getNorthWest(),z).divideBy(256).floor();
  const se=map.project(bounds.getSouthEast(),z).divideBy(256).floor(),ids=new Set();
  for(let y=nw.y;y<=se.y;y++)for(let x=nw.x;x<=se.x;x++)cloudTileSources({z,x,y}).forEach(id=>ids.add(id));
  return [...ids];
}
async function cloudEnsureMetadata(force=false){
  await Promise.all(cloudViewportSources().map(async id=>{
    const product=cloudProducts[id];
    if(!force && product.retryAt>Date.now())return;
    if(!force && product.metadataAt && Date.now()-product.metadataAt<5*60000)return;
    if(product.metadataPromise)return product.metadataPromise;
    product.metadataPromise=(async()=>{
      try{
        const url=product.endpoint+'?'+new URLSearchParams({service:'WMS',request:'GetCapabilities',version:'1.3.0'});
        const xml=await cloudFetch(url);
        const doc=new DOMParser().parseFromString(xml,'text/xml');
        const latest={},times={};
        for(const layer of doc.getElementsByTagNameNS('*','Layer')){
          const name=[...layer.children].find(n=>n.localName==='Name')?.textContent;
          if(![product.day,product.night,'msg_fes:clm'].includes(name))continue;
          const dimension=[...layer.children].find(n=>['Dimension','Extent'].includes(n.localName)&&n.getAttribute('name')==='time');
          if(!dimension)continue;
          times[name]=cloudTimeEntries(dimension.textContent||'');
          const value=Date.parse(dimension.getAttribute('default'))/1000;
          latest[name]=Number.isFinite(value)?value:times[name].at(-1);
        }
        if(!latest[product.day] || !latest[product.night])throw new Error('Satellite timestamps unavailable');
        product.latest=latest;product.times=times;product.metadataAt=Date.now();
      }catch(e){product.retryAt=Date.now()+30000;console.warn('Satellite availability:',product.day,e.message);}
    })().finally(()=>{product.metadataPromise=null;});
    return product.metadataPromise;
  }));
}
function cloudMapUrl(product,name,time,coords,guide=false){
  const q=new URLSearchParams({service:'WMS',version:'1.1.1',request:'GetMap',
    layers:name,styles:'',format:'image/png',transparent:'true',srs:'EPSG:3857',
    bbox:cloudTileBbox(coords),width:String(cloudTileSide(coords)),height:String(cloudTileSide(coords)),
    time:new Date(time*1000).toISOString().replace('.000Z','Z')});
  if(guide)q.set('SLD_BODY',cloudGuideSld());
  return product.endpoint+'?'+q;
}
async function cloudImagePixels(url,size){
  const blob=await cloudFetch(url,'blob');
  let drawable,objectUrl;
  try{
    if(typeof createImageBitmap==='function')drawable=await createImageBitmap(blob);
    else{
      objectUrl=URL.createObjectURL(blob);drawable=new Image();drawable.decoding='async';
      await new Promise((resolve,reject)=>{drawable.onload=resolve;drawable.onerror=reject;drawable.src=objectUrl;});
    }
    const c=document.createElement('canvas');c.width=c.height=size;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(drawable,0,0,size,size);
    return ctx.getImageData(0,0,size,size).data;
  }finally{drawable?.close?.();if(objectUrl)URL.revokeObjectURL(objectUrl);}
}
function cloudModesForTile(coords,time,id){
  let day=false,night=false;
  for(let y=0;y<=256;y+=32)for(let x=0;x<=256;x+=32){
    const p=cloudTileLocation(coords,x,y);
    if(!cloudSourceWeights(p.lat,p.lon)[id])continue;
    const mix=cloudSolarMix(time,p.lat,p.lon).dayMix;
    day ||= mix>.001;night ||= mix<.999;
  }
  return {day,night};
}
async function cloudLoadSource(id,coords,time){
  const product=cloudProducts[id];
  const dayTime=cloudAvailableTime(product,product.day,time);
  const nightTime=cloudAvailableTime(product,product.night,time);
  const modes=cloudModesForTile(coords,Math.min(dayTime,nightTime),id);
  const tasks=[modes.day?cloudImagePixels(cloudMapUrl(product,product.day,dayTime,coords),cloudTileSide(coords)):Promise.resolve(null),
    modes.night?cloudImagePixels(cloudMapUrl(product,product.night,nightTime,coords),cloudTileSide(coords)):Promise.resolve(null)];
  if(id==='eumet'){
    const guideTime=cloudAvailableTime({...product,cadence:900},'msg_fes:clm',Math.min(dayTime,nightTime));
    tasks.push(cloudImagePixels(cloudMapUrl(product,'msg_fes:clm',guideTime,coords,true),cloudTileSide(coords)).catch(()=>null));
  }
  const [day,night,mask]=await Promise.all(tasks);
  return {id,day,night,mask,dayTime,nightTime};
}
let cloudWorker=null,cloudWorkerFailed=false,cloudWorkerSerial=0;
const cloudWorkerJobs=new Map();
function cloudStopWorker(){
  cloudWorker?.terminate();cloudWorker=null;
  for(const job of cloudWorkerJobs.values()){clearTimeout(job.timer);job.reject(new Error('Cloud processing cancelled'));}
  cloudWorkerJobs.clear();
}
function cloudGetWorker(){
  if(cloudWorkerFailed || typeof Worker!=='function')return null;
  if(cloudWorker)return cloudWorker;
  try{
    const worker=new Worker('js/cloud-worker.js?v=8.20');
    worker.onmessage=({data})=>{
      const job=cloudWorkerJobs.get(data.id);if(!job)return;
      clearTimeout(job.timer);cloudWorkerJobs.delete(data.id);
      if(data.error)job.reject(new Error(data.error));else job.resolve(data.pixels);
    };
    worker.onerror=()=>{cloudWorkerFailed=true;cloudStopWorker();};
    cloudWorker=worker;return worker;
  }catch(e){cloudWorkerFailed=true;return null;}
}
async function cloudProcessTile(coords,sources){
  const size=cloudTileResolution(coords),worker=cloudGetWorker();
  let pixels;
  if(worker){
    const id=++cloudWorkerSerial;
    try{
      // Transfer disposable arrays to avoid copying several images per tile.
      pixels=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{cloudWorkerFailed=true;cloudStopWorker();},15000);
        cloudWorkerJobs.set(id,{resolve,reject,timer});
        const transfer=sources.flatMap(s=>[s.day,s.night,s.mask].filter(Boolean).map(a=>a.buffer));
        try{worker.postMessage({id,coords,sources,size},transfer);}catch(e){
          cloudWorkerFailed=true;cloudStopWorker();
        }
      });
    }catch(e){
      // Transferred arrays cannot be reused; retry the tile through the fallback.
      throw e;
    }
  }else pixels=cloudProcessPixels(coords,sources,size);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d'),image=ctx.createImageData(size,size);
  image.data.set(pixels);ctx.putImageData(image,0,0);
  return {canvas,processor:worker?'worker':'main',times:sources.map(s=>({id:s.id,day:s.day?s.dayTime:null,night:s.night?s.nightTime:null}))};
}
function cloudPump(){
  cloudQueue.sort((a,b)=>a.priority-b.priority);
  while(cloudActiveJobs<CLOUD_CONCURRENCY && cloudQueue.length){
    const job=cloudQueue.shift();cloudActiveJobs++;
    Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{cloudActiveJobs--;cloudPump();});
  }
}
function cloudTileKey(coords,time){
  const ids=cloudTileSources(coords);
  const versions=ids.map(id=>{
    const p=cloudProducts[id];
    try{return id+':'+cloudAvailableTime(p,p.day,time)+':'+cloudAvailableTime(p,p.night,time);}
    catch(e){return id+':unavailable';}
  }).join('|');
  return `${coords.z}/${coords.x}/${coords.y}/${cloudTileResolution(coords)}/${versions}`;
}
function cloudGetTile(coords,time,priority=0){
  let key;
  try{key=cloudTileKey(coords,time);}catch(e){return Promise.reject(e);}
  if(cloudTileCache.get(key)?.partial && (cloudTileRetryAt.get(key)||0)<=Date.now())cloudTileCache.delete(key);
  if(cloudTileCache.has(key)){
    const hit=cloudTileCache.get(key);cloudTileCache.delete(key);cloudTileCache.set(key,hit);
    return Promise.resolve(hit);
  }
  if((cloudTileRetryAt.get(key)||0)>Date.now())return Promise.reject(new Error('Satellite tile retry deferred'));
  cloudTileRetryAt.delete(key);
  if(cloudTilePromises.has(key)){
    const queued=cloudQueue.find(j=>j.key===key);if(queued)queued.priority=Math.min(priority,queued.priority);
    return cloudTilePromises.get(key);
  }
  const session=cloudSession;
  const promise=new Promise((resolve,reject)=>{
    cloudQueue.push({key,priority,resolve,reject,work:async()=>{
      if(session!==cloudSession)throw new Error('Cloud loading cancelled');
      const ids=cloudTileSources(coords);
      const results=await Promise.allSettled(ids.map(id=>cloudLoadSource(id,coords,time)));
      if(session!==cloudSession)throw new Error('Cloud loading cancelled');
      let sources=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
      if(ids.length && !sources.length)throw new Error('Satellite tiles unavailable');
      let tile;
      try{tile=await cloudProcessTile(coords,sources);}catch(e){
        if(session!==cloudSession || !cloudWorkerFailed)throw e;
        // A worker startup failure gets one fresh download for the compatibility path.
        sources=await Promise.all(sources.map(s=>cloudLoadSource(s.id,coords,time)));
        tile=await cloudProcessTile(coords,sources);
      }
      tile.partial=sources.length<ids.length;
      if(tile.partial)cloudDeferTileRetry(key,120000);
      if(session===cloudSession){
        cloudTileCache.set(key,tile);
        while(cloudTileCache.size>CLOUD_TILE_CACHE_LIMIT || cloudCacheBytes()>CLOUD_CACHE_BYTES)cloudTileCache.delete(cloudTileCache.keys().next().value);
      }
      return tile;
    }});
    cloudPump();
  }).catch(error=>{if(session===cloudSession && !/cancelled/i.test(error.message))cloudDeferTileRetry(key);throw error;}).finally(()=>{if(cloudTilePromises.get(key)===promise)cloudTilePromises.delete(key);});
  cloudTilePromises.set(key,promise);return promise;
}
function cloudDeferTileRetry(key,delay=30000){
  cloudTileRetryAt.set(key,Date.now()+delay);
  while(cloudTileRetryAt.size>CLOUD_TILE_CACHE_LIMIT)cloudTileRetryAt.delete(cloudTileRetryAt.keys().next().value);
}
function cloudCancelQueued(keepKeys=null){
  for(const job of cloudQueue.splice(0)){
    if(keepKeys?.has(job.key)){cloudQueue.push(job);continue;}
    cloudTilePromises.delete(job.key);job.reject(new Error('Cloud loading cancelled'));
  }
}
function cloudVisibleTiles(layer=cloudLayer){
  if(!layer?._tiles)return [];
  return Object.values(layer._tiles).filter(t=>t.current && t.coords.z===layer._tileZoom);
}
const TransparentCloudTiles=L.GridLayer.extend({
  createTile(coords,done){
    const tile=document.createElement('canvas');tile.width=tile.height=256;
    tile.className='satellite-cloud-tile';tile.dataset.cloudTile=`${coords.z}/${coords.x}/${coords.y}`;
    const requested=this.displayTime,session=cloudSession;
    cloudGetTile(coords,requested).then(result=>{
      if(session===cloudSession && this._map && this.displayTime===requested){
        tile.getContext('2d').drawImage(result.canvas,0,0,256,256);tile._cloudImage=result.canvas;
        tile.dataset.cloudTime=String(requested);
        tile.dataset.cloudResolution=String(result.canvas.width);tile.dataset.cloudProcessor=result.processor;
      }
      done(null,tile);
    }).catch(()=>done(null,tile));
    return tile;
  }
});
function updateCloudBlendOpacity(){cloudLayer?.setOpacity(Number($('cloudOpacity').value)/100);}
function cloudStatus(text,kind=''){
  $('cloudStatus').textContent=text;$('cloudStatus').className='status'+(kind?' '+kind:'');
}
function cloudTimeDescription(results){
  const groups=new Map();
  for(const tile of results)for(const source of tile.times){
    const times=[source.day,source.night].filter(t=>t!==null);
    if(!groups.has(source.id))groups.set(source.id,new Set());
    times.forEach(t=>groups.get(source.id).add(t));
  }
  const labels={eumet:'Meteosat',noaa:'GOES US',gibs:'GOES northern Atlantic'};
  return [...groups].map(([id,times])=>{
    const sorted=[...times].sort((a,b)=>a-b);
    return labels[id]+' '+fmt(sorted[0])+(sorted.length>1?' – '+fmt(sorted.at(-1)):'');
  }).join(' · ');
}
async function cloudCrossfade(entries,generation){
  const old=entries.map(([tile])=>tile._cloudImage),start=performance.now();
  let lastPaint=-Infinity;
  await new Promise(resolve=>{
    function tick(now){
      if(generation!==cloudFrameGeneration || !$('cloudOn').checked){resolve();return;}
      const f=Math.min(1,(now-start)/320),mix=f*f*(3-2*f);
      if(f<1 && now-lastPaint<33){requestAnimationFrame(tick);return;}
      lastPaint=now;
      entries.forEach(([tile,result],i)=>{
        const ctx=tile.getContext('2d');ctx.clearRect(0,0,256,256);
        // Add premultiplied pixels, so the transition does not darken or thicken clouds.
        ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1-mix;
        if(old[i])ctx.drawImage(old[i],0,0,256,256);
        ctx.globalCompositeOperation='lighter';ctx.globalAlpha=mix;ctx.drawImage(result.canvas,0,0,256,256);
        ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      });
      if(f<1)requestAnimationFrame(tick);else resolve();
    }
    requestAnimationFrame(tick);
  });
}
async function drawCloud(frame,options={}){
  const generation=++cloudFrameGeneration;
  if(!$('cloudOn').checked || !frame){
    cloudRequestedTime=null;cloudSession++;cloudHistoryRequested=false;
    clearTimeout(cloudPrecacheTimer);cloudCancelQueued();cloudControllers.forEach(c=>c.abort());cloudTilePromises.clear();
    if(cloudLayer){map.removeLayer(cloudLayer);cloudLayer=null;}
    cloudTileCache.clear();cloudTileRetryAt.clear();cloudStopWorker();cloudStatus('Cloud layer is off.');return;
  }
  cloudRequestedTime=frame.time;
  // Dragging may visit many uncached times; preview only complete cached frames.
  if(options.cachedOnly && !cloudLayer)return;
  if(!options.readyOnly && !cloudLayer)cloudStatus('Loading satellite clouds…');
  await cloudEnsureMetadata();
  if(generation!==cloudFrameGeneration || !$('cloudOn').checked)return;
  if(!cloudLayer){
    cloudLayer=new TransparentCloudTiles({tileSize:256,maxNativeZoom:6,maxZoom:18,minZoom:2,
      bounds:CLOUD_BOUNDS,noWrap:true,keepBuffer:0,updateWhenIdle:true,pane:'overlayPane',
      opacity:Number($('cloudOpacity').value)/100,zIndex:1,
      attribution:'Clouds © EUMETSAT / NASA · NOAA GOES / NASA GIBS'});
    cloudLayer.displayTime=frame.time;cloudLayer.addTo(map);
  }
  const layer=cloudLayer,tiles=cloudVisibleTiles(layer),session=cloudSession;
  const ready=tiles.every(t=>{try{const key=cloudTileKey(t.coords,frame.time);return cloudTileCache.has(key)||(options.readyOnly && (cloudTileRetryAt.get(key)||0)>Date.now());}catch(e){return false;}});
  if(!ready && options.cachedOnly)return;
  if(!playing && !options.cachedOnly){
    const keepKeys=new Set(tiles.map(t=>{try{return cloudTileKey(t.coords,frame.time);}catch(e){return null;}}));
    cloudCancelQueued(keepKeys);
  }
  if(!ready && options.readyOnly){
    // Populate the cache without making playback wait for the network.
    Promise.allSettled(tiles.map(t=>cloudGetTile(t.coords,frame.time))).catch(()=>{});
    cloudStatus((layer.observationLabel||'No satellite observation loaded yet.')+' · Buffering; skipping unready frames','warn');
    scheduleCloudPrecache();return;
  }
  if(!ready)cloudStatus('Loading satellite clouds…');
  const results=await Promise.allSettled(tiles.map(t=>cloudGetTile(t.coords,frame.time)));
  if(generation!==cloudFrameGeneration || session!==cloudSession || layer!==cloudLayer)return;
  const successful=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  const failed=results.length-successful.length,partial=successful.some(r=>r.partial);
  if(!successful.length && tiles.length){
    cloudStatus('Satellite images unavailable. Previous clouds remain at their displayed observation time.','warn');return;
  }
  // An unavailable source must not freeze an entire Atlantic/Europe frame.
  // Clear missing tiles rather than presenting old imagery as the selected time.
  tiles.forEach((t,i)=>{if(results[i].status==='rejected'){t.el.getContext('2d').clearRect(0,0,256,256);t.el._cloudImage=null;delete t.el.dataset.cloudTime;}});
  const entries=tiles.flatMap((t,i)=>results[i].status==='fulfilled'?[[t.el,results[i].value]]:[]);
  const unchanged=entries.every(([tile,result])=>tile._cloudImage===result.canvas);
  if(!unchanged){
    if(options.scrub){
      // Direct manipulation follows the thumb, without a trailing 320 ms fade.
      for(const [tile,result] of entries){
        const ctx=tile.getContext('2d');ctx.clearRect(0,0,256,256);ctx.drawImage(result.canvas,0,0,256,256);
      }
    }else await cloudCrossfade(entries,generation);
  }
  if(generation!==cloudFrameGeneration || session!==cloudSession)return;
  entries.forEach(([tile,result])=>{tile._cloudImage=result.canvas;tile.dataset.cloudTime=String(frame.time);tile.dataset.cloudResolution=String(result.canvas.width);tile.dataset.cloudProcessor=result.processor;});
  layer.displayTime=frame.time;layer.hasCompleteFrame=!failed&&!partial;
  layer.observationLabel=cloudTimeDescription(successful);
  weatherFront();
  cloudStatus(layer.observationLabel?(failed||partial?'Partial cloud coverage · ':'')+layer.observationLabel:
    'Outside satellite coverage. No cloud imagery is available here.',failed||partial?'warn':'ok');
  scheduleCloudPrecache();
}
function requestCloudHistory(){cloudHistoryRequested=true;}
function cloudUpcomingFrames(){
  const tiles=cloudVisibleTiles(),i=Math.max(0,Math.min(frames.length-1,Number($('timeline').value)));
  // Keep current + buffered frames within the canvas cache budget.
  const capacity=cloudCacheCapacity(tiles);
  // Only two neighbouring frames compete with the selected observation.
  // Completed frames remain in the LRU cache for subsequent loops.
  const count=Math.min(2,Math.max(0,capacity-1),Math.max(0,frames.length-1));
  return Array.from({length:count},(_,n)=>{
    const offset=playing?n+1:(n%2===0?1:-1)*Math.ceil((n+1)/2);
    return frames[(i+offset+frames.length)%frames.length];
  });
}
function cloudBufferUpcoming(){
  const tiles=cloudVisibleTiles();
  return Promise.allSettled(cloudUpcomingFrames().flatMap((frame,i)=>
    tiles.map(t=>cloudGetTile(t.coords,frame.time,i+1))));
}
function scheduleCloudPrecache(){
  clearTimeout(cloudPrecacheTimer);
  if(!cloudHistoryRequested || !$('cloudOn').checked || !cloudLayer)return;
  const session=cloudSession;
  cloudPrecacheTimer=setTimeout(()=>{
    if(session!==cloudSession)return;
    // Buffer a small rolling window, never the entire two-hour history.
    cloudBufferUpcoming().catch(()=>{});
  },100);
}
map.on('movestart zoomstart',()=>{
  if(cloudLayer){
    cloudFrameGeneration++;cloudSession++;clearTimeout(cloudPrecacheTimer);
    cloudCancelQueued();cloudControllers.forEach(c=>c.abort());cloudTilePromises.clear();cloudStopWorker();
  }
});
map.on('moveend zoomend',()=>{
  if($('cloudOn').checked && cloudRequestedTime!==null){
    // GridLayer handles newly visible tiles; render the selected frame after it updates.
    setTimeout(()=>drawCloud({time:cloudRequestedTime}).catch(console.error),0);
  }
});
