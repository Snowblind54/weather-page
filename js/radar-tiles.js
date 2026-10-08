// Prepared official radar trial. Only visible lossless tiles are downloaded;
// native feeds remain the fallback and retain full detail above zoom 7.
let preparedRadarManifest=null;
const preparedRadarFrames=new Map(),preparedRadarPending=new Map();
const preparedRadarTileQueue=[],preparedRadarTileJobs=new Map();let preparedRadarTileActive=0;
function runPreparedRadarTileQueue(){
  preparedRadarTileQueue.sort((a,b)=>Number(a.background)-Number(b.background));
  while(preparedRadarTileActive<4&&preparedRadarTileQueue.length){
    if(preparedRadarTileQueue[0].background&&preparedRadarTileActive)break;
    const job=preparedRadarTileQueue.shift();
    if(!job.allowed()){preparedRadarTileJobs.delete(job.url);job.reject(new Error('Obsolete radar buffering'));continue;}
    preparedRadarTileActive++;
    loadRadarNativeImage(job.url).then(job.resolve,job.reject).finally(()=>{preparedRadarTileJobs.delete(job.url);preparedRadarTileActive--;runPreparedRadarTileQueue();});
  }
}
function loadPreparedRadarTile(url,background,allowed){
  const existing=preparedRadarTileJobs.get(url);
  if(existing){if(!background){existing.background=false;existing.allowed=()=>true;runPreparedRadarTileQueue();}return existing.promise;}
  const job={url,background,allowed};job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
  preparedRadarTileJobs.set(url,job);preparedRadarTileQueue.push(job);runPreparedRadarTileQueue();return job.promise;
}
function validPreparedRadarFrame(frame){
  return ['ee','fi','se','no','dk','is','lt','lv'].includes(frame.source)&&
    ['ee','fi','se','no','dk','iskef','isska','isx2','lt','lv'].includes(frame.station)&&
    Number.isSafeInteger(frame.time)&&/^data\/radar-tiles\/(ee|fi|se|no|dk|iskef|isska|isx2|lt|lv)-\d+-[a-f0-9]{12}$/.test(frame.path)&&
    frame.path.split('/').at(-1).startsWith(frame.station+'-'+frame.time+'-')&&
    frame.bounds?.length===2&&frame.bounds.every(p=>p.length===2&&p.every(Number.isFinite))&&
    frame.bounds[0][0]>=-85.051129&&frame.bounds[1][0]<=85.051129&&frame.bounds[0][1]>=-180&&frame.bounds[1][1]<=180&&
    frame.bounds[0][0]<frame.bounds[1][0]&&frame.bounds[0][1]<frame.bounds[1][1]&&frame.min_zoom===3&&frame.max_zoom===7&&
    frame.tiles&&Object.entries(frame.tiles).every(([z,list])=>Number(z)>=3&&Number(z)<=7&&Array.isArray(list)&&list.length<=4096&&list.every(v=>/^\d+\/\d+$/.test(v)&&v.split('/').every(n=>Number(n)<2**Number(z))));
}
async function loadPreparedRadarManifest(){
  if(!preparedRadarManifest||Date.now()-preparedRadarManifest.at>60000){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
    const promise=fetch('data/radar-tiles.json?v='+Math.floor(Date.now()/60000),{cache:'no-cache',signal:controller.signal})
      .then(r=>{if(!r.ok)throw new Error('Prepared radar archive unavailable');return r.json();})
      .then(data=>{if(data.version!==1||!Array.isArray(data.frames))throw new Error('Invalid prepared radar archive');return data.frames.filter(validPreparedRadarFrame);})
      .finally(()=>clearTimeout(timer));
    preparedRadarManifest={at:Date.now(),promise};
  }
  return preparedRadarManifest.promise;
}
function preparedRadarWorld(lon,lat,z){
  const size=256*2**z;lat=Math.max(-85.05112878,Math.min(85.05112878,lat));
  return [(lon+180)/360*size,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*size];
}
function preparedRadarLat(y,z){return Math.atan(Math.sinh(Math.PI*(1-2*y/(256*2**z))))*180/Math.PI;}
function preparedRadarPlan(record,z){
  const view=map.getBounds(),[[south,west],[north,east]]=record.bounds;
  const low=Math.max(south,view.getSouth()),high=Math.min(north,view.getNorth());
  const left=Math.max(west,view.getWest()),right=Math.min(east,view.getEast());
  if(low>=high||left>=right)return null;
  const a=preparedRadarWorld(left,high,z),b=preparedRadarWorld(right,low,z),limit=2**z;
  const x0=Math.max(0,Math.floor(a[0]/256)),y0=Math.max(0,Math.floor(a[1]/256));
  const x1=Math.min(limit,Math.ceil(b[0]/256)),y1=Math.min(limit,Math.ceil(b[1]/256));
  if((x1-x0)*(y1-y0)>160)throw new Error('Prepared radar view exceeds tile budget');
  const published=new Set(record.tiles[z]||[]),tiles=[];
  for(let x=x0;x<x1;x++)for(let y=y0;y<y1;y++)if(published.has(x+'/'+y))tiles.push({x,y,url:record.path+'/'+z+'/'+x+'/'+y+'.png'});
  return {x0,y0,x1,y1,tiles,bounds:[[preparedRadarLat(y1*256,z),x0/limit*360-180],[preparedRadarLat(y0*256,z),x1/limit*360-180]]};
}
function cachePreparedRadarFrame(key,frame){
  preparedRadarFrames.delete(key);preparedRadarFrames.set(key,frame);
  const limit=(typeof radarLightMode==='function'&&radarLightMode()?20:40)*1024*1024;
  let total=[...preparedRadarFrames.values()].reduce((n,f)=>n+f.canvas.width*f.canvas.height*4,0);
  while(preparedRadarFrames.size>36||total>limit){const oldest=preparedRadarFrames.keys().next().value,f=preparedRadarFrames.get(oldest);total-=f.canvas.width*f.canvas.height*4;preparedRadarFrames.delete(oldest);}
}
async function preparedRadarFrame(source,unix,{background=false,canPrepare=()=>true}={}){
  if(source==='is'||map.getZoom()<3||map.getZoom()>7||!canPrepare())return null;
  try{
    const records=(await loadPreparedRadarManifest()).filter(r=>r.source===source&&r.time<=unix&&unix-r.time<=900);
    if(!records.length||!canPrepare())return null;
    const record=records.sort((a,b)=>b.time-a.time)[0],z=Math.max(3,Math.min(7,Math.floor(map.getZoom()))),plan=preparedRadarPlan(record,z);
    if(!plan)return null;
    const key=[record.path,z,plan.x0,plan.y0,plan.x1,plan.y1].join('|');
    if(preparedRadarFrames.has(key)){const frame=preparedRadarFrames.get(key);cachePreparedRadarFrame(key,frame);return frame;}
    if(preparedRadarPending.has(key)){
      const pending=preparedRadarPending.get(key);
      if(!background){pending.foreground=true;for(const job of preparedRadarTileJobs.values())if(job.url.startsWith(record.path+'/')){job.background=false;job.allowed=()=>true;}runPreparedRadarTileQueue();}
      return pending.promise;
    }
    const pending={foreground:!background};
    const allowed=()=>pending.foreground||canPrepare();
    const promise=(async()=>{
      const started=performance.now(),canvas=document.createElement('canvas');
      canvas.width=(plan.x1-plan.x0)*256;canvas.height=(plan.y1-plan.y0)*256;
      const context=canvas.getContext('2d');let next=0;
      await Promise.all(Array.from({length:Math.min(4,plan.tiles.length)},async()=>{
        while(next<plan.tiles.length){if(!allowed())throw new Error('Obsolete radar buffering');const tile=plan.tiles[next++],image=await loadPreparedRadarTile(tile.url,!pending.foreground,allowed);context.drawImage(image,(tile.x-plan.x0)*256,(tile.y-plan.y0)*256);}
      }));
      const frame={canvas,bounds:plan.bounds,coverage:{bounds:record.bounds},url:key,time:record.time,station:record.station,prepared:true,tileCount:plan.tiles.length,loadMs:Math.round(performance.now()-started)};
      canvas.dataset.radarTiles=String(frame.tileCount);canvas.dataset.radarLoadMs=String(frame.loadMs);canvas.dataset.radarSource=source;
      cachePreparedRadarFrame(key,frame);return frame;
    })().finally(()=>preparedRadarPending.delete(key));
    pending.promise=promise;preparedRadarPending.set(key,pending);return await promise;
  }catch(error){console.warn('Prepared '+source+' radar unavailable; using native feed',error);return null;}
}
function preparedRadarCanvasLayer(frame,opacity=.84){
  const Layer=L.Layer.extend({
    onAdd(map){this._map=map;this._canvas=frame.canvas;this._canvas.className='leaflet-image-layer';Object.assign(this._canvas.style,{position:'absolute',pointerEvents:'none',opacity:String(opacity)});map.getPane('overlayPane').appendChild(this._canvas);map.on('zoom viewreset moveend',this._reset,this);this._reset();},
    onRemove(map){map.off('zoom viewreset moveend',this._reset,this);this._canvas.remove();},
    _reset(){const bounds=L.latLngBounds(frame.bounds),top=this._map.latLngToLayerPoint(bounds.getNorthWest()),bottom=this._map.latLngToLayerPoint(bounds.getSouthEast());L.DomUtil.setPosition(this._canvas,top);this._canvas.style.width=(bottom.x-top.x)+'px';this._canvas.style.height=(bottom.y-top.y)+'px';},
    getBounds(){return L.latLngBounds(frame.bounds);},getElement(){return this._canvas;},
    setOpacity(value){this._canvas.style.opacity=String(value);return this;},
    bringToFront(){this._canvas.parentNode?.appendChild(this._canvas);return this;}
  });return new Layer();
}
