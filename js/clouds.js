// Transparent satellite tiles. Only the visible viewport is requested.
const CLOUD_TILE_SIZE=256, CLOUD_PADDING=8, CLOUD_SIDE=272;
const CLOUD_TILE_CACHE_LIMIT=128, CLOUD_CONCURRENCY=4;
const CLOUD_EUMET='https://view.eumetsat.int/geoserver/wms';
const CLOUD_NOAA='https://nowcoast.noaa.gov/geoserver/observations/satellite/ows';
const CLOUD_GIBS='https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const cloudTileCache=new Map(), cloudTilePromises=new Map();
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

const cloudSolarPositions=new Map();
function solarElevationDegrees(unix,lat=57.1,lon=24.9){
  if(cloudSolarPositions.has(unix)){
    const {dec,angle}=cloudSolarPositions.get(unix),phi=lat*Math.PI/180;
    return Math.asin(Math.sin(phi)*Math.sin(dec)+Math.cos(phi)*Math.cos(dec)*Math.cos((angle+lon)*Math.PI/180))*180/Math.PI;
  }
  const rad=Math.PI/180;
  const deg=180/Math.PI;
  const jd=unix/86400 + 2440587.5;
  const n=jd-2451545.0;

  let L=(280.460 + 0.9856474*n)%360;
  if(L<0) L+=360;
  let g=(357.528 + 0.9856003*n)%360;
  if(g<0) g+=360;

  const lambda=(L + 1.915*Math.sin(g*rad) + 0.020*Math.sin(2*g*rad))*rad;
  const epsilon=(23.439 - 0.0000004*n)*rad;

  const ra=Math.atan2(Math.cos(epsilon)*Math.sin(lambda),Math.cos(lambda))*deg;
  const dec=Math.asin(Math.sin(epsilon)*Math.sin(lambda));

  let gmst=(18.697374558 + 24.06570982441908*n)%24;
  if(gmst<0) gmst+=24;

  const angle=gmst*15-ra;
  cloudSolarPositions.set(unix,{dec,angle});
  if(cloudSolarPositions.size>64)cloudSolarPositions.delete(cloudSolarPositions.keys().next().value);
  let H=angle+lon;
  H=((H+180)%360+360)%360-180;
  H*=rad;

  const phi=lat*rad;
  const elev=Math.asin(
    Math.sin(phi)*Math.sin(dec) +
    Math.cos(phi)*Math.cos(dec)*Math.cos(H)
  );

  return elev*deg;
}

function smoothstep(a,b,x){
  if(a===b) return x<a?0:1;
  let t=(x-a)/(b-a);
  t=Math.max(0,Math.min(1,t));
  return t*t*(3-2*t);
}

function blurAlpha(src,w,h,radius=5){
  if(radius<=0) return src;
  const tmp=new Float32Array(src.length);
  const out=new Float32Array(src.length);
  const size=radius*2+1;

  for(let y=0;y<h;y++){
    let sum=0;
    const row=y*w;
    for(let k=-radius;k<=radius;k++) sum+=src[row+Math.max(0,Math.min(w-1,k))];
    for(let x=0;x<w;x++){
      tmp[row+x]=sum/size;
      const oldX=Math.max(0,x-radius);
      const newX=Math.min(w-1,x+radius+1);
      sum+=src[row+newX]-src[row+oldX];
    }
  }

  for(let x=0;x<w;x++){
    let sum=0;
    for(let k=-radius;k<=radius;k++) sum+=tmp[Math.max(0,Math.min(h-1,k))*w+x];
    for(let y=0;y<h;y++){
      out[y*w+x]=sum/size;
      const oldY=Math.max(0,y-radius);
      const newY=Math.min(h-1,y+radius+1);
      sum+=tmp[newY*w+x]-tmp[oldY*w+x];
    }
  }
  return out;
}

function visualCloudScore(r,g,b){
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  const chroma=max-min;
  const lum=0.2126*r+0.7152*g+0.0722*b;
  const bright=smoothstep(62,205,lum);
  const neutral=1-smoothstep(22,105,chroma);
  return Math.max(0,Math.min(1,bright*(0.58+0.42*neutral)));
}


// NASA GIBS Band 13 palette converted to cold-cloud luminance (official colour map).
const CLOUD_GOES_IR_PALETTE=[[255,255,255,255],[127,0,127,255],[140,13,135,255],[153,25,142,255],[165,38,150,255],[178,51,157,255],[191,64,165,255],[204,76,173,255],[217,89,180,255],[229,102,188,255],[242,114,195,255],[255,127,203,255],[230,230,230,254],[204,204,204,252],[177,177,177,250],[155,155,155,247],[129,129,129,245],[102,102,102,243],[76,76,76,241],[54,54,54,239],[27,27,27,236],[5,5,5,234],[26,0,0,232],[51,0,0,230],[77,0,0,228],[102,0,0,225],[128,0,0,223],[153,0,0,221],[179,0,0,219],[204,0,0,216],[230,0,0,214],[255,0,0,212],[255,26,0,210],[255,51,0,208],[255,77,0,205],[255,102,0,203],[255,128,0,201],[255,153,0,199],[255,179,0,196],[255,204,0,194],[255,230,0,192],[255,255,0,190],[230,255,0,188],[204,255,0,185],[179,255,0,183],[153,255,0,181],[128,255,0,179],[102,255,0,177],[77,255,0,174],[51,255,0,172],[26,255,0,170],[0,255,0,168],[0,234,10,165],[0,212,19,163],[0,191,29,161],[0,170,38,159],[0,149,48,157],[0,128,58,154],[0,106,67,152],[0,85,77,150],[0,64,86,148],[0,42,96,146],[0,21,105,145],[0,0,115,144],[0,0,125,143],[0,13,122,142],[0,26,129,140],[0,38,136,139],[0,51,143,138],[0,64,150,137],[0,76,157,136],[0,89,164,135],[0,102,171,134],[0,115,178,133],[0,128,185,132],[0,140,192,130],[0,153,199,129],[0,166,206,128],[0,178,213,127],[0,191,220,126],[0,204,227,125],[0,217,234,124],[0,230,241,123],[0,242,248,122],[0,255,255,121],[197,197,197,119],[196,196,196,118],[194,194,194,117],[193,193,193,116],[192,192,192,115],[191,191,191,114],[189,189,189,113],[188,188,188,112],[187,187,187,111],[185,185,185,109],[184,184,184,108],[183,183,183,107],[181,181,181,106],[180,180,180,105],[179,179,179,104],[178,178,178,103],[176,176,176,102],[175,175,175,101],[174,174,174,99],[172,172,172,98],[171,171,171,97],[170,170,170,96],[169,169,169,95],[167,167,167,94],[166,166,166,93],[165,165,165,92],[163,163,163,91],[162,162,162,89],[161,161,161,88],[159,159,159,87],[158,158,158,86],[157,157,157,85],[156,156,156,84],[154,154,154,83],[153,153,153,82],[152,152,152,81],[150,150,150,79],[149,149,149,78],[148,148,148,77],[147,147,147,76],[145,145,145,75],[144,144,144,74],[143,143,143,73],[141,141,141,72],[140,140,140,71],[139,139,139,70],[138,138,138,68],[136,136,136,67],[135,135,135,66],[134,134,134,65],[132,132,132,64],[131,131,131,63],[130,130,130,62],[128,128,128,61],[127,127,127,60],[126,126,126,58],[125,125,125,57],[123,123,123,56],[122,122,122,55],[121,121,121,54],[119,119,119,53],[118,118,118,52],[117,117,117,51],[116,116,116,50],[114,114,114,48],[113,113,113,47],[112,112,112,46],[110,110,110,45],[109,109,109,44],[108,108,108,43],[106,106,106,42],[105,105,105,41],[104,104,104,40],[103,103,103,38],[101,101,101,37],[100,100,100,36],[99,99,99,35],[97,97,97,34],[96,96,96,33],[95,95,95,32],[94,94,94,31],[92,92,92,30],[91,91,91,28],[90,90,90,27],[88,88,88,26],[87,87,87,25],[86,86,86,24],[84,84,84,23],[83,83,83,22],[82,82,82,21],[81,81,81,20],[79,79,79,19],[78,78,78,17],[77,77,77,16],[75,75,75,15],[74,74,74,14],[73,73,73,13],[72,72,72,12],[70,70,70,11],[69,69,69,10],[68,68,68,9],[66,66,66,7],[65,65,65,6],[64,64,64,5],[62,62,62,4],[61,61,61,3],[60,60,60,2],[59,59,59,1],[57,57,57,0],[56,56,56,0],[55,55,55,0],[53,53,53,0],[52,52,52,0],[51,51,51,0],[50,50,50,0],[48,48,48,0],[47,47,47,0],[46,46,46,0],[44,44,44,0],[43,43,43,0],[42,42,42,0],[41,41,41,0],[39,39,39,0],[38,38,38,0],[37,37,37,0],[35,35,35,0],[34,34,34,0],[33,33,33,0],[31,31,31,0],[30,30,30,0],[29,29,29,0],[28,28,28,0],[26,26,26,0],[25,25,25,0],[24,24,24,0],[22,22,22,0],[21,21,21,0],[20,20,20,0],[19,19,19,0],[17,17,17,0],[16,16,16,0],[15,15,15,0],[13,13,13,0],[12,12,12,0],[11,11,11,0],[9,9,9,0],[8,8,8,0],[7,7,7,0],[6,6,6,0],[4,4,4,0],[3,3,3,0],[2,2,2,0],[1,1,1,0]];
const cloudIRColours=new Map();
function cloudInfraredLuminance(r,g,b){
  const key=(r>>3)*1024+(g>>3)*32+(b>>3);
  if(cloudIRColours.has(key)) return cloudIRColours.get(key);
  let distance=Infinity, lum=0;
  for(const c of CLOUD_GOES_IR_PALETTE){
    const d=(r-c[0])**2+(g-c[1])**2+(b-c[2])**2;
    if(d<distance){distance=d;lum=c[3];}
  }
  cloudIRColours.set(key,lum);
  return lum;
}
function cloudSolarMix(unix,lat,lon){
  const elevation=solarElevationDegrees(unix,lat,lon);
  const dayMix=smoothstep(0,5,elevation);
  return {elevation,dayMix,mode:dayMix<=.001?'night':dayMix>=.999?'day':'twilight'};
}
function cloudTileLocation(coords,x=128,y=128){
  const n=2**coords.z;
  return {lon:(coords.x+x/256)/n*360-180,
    lat:Math.atan(Math.sinh(Math.PI*(1-2*(coords.y+y/256)/n)))*180/Math.PI};
}
function cloudSourceWeights(lat,lon){
  if(lat<25 || lat>82 || lon< -85 || lon>42) return {eumet:0,noaa:0,gibs:0};
  const east=smoothstep(-56,-51,lon), north=smoothstep(49,50.3,lat);
  // Fade at the limb; geostationary satellites cannot see the poles.
  const limb=(satLon)=>smoothstep(.151,.22,
    Math.cos(lat*Math.PI/180)*Math.cos((lon-satLon)*Math.PI/180));
  const eumet=east*limb(0), gibs=(1-east)*north*limb(-75);
  const noaa=(1-east)*(1-north);
  return {eumet,noaa,gibs};
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
async function cloudFetch(url,type='text',timeout=16000){
  const ctrl=new AbortController();cloudControllers.add(ctrl);
  const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const response=await fetch(url,{signal:ctrl.signal,cache:'default'});
    if(!response.ok) throw new Error('Satellite HTTP '+response.status);
    if(type==='blob'){
      const blob=await response.blob();
      if(!blob.type.startsWith('image/'))throw new Error('Satellite returned non-image data');
      return blob;
    }
    return await response.text();
  }finally{clearTimeout(timer);cloudControllers.delete(ctrl);}
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
      }catch(e){console.warn('Satellite availability:',product.day,e.message);}
    })().finally(()=>{product.metadataPromise=null;});
    return product.metadataPromise;
  }));
}
function cloudMapUrl(product,name,time,coords,guide=false){
  const q=new URLSearchParams({service:'WMS',version:'1.1.1',request:'GetMap',
    layers:name,styles:'',format:'image/png',transparent:'true',srs:'EPSG:3857',
    bbox:cloudTileBbox(coords),width:String(CLOUD_SIDE),height:String(CLOUD_SIDE),
    time:new Date(time*1000).toISOString().replace('.000Z','Z')});
  if(guide)q.set('SLD_BODY',cloudGuideSld());
  return product.endpoint+'?'+q;
}
async function cloudImagePixels(url){
  const blob=await cloudFetch(url,'blob');
  let drawable,objectUrl;
  try{
    if(typeof createImageBitmap==='function')drawable=await createImageBitmap(blob);
    else{
      objectUrl=URL.createObjectURL(blob);drawable=new Image();drawable.decoding='async';
      await new Promise((resolve,reject)=>{drawable.onload=resolve;drawable.onerror=reject;drawable.src=objectUrl;});
    }
    const c=document.createElement('canvas');c.width=c.height=CLOUD_SIDE;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(drawable,0,0,CLOUD_SIDE,CLOUD_SIDE);
    return ctx.getImageData(0,0,CLOUD_SIDE,CLOUD_SIDE).data;
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
  const tasks=[modes.day?cloudImagePixels(cloudMapUrl(product,product.day,dayTime,coords)):Promise.resolve(null),
    modes.night?cloudImagePixels(cloudMapUrl(product,product.night,nightTime,coords)):Promise.resolve(null)];
  if(id==='eumet'){
    const guideTime=cloudAvailableTime({...product,cadence:900},'msg_fes:clm',Math.min(dayTime,nightTime));
    tasks.push(cloudImagePixels(cloudMapUrl(product,'msg_fes:clm',guideTime,coords,true)).catch(()=>null));
  }
  const [day,night,mask]=await Promise.all(tasks);
  let guide=null;
  if(mask){
    const alpha=new Float32Array(CLOUD_SIDE*CLOUD_SIDE);
    for(let p=0;p<alpha.length;p++)alpha[p]=mask[p*4+3]/255;
    guide=blurAlpha(alpha,CLOUD_SIDE,CLOUD_SIDE,6);
  }
  return {id,day,night,guide,dayTime,nightTime};
}
function cloudExtractPixel(source,index,p,lat,lon){
  const solarTime=source.day?source.dayTime:source.nightTime;
  const mix=cloudSolarMix(solarTime,lat,lon).dayMix;
  let dayAlpha=0,nightAlpha=0,dayTone=190,nightTone=190;
  if(source.day && mix>.001){
    const a=source.day,lum=.2126*a[index]+.7152*a[index+1]+.0722*a[index+2];
    const visual=visualCloudScore(a[index],a[index+1],a[index+2]);
    if(source.guide){
      const g=source.guide[p];
      dayAlpha=Math.max(smoothstep(.035,.80,g)*(.32+.68*smoothstep(38,220,lum)),visual*smoothstep(.015,.30,g)*.22);
    }else dayAlpha=visual**1.45*.86;
    dayAlpha*=a[index+3]/255;
    dayTone=Math.max(145,Math.min(255,150+105*smoothstep(28,235,lum)));
  }
  if(source.night && mix<.999){
    const a=source.night;
    const lum=source.id==='gibs'?cloudInfraredLuminance(a[index],a[index+1],a[index+2]):.2126*a[index]+.7152*a[index+1]+.0722*a[index+2];
    nightAlpha=source.guide?smoothstep(.055,.74,source.guide[p])*(.58+.42*smoothstep(16,225,lum)):smoothstep(52,205,lum)**1.35*.78;
    nightAlpha*=a[index+3]/255;
    nightTone=Math.max(138,Math.min(255,142+113*smoothstep(18,235,lum)));
  }
  const da=Math.min(.95,dayAlpha)*mix,na=Math.min(.95,nightAlpha)*(1-mix);
  return {alpha:da+na,tone:(dayTone*da+nightTone*na)/Math.max(.0001,da+na)};
}
function cloudProcessTile(coords,sources){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d'),out=ctx.createImageData(256,256);
  const latitudes=Array.from({length:256},(_,y)=>cloudTileLocation(coords,0,y+.5).lat);
  const longitudes=Array.from({length:256},(_,x)=>cloudTileLocation(coords,x+.5,0).lon);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const weights=cloudSourceWeights(latitudes[y],longitudes[x]);
    const p=(y+CLOUD_PADDING)*CLOUD_SIDE+x+CLOUD_PADDING,index=p*4;
    let alpha=0,tone=0;
    for(const source of sources){
      const weight=weights[source.id];if(!weight)continue;
      const pixel=cloudExtractPixel(source,index,p,latitudes[y],longitudes[x]);
      alpha+=pixel.alpha*weight;tone+=pixel.tone*pixel.alpha*weight;
    }
    const i=(y*256+x)*4;
    if(alpha<.014)continue;
    tone/=alpha;
    out.data[i]=Math.min(255,Math.round(tone+2));out.data[i+1]=Math.min(255,Math.round(tone+4));
    out.data[i+2]=Math.min(255,Math.round(tone+7));out.data[i+3]=Math.round(255*Math.min(.94,alpha));
  }
  ctx.putImageData(out,0,0);
  return {canvas,times:sources.map(s=>({id:s.id,day:s.day?s.dayTime:null,night:s.night?s.nightTime:null}))};
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
    return id+':'+cloudAvailableTime(p,p.day,time)+':'+cloudAvailableTime(p,p.night,time);
  }).join('|');
  return `${coords.z}/${coords.x}/${coords.y}/${versions}`;
}
function cloudGetTile(coords,time,priority=0){
  let key;
  try{key=cloudTileKey(coords,time);}catch(e){return Promise.reject(e);}
  if(cloudTileCache.has(key)){
    const hit=cloudTileCache.get(key);cloudTileCache.delete(key);cloudTileCache.set(key,hit);
    return Promise.resolve(hit);
  }
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
      const sources=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
      if(ids.length && !sources.length)throw new Error('Satellite tiles unavailable');
      const tile=cloudProcessTile(coords,sources);tile.partial=sources.length<ids.length;
      if(session===cloudSession && !tile.partial){
        cloudTileCache.set(key,tile);
        while(cloudTileCache.size>CLOUD_TILE_CACHE_LIMIT)cloudTileCache.delete(cloudTileCache.keys().next().value);
      }
      return tile;
    }});
    cloudPump();
  }).finally(()=>{if(cloudTilePromises.get(key)===promise)cloudTilePromises.delete(key);});
  cloudTilePromises.set(key,promise);return promise;
}
function cloudCancelQueued(){
  for(const job of cloudQueue.splice(0)){cloudTilePromises.delete(job.key);job.reject(new Error('Cloud loading cancelled'));}
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
        tile.getContext('2d').drawImage(result.canvas,0,0);tile._cloudImage=result.canvas;
        tile.dataset.cloudTime=String(requested);
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
  await new Promise(resolve=>{
    function tick(now){
      if(generation!==cloudFrameGeneration || !$('cloudOn').checked){resolve();return;}
      const f=Math.min(1,(now-start)/320),mix=f*f*(3-2*f);
      entries.forEach(([tile,result],i)=>{
        const ctx=tile.getContext('2d');ctx.clearRect(0,0,256,256);
        // Add premultiplied pixels, so the transition does not darken or thicken clouds.
        ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1-mix;
        if(old[i])ctx.drawImage(old[i],0,0);
        ctx.globalCompositeOperation='lighter';ctx.globalAlpha=mix;ctx.drawImage(result.canvas,0,0);
        ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      });
      if(f<1)requestAnimationFrame(tick);else resolve();
    }
    requestAnimationFrame(tick);
  });
}
async function drawCloud(frame){
  const generation=++cloudFrameGeneration;
  if(!$('cloudOn').checked || !frame){
    cloudRequestedTime=null;cloudSession++;cloudHistoryRequested=false;
    clearTimeout(cloudPrecacheTimer);cloudCancelQueued();cloudControllers.forEach(c=>c.abort());
    if(cloudLayer){map.removeLayer(cloudLayer);cloudLayer=null;}
    cloudTileCache.clear();cloudStatus('Cloud layer is off.');return;
  }
  cloudCancelQueued();
  cloudRequestedTime=frame.time;cloudStatus('Loading satellite clouds…');
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
  const results=await Promise.allSettled(tiles.map(t=>cloudGetTile(t.coords,frame.time)));
  if(generation!==cloudFrameGeneration || session!==cloudSession || layer!==cloudLayer)return;
  const successful=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  const failed=results.length-successful.length,partial=successful.some(r=>r.partial);
  if(!successful.length && tiles.length){
    cloudStatus('Satellite images unavailable. Previous clouds remain at their displayed observation time.','warn');return;
  }
  // Hold a complete previous frame if its replacement has holes.
  if((failed || partial) && layer.hasCompleteFrame){
    cloudStatus('Some satellite tiles are unavailable. Holding the previous observation: '+(layer.observationLabel||''),'warn');return;
  }
  const entries=tiles.flatMap((t,i)=>results[i].status==='fulfilled'?[[t.el,results[i].value]]:[]);
  const unchanged=entries.every(([tile,result])=>tile._cloudImage===result.canvas);
  if(!unchanged)await cloudCrossfade(entries,generation);
  if(generation!==cloudFrameGeneration || session!==cloudSession)return;
  entries.forEach(([tile,result])=>{tile._cloudImage=result.canvas;tile.dataset.cloudTime=String(frame.time);});
  layer.displayTime=frame.time;layer.hasCompleteFrame=!failed&&!partial;
  layer.observationLabel=cloudTimeDescription(successful);
  weatherFront();
  cloudStatus(layer.observationLabel?(failed||partial?'Partial cloud coverage · ':'')+layer.observationLabel:
    'Outside satellite coverage. No cloud imagery is available here.',failed||partial?'warn':'ok');
  scheduleCloudPrecache();
}
function requestCloudHistory(){cloudHistoryRequested=true;}
function scheduleCloudPrecache(){
  clearTimeout(cloudPrecacheTimer);
  if(!cloudHistoryRequested || !$('cloudOn').checked || !cloudLayer)return;
  const generation=cloudFrameGeneration,session=cloudSession;
  cloudPrecacheTimer=setTimeout(()=>{
    if(generation!==cloudFrameGeneration || session!==cloudSession)return;
    const i=Number($('timeline').value),next=frames[i+1]||frames[0];
    if(!next)return;
    const tiles=cloudVisibleTiles();
    // One rolling frame, never an eager download of the full two-hour history.
    tiles.forEach(t=>cloudGetTile(t.coords,next.time,1).catch(()=>{}));
  },100);
}
map.on('movestart zoomstart',()=>{
  if(cloudLayer){
    cloudFrameGeneration++;cloudSession++;clearTimeout(cloudPrecacheTimer);
    cloudCancelQueued();cloudControllers.forEach(c=>c.abort());cloudTilePromises.clear();
  }
});
map.on('moveend zoomend',()=>{
  if($('cloudOn').checked && cloudRequestedTime!==null){
    // GridLayer handles newly visible tiles; render the selected frame after it updates.
    setTimeout(()=>drawCloud({time:cloudRequestedTime}).catch(console.error),0);
  }
});
