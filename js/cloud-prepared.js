// Prefer centrally extracted cloud imagery; preserve direct-provider fallback.
(() => {
 if(typeof document!=='undefined'&&typeof document.title==='string')
  document.title=document.title.replace(/Northern Weather Map v8\.\d+\b/,'Northern Weather Map v8.140');
 const nativeMetadata=cloudEnsureMetadata,nativeTile=cloudGetTile,nativeKey=cloudTileKey;
 let manifest=null,checkedAt=0,pending=null;
 const images=new Map(),downloads=new Map();
 const mobile=typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches;
 const imageBudget=mobile?8*1024*1024:24*1024*1024;
 async function refresh(force=false){
  if(pending)return pending;if(!force&&Date.now()-checkedAt<60000)return;
  pending=(async()=>{
   try{
    // One shared URL per minute also handles CDNs with a longer browser TTL.
    const r=await fetch('data/cloud-tiles.json?minute='+Math.floor(Date.now()/60000),{cache:'default'});
    if(!r.ok)throw Error('Prepared clouds unavailable');const next=await r.json();
    if(next.version!==1||!Array.isArray(next.records))throw Error('Invalid cloud manifest');
    manifest=next;
   }catch{ /* Keep the last successful published manifest. */ }
   finally{checkedAt=Date.now();pending=null;}
  })();return pending;
 }
 function latestTimelineTime(){
  if(typeof frames==='undefined'||!Array.isArray(frames)||!frames.length)return null;
  const frame=frames[frames.length-1];
  const value=Number((typeof cloudTimelineFrame==='function'?cloudTimelineFrame(frame):frame)?.time);
  return Number.isFinite(value)?value:null;
 }
 // Prepared GOES may arrive later; reject genuinely stale archives.
 // GIBS can arrive later; polar composites deliberately remain valid between orbits.
 function maxAge(id){return id==='gibs'||id==='west'?3*3600:45*60;}
 function observationsFresh(times,requested){
  if(!Array.isArray(times)||!times.length)return false;
  const scans=(times||[]).filter(s=>s.id!=='metop');
  return scans.every(s=>{
   const stamp=Math.max(...[s.day,s.night].filter(Number.isFinite));
   return Number.isFinite(stamp)&&requested-stamp<=maxAge(s.id);
  });
 }
 function blockKey(coords){
  const z=Math.min(4,coords.z),factor=2**(coords.z-z);
  return `${z}/${Math.floor(coords.x/factor)}/${Math.floor(coords.y/factor)}`;
 }
 // Satellite-only playback follows the images actually published for this view.
 // Direct providers can advertise a newer scan before the central job finishes.
 if(typeof cloudTimelineEnd==='function'){
  const directTimelineEnd=cloudTimelineEnd;
  cloudTimelineEnd=function(){
   const direct=directTimelineEnd();
   if(!Number.isFinite(direct)||!manifest)return direct;
   const tiles=cloudVisibleTiles();if(!tiles.length)return direct;
   const ends=[];
   for(const tile of tiles){
    const rows=manifest.records.filter(r=>r.key===blockKey(tile.coords)).sort((a,b)=>b.time-a.time);
    const latest=rows[0];
    if(!latest||!observationsFresh(latest.times,Date.now()/1000))return direct;
    const scans=(latest.times||[]).filter(s=>s.id!=='metop');
    if(scans.length)ends.push(latest.time);
   }
   return ends.length?Math.max(...ends):direct;
  };
 }
 function selection(coords,time){
  if(!manifest)return null;
  const z=Math.min(4,coords.z),factor=2**(coords.z-z);
  const key=`${z}/${Math.floor(coords.x/factor)}/${Math.floor(coords.y/factor)}`;
  const candidates=manifest.records.filter(r=>r.key===key);
  const latest=latestTimelineTime();
  // The shared timeline is normally keyed to radar observations. At its Latest
  // position the newest satellite scan can legitimately be several minutes
  // newer than that radar timestamp. Use each tile's newest satellite record
  // there, otherwise Canadian GOES blocks disappear in a checkerboard pattern.
  // Historical positions remain strict and never borrow imagery from the future.
  const aligned=typeof cloudTimelineEnd==='function'&&Number.isFinite(cloudTimelineEnd());
  const eligible=!aligned&&Number.isFinite(latest)&&Math.abs(Number(time)-latest)<1
    ?candidates:candidates.filter(r=>r.time<=time);
  const r=eligible.sort((a,b)=>b.time-a.time)[0];
  if(!r)return null;
  const requested=Number.isFinite(latest)&&Math.abs(Number(time)-latest)<1
    ?Math.max(Number(time),Date.now()/1000):Number(time);
  if(!observationsFresh(r.times,requested))return null;
  const index=Math.min(r.paths.length-1,Math.max(0,coords.z-z));
  if(!/^data\/cloud-tiles\/[a-f0-9]+-(256|512|1024)\.webp$/.test(r.paths[index]))return null;
  if(r.archive&&(typeof validCloudArchive!=='function'||!validCloudArchive(r)))return null;
  return {r,path:r.paths[index],factor,x:coords.x%factor,y:coords.y%factor};
 }
 async function imageFor(path,record){
  if(images.has(path)){const hit=images.get(path);images.delete(path);images.set(path,hit);return hit;}
  if(downloads.has(path))return downloads.get(path);
  const session=cloudSession,ctrl=new AbortController();cloudControllers.add(ctrl);
  const timer=setTimeout(()=>ctrl.abort(),15000);
  const p=(async()=>{
   let blob;
   if(record.archive)blob=await cloudArchiveBlob(record,path);
   else {const r=await fetch(path,{signal:ctrl.signal});if(!r.ok)throw Error('Cloud tile HTTP '+r.status);blob=await r.blob();}
   let drawable,url;
   try{
    if(typeof createImageBitmap==='function')drawable=await createImageBitmap(blob);
    else {url=URL.createObjectURL(blob);drawable=new Image();await new Promise((resolve,reject)=>{drawable.onload=resolve;drawable.onerror=reject;drawable.src=url;});}
    if(session!==cloudSession)throw Error('Cloud loading cancelled');
    const canvas=document.createElement('canvas');canvas.width=drawable.width||drawable.naturalWidth;canvas.height=drawable.height||drawable.naturalHeight;
    if(![256,512,1024].includes(canvas.width)||canvas.width!==canvas.height)throw Error('Invalid cloud block dimensions');
    canvas.getContext('2d').drawImage(drawable,0,0);
    images.set(path,canvas);
    while([...images.values()].reduce((n,c)=>n+c.width*c.height*4,0)>imageBudget)images.delete(images.keys().next().value);
    return canvas;
   }finally{drawable?.close?.();if(url)URL.revokeObjectURL(url);}
  })().finally(()=>{clearTimeout(timer);cloudControllers.delete(ctrl);downloads.delete(path);});
  downloads.set(path,p);return p;
 }
 cloudEnsureMetadata=async function(force=false){
  await refresh(force);
  // Seed metadata for archive-only loading, without overwriting a newer direct discovery.
  if(manifest?.products){
   for(const [id,p] of Object.entries(manifest.products))if(cloudProducts[id]&&
     (id==='metop'||observationsFresh([{id,day:Math.max(...Object.values(p.latest||{}))}],Date.now()/1000))){
    const current=cloudProducts[id];
    if(!current.metadataAt||Math.max(...Object.values(p.latest||{}))>Math.max(...Object.values(current.latest||{}))){
     current.times=p.times;current.latest=p.latest;current.metadataAt=Date.now();
    }
   }
  }
  // Refresh the manifest on automatic checks, but use direct providers only
  // when prepared coverage is missing. Keep already displayed clouds in place.
  const visible=cloudVisibleTiles();
  if(manifest?.records.length&&(visible.length?visible.every(t=>selection(t.coords,cloudRequestedTime)):manifest.products&&Object.keys(manifest.products).length))return;
  return nativeMetadata(force||!visible.length);
 };
 cloudTileKey=function(coords,time){const s=selection(coords,time);return s?'prepared-cloud:'+s.path+':'+coords.z+'/'+coords.x+'/'+coords.y:nativeKey(coords,time);};
 cloudGetTile=function(coords,time,priority=0){
  const s=selection(coords,time);if(!s)return nativeTile(coords,time,priority);
  const key=cloudTileKey(coords,time);
  if(cloudTileCache.has(key))return Promise.resolve(cloudTileCache.get(key));
  if(cloudTilePromises.has(key))return cloudTilePromises.get(key);
  const session=cloudSession;
  const p=imageFor(s.path,s.r).then(source=>{
   if(session!==cloudSession)throw Error('Cloud loading cancelled');
   const size=cloudTileResolution(coords),canvas=document.createElement('canvas');canvas.width=canvas.height=size;
   const span=source.width/s.factor;
   canvas.getContext('2d').drawImage(source,s.x*span,s.y*span,span,span,0,0,size,size);
   const result={canvas,processor:'cdn',times:s.r.times,partial:false};
   cloudTileCache.set(key,result);
   const budget=mobile?16*1024*1024:CLOUD_CACHE_BYTES;
   while(cloudTileCache.size>CLOUD_TILE_CACHE_LIMIT||cloudCacheBytes()>budget)cloudTileCache.delete(cloudTileCache.keys().next().value);
   return result;
  }).catch(e=>{if(session!==cloudSession)throw e;cloudTilePromises.delete(key);return nativeTile(coords,time,priority);})
   .finally(()=>{if(cloudTilePromises.get(key)===p)cloudTilePromises.delete(key);});
  cloudTilePromises.set(key,p);return p;
 };
 map.on('movestart zoomstart',()=>{images.clear();});
 $('cloudOn').addEventListener('change',()=>{if(!$('cloudOn').checked)images.clear();});
})();
