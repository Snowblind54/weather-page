// Prefer centrally extracted cloud imagery; preserve direct-provider fallback.
(() => {
 const nativeMetadata=cloudEnsureMetadata,nativeTile=cloudGetTile,nativeKey=cloudTileKey;
 let manifest=null,checkedAt=0,pending=null;
 const images=new Map(),downloads=new Map();
 const mobile=typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches;
 const imageBudget=mobile?8*1024*1024:24*1024*1024;
 async function refresh(force=false){
  if(pending)return pending;if(!force&&Date.now()-checkedAt<60000)return;
  pending=(async()=>{
   try{
    const r=await fetch('data/cloud-tiles.json',{cache:'default'});
    if(!r.ok)throw Error('Prepared clouds unavailable');const next=await r.json();
    if(next.version!==1||!Array.isArray(next.records))throw Error('Invalid cloud manifest');
    manifest=next;
   }catch{ /* Keep the last successful published manifest. */ }
   finally{checkedAt=Date.now();pending=null;}
  })();return pending;
 }
 function selection(coords,time){
  if(!manifest)return null;
  const z=Math.min(4,coords.z),factor=2**(coords.z-z);
  const key=`${z}/${Math.floor(coords.x/factor)}/${Math.floor(coords.y/factor)}`;
  const r=manifest.records.filter(r=>r.key===key&&r.time<=time).sort((a,b)=>b.time-a.time)[0];
  if(!r)return null;
  const index=Math.min(r.paths.length-1,Math.max(0,coords.z-z));
  if(!/^data\/cloud-tiles\/[a-f0-9]+-(256|512|1024)\.webp$/.test(r.paths[index]))return null;
  return {r,path:r.paths[index],factor,x:coords.x%factor,y:coords.y%factor};
 }
 async function imageFor(path){
  if(images.has(path)){const hit=images.get(path);images.delete(path);images.set(path,hit);return hit;}
  if(downloads.has(path))return downloads.get(path);
  const session=cloudSession,ctrl=new AbortController();cloudControllers.add(ctrl);
  const timer=setTimeout(()=>ctrl.abort(),15000);
  const p=(async()=>{
   const r=await fetch(path,{signal:ctrl.signal});if(!r.ok)throw Error('Cloud tile HTTP '+r.status);
   const blob=await r.blob();let drawable,url;
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
  const visible=cloudVisibleTiles();
  if(visible.length&&visible.every(t=>selection(t.coords,cloudRequestedTime)))return;
  // Initial GridLayer has not been created yet. Published metadata also makes
  // fallback keys valid without downloading capabilities on every phone.
  if(manifest?.products){
   for(const [id,p] of Object.entries(manifest.products))if(cloudProducts[id]){
    cloudProducts[id].times=p.times;cloudProducts[id].latest=p.latest;cloudProducts[id].metadataAt=Date.now();
   }
  }
  return nativeMetadata(force);
 };
 cloudTileKey=function(coords,time){const s=selection(coords,time);return s?'prepared-cloud:'+s.path+':'+coords.z+'/'+coords.x+'/'+coords.y:nativeKey(coords,time);};
 cloudGetTile=function(coords,time,priority=0){
  const s=selection(coords,time);if(!s)return nativeTile(coords,time,priority);
  const key=cloudTileKey(coords,time);
  if(cloudTileCache.has(key))return Promise.resolve(cloudTileCache.get(key));
  if(cloudTilePromises.has(key))return cloudTilePromises.get(key);
  const session=cloudSession;
  const p=imageFor(s.path).then(source=>{
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
