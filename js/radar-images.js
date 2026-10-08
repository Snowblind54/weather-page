// Public radar pictures can be displayed without reading cross-origin pixels.
// No public proxy, account token or application server is needed for these images.
const radarNativeImages=new Map(),radarNativePending=new Map();
function cacheRadarNativeImage(url,result){
  radarNativeImages.delete(url);radarNativeImages.set(url,result);
  while(radarNativeImages.size>100 || [...radarNativeImages.values()].reduce((bytes,entry)=>bytes+(entry.image?entry.width*entry.height*4:0),0)>24*1024*1024)radarNativeImages.delete(radarNativeImages.keys().next().value);
}
function loadRadarNativeImage(url,{pixels=false}={}){
  const cached=radarNativeImages.get(url);
  if(cached?.error&&Date.now()-cached.at<30000)return Promise.reject(cached.error);
  if(cached&&!cached.error&&(!pixels||cached.image)){cacheRadarNativeImage(url,cached);return Promise.resolve(cached);}
  if(radarNativePending.has(url))return radarNativePending.get(url);
  const promise=new Promise((resolve,reject)=>{
    const image=new Image();image.decoding='async';image.referrerPolicy='no-referrer';
    const finish=()=>{clearTimeout(timer);image.onload=image.onerror=null;};
    const fail=()=>{finish();const error=new Error('Official radar image unavailable');cacheRadarNativeImage(url,{at:Date.now(),error});reject(error);};
    const timer=setTimeout(()=>{image.src='';fail();},8000);
    image.onerror=fail;
    image.onload=()=>{
      finish();
      if(!image.naturalWidth||!image.naturalHeight){fail();return;}
      const result={url,width:image.naturalWidth,height:image.naturalHeight,at:Date.now(),image};
      cacheRadarNativeImage(url,result);
      // Retain decoded images within a 24 MiB budget for instant reuse.
      resolve({...result,image});
    };
    image.src=url;
  }).finally(()=>{if(radarNativePending.get(url)===promise)radarNativePending.delete(url);});
  radarNativePending.set(url,promise);return promise;
}
function radarMercatorY(latitude){return Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360));}
function radarLatitudeAtY(value){return (2*Math.atan(Math.exp(value))-Math.PI/2)*180/Math.PI;}

// Exact WGS84 polar Lambert azimuthal equal-area projection: EPSG:3575.
function dmiPolarPoint(longitude,latitude){
  const eccentricity=Math.sqrt(.0066943799901413165),sin=Math.sin(latitude*Math.PI/180);
  const q=value=>(1-eccentricity**2)*(value/(1-eccentricity**2*value**2)-Math.log((1-eccentricity*value)/(1+eccentricity*value))/(2*eccentricity));
  const radius=6378137*Math.sqrt(Math.max(0,q(1)-q(sin))),angle=(longitude-10)*Math.PI/180;
  return [radius*Math.sin(angle),-radius*Math.cos(angle)];
}
function dmiImagePlan(time,edge,bounds=[[52,2],[61,22]]){
  const [[south,west],[north,east]]=bounds,top=radarMercatorY(north),bottom=radarMercatorY(south);
  const aspect=(east-west)*Math.PI/180/(top-bottom);
  const width=aspect>=1?edge:Math.round(edge*aspect),height=aspect>=1?Math.round(edge/aspect):edge;
  const points=[];
  for(let i=0;i<=32;i++){
    const lon=west+(east-west)*i/32,lat=radarLatitudeAtY(bottom+(top-bottom)*i/32);
    points.push(dmiPolarPoint(lon,south),dmiPolarPoint(lon,north),dmiPolarPoint(west,lat),dmiPolarPoint(east,lat));
  }
  const left=Math.min(...points.map(p=>p[0]))-1000,right=Math.max(...points.map(p=>p[0]))+1000;
  const low=Math.min(...points.map(p=>p[1]))-1000,high=Math.max(...points.map(p=>p[1]))+1000;
  // DMI serves 512-pixel tiles. Use more tiles at close zooms to retain detail.
  const columns=Math.ceil(edge/512),rows=Math.max(1,Math.ceil(columns*(high-low)/(right-left))),tiles=[];
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
    const box=[left+(right-left)*col/columns,high-(high-low)*(row+1)/rows,left+(right-left)*(col+1)/columns,high-(high-low)*row/rows];
    const params=new URLSearchParams({SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:'radar',STYLES:'',SRS:'EPSG:3575',BBOX:box.join(','),WIDTH:'512',HEIGHT:'512',FORMAT:'image/png',TRANSPARENT:'TRUE',TIME:new Date(time*1000).toISOString().replace('.000Z','Z')});
    tiles.push({row,col,url:'https://www.dmi.dk/ZoombareKort/map?'+params});
  }
  return {bounds,width,height,top,bottom,left,right,low,high,columns,rows,tiles};
}
function radarTriangle(context,image,source,target){
  const [[u0,v0],[u1,v1],[u2,v2]]=source,[[x0,y0],[x1,y1],[x2,y2]]=target;
  const determinant=(u1-u0)*(v2-v0)-(u2-u0)*(v1-v0);if(Math.abs(determinant)<1e-8)return;
  const a=((x1-x0)*(v2-v0)-(x2-x0)*(v1-v0))/determinant;
  const b=((y1-y0)*(v2-v0)-(y2-y0)*(v1-v0))/determinant;
  const c=((x2-x0)*(u1-u0)-(x1-x0)*(u2-u0))/determinant;
  const d=((y2-y0)*(u1-u0)-(y1-y0)*(u2-u0))/determinant;
  context.save();context.beginPath();context.moveTo(x0,y0);context.lineTo(x1,y1);context.lineTo(x2,y2);context.closePath();context.clip();
  context.transform(a,b,c,d,x0-a*u0-c*v0,y0-b*u0-d*v0);context.drawImage(image,0,0);context.restore();
}
async function prepareDmiRadarImage(record,edge,allowed){
  const plan=dmiImagePlan(record.time,edge,record.viewBounds||[[52,2],[61,22]]),source=document.createElement('canvas');
  source.width=plan.columns*512;source.height=plan.rows*512;const input=source.getContext('2d');
  let next=0;
  await Promise.all([0,1].map(async()=>{
    while(next<plan.tiles.length){
      if(!allowed())throw new Error('Radar preparation paused');
      const tile=plan.tiles[next++],loaded=await loadRadarNativeImage(tile.url,{pixels:true});
      if(loaded.width!==512||loaded.height!==512)throw new Error('Unexpected DMI radar tile');
      input.drawImage(loaded.image,tile.col*512,tile.row*512);
    }
  }));
  if(!allowed())throw new Error('Radar preparation paused');
  const canvas=document.createElement('canvas');canvas.width=plan.width;canvas.height=plan.height;
  const output=canvas.getContext('2d'),[[south,west],[north,east]]=plan.bounds,steps=32;
  const point=(col,row)=>{
    const x=col/steps*plan.width,y=row/steps*plan.height;
    const lon=west+(east-west)*col/steps,lat=radarLatitudeAtY(plan.top-(plan.top-plan.bottom)*row/steps);
    const [px,py]=dmiPolarPoint(lon,lat);
    return {source:[(px-plan.left)/(plan.right-plan.left)*source.width,(plan.high-py)/(plan.high-plan.low)*source.height],target:[x,y]};
  };
  for(let row=0;row<steps;row++)for(let col=0;col<steps;col++){
    const a=point(col,row),b=point(col+1,row),c=point(col+1,row+1),d=point(col,row+1);
    radarTriangle(output,source,[a.source,b.source,c.source],[a.target,b.target,c.target]);
    radarTriangle(output,source,[a.source,c.source,d.source],[a.target,c.target,d.target]);
  }
  source.width=source.height=0;
  // A viewport crop is not the native radar footprint; retain broad native
  // geometry so panning never mistakes an earlier crop for absent coverage.
  return {canvas,bounds:plan.bounds,coverage:{bounds:[[52,2],[61,22]]}};
}
function radarDmiViewportBounds(){
  if(map.getZoom()<5)return null;
  const b=map.getBounds();
  const south=Math.max(52,Math.floor(b.getSouth()*2)/2-.5),west=Math.max(2,Math.floor(b.getWest()*2)/2-.5);
  const north=Math.min(61,Math.ceil(b.getNorth()*2)/2+.5),east=Math.min(22,Math.ceil(b.getEast()*2)/2+.5);
  return south<north&&west<east?[[south,west],[north,east]]:null;
}
function ensureRadarColourFilter(){
  if(document.getElementById('radar-echo-colours'))return;
  // DMI includes grey cartography; LHMT includes grey missing coverage. Remove
  // achromatic backgrounds without reading cross-origin image pixels.
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','0');svg.setAttribute('height','0');
  svg.style.position='absolute';svg.setAttribute('aria-hidden','true');
  const channel=index=>Array.from({length:20},(_,i)=>i<15?(i%5===index?1:0):(i===18?1:0)).join(' ');
  svg.innerHTML=`<defs><filter id="radar-echo-colours" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" values="${channel(0)}" result="r"/><feColorMatrix in="SourceGraphic" values="${channel(1)}" result="g"/><feColorMatrix in="SourceGraphic" values="${channel(2)}" result="b"/><feBlend in="r" in2="g" mode="lighten" result="rgmax"/><feBlend in="rgmax" in2="b" mode="lighten" result="maximum"/><feBlend in="r" in2="g" mode="darken" result="rgmin"/><feBlend in="rgmin" in2="b" mode="darken" result="minimum"/><feColorMatrix in="maximum" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="maxalpha"/><feColorMatrix in="minimum" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="minalpha"/><feComposite in="maxalpha" in2="minalpha" operator="arithmetic" k2="1" k3="-1" result="chroma"/><feComponentTransfer in="chroma" result="mask"><feFuncA type="linear" slope="6" intercept="-0.6"/></feComponentTransfer><feComposite in="SourceGraphic" in2="mask" operator="in"/></filter></defs>`;
  document.body.appendChild(svg);
}
function dmiRadarCanvasLayer(frame){
  ensureRadarColourFilter();
  const Layer=L.Layer.extend({
    onAdd(map){this._map=map;this._canvas=frame.canvas;this._canvas.className='leaflet-image-layer';Object.assign(this._canvas.style,{position:'absolute',pointerEvents:'none',opacity:'.84',filter:'url(#radar-echo-colours)'});map.getPane('overlayPane').appendChild(this._canvas);map.on('zoom viewreset moveend',this._reset,this);this._reset();},
    onRemove(map){map.off('zoom viewreset moveend',this._reset,this);this._canvas.remove();},
    _reset(){const bounds=L.latLngBounds(frame.bounds),top=this._map.latLngToLayerPoint(bounds.getNorthWest()),bottom=this._map.latLngToLayerPoint(bounds.getSouthEast());L.DomUtil.setPosition(this._canvas,top);this._canvas.style.width=(bottom.x-top.x)+'px';this._canvas.style.height=(bottom.y-top.y)+'px';},
    getBounds(){return L.latLngBounds(frame.bounds);},
    bringToFront(){this._canvas.parentNode?.appendChild(this._canvas);return this;}
  });return new Layer();
}

// Estonia's KAIA radar is the authoritative layer over Estonia. Finland,
// Sweden, Norway, Latvia and Lithuania all publish products whose footprints
// overlap Estonia, and stacking those semi-transparent images can create a
// doubled/ghost echo. While KAIA is present, cut Estonia out of the secondary
// products. If KAIA is unavailable the cutout is removed so neighbours can
// still provide fallback coverage.
const ESTONIA_RADAR_PRIORITY_POLYGONS=[
  // Mainland.
  [[24.312863,57.793424],[24.428928,58.383413],[24.061198,58.257375],[23.42656,58.612753],[23.339795,59.18724],[24.604214,59.465854],[25.864189,59.61109],[26.949136,59.445803],[27.981114,59.475388],[28.131699,59.300825],[27.420166,58.724581],[27.716686,57.791899],[27.288185,57.474528],[26.463532,57.476389],[25.60281,57.847529],[25.164594,57.970157],[24.312863,57.793424]],
  // Saaremaa / Muhu group.
  [[21.73,57.92],[22.05,57.82],[22.72,57.88],[23.47,58.18],[23.62,58.55],[23.18,58.72],[22.43,58.67],[21.82,58.49],[21.73,57.92]],
  // Hiiumaa / Vormsi group.
  [[22.02,58.68],[22.53,58.62],[23.45,58.78],[23.58,59.05],[23.14,59.25],[22.42,59.19],[21.95,58.96],[22.02,58.68]]
];
const ESTONIA_RADAR_PRIORITY_BOUNDS=[[57.47,21.70],[59.62,28.14]];
function radarBoundsOverlap(a,b){
  return a?.length===2&&b?.length===2&&a[0][0]<b[1][0]&&a[1][0]>b[0][0]&&a[0][1]<b[1][1]&&a[1][1]>b[0][1];
}
function radarPriorityMask(bounds,polygons){
  if(!bounds||!polygons.length)return '';
  const [[south,west],[north,east]]=bounds;
  const top=radarMercatorY(north),bottom=radarMercatorY(south);
  if(!Number.isFinite(top)||!Number.isFinite(bottom)||top===bottom||east===west)return '';
  const holes=polygons.map(polygon=>{
    const points=polygon.map(([lon,lat])=>{
      const x=(lon-west)/(east-west)*1000;
      const y=(top-radarMercatorY(lat))/(top-bottom)*1000;
      return `${x.toFixed(2)} ${y.toFixed(2)}`;
    });
    return 'M'+points.join('L')+'Z';
  }).join(' ');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><path fill="white" fill-rule="evenodd" d="M0 0H1000V1000H0Z ${holes}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function estoniaRadarPriorityMask(bounds){return radarBoundsOverlap(bounds,ESTONIA_RADAR_PRIORITY_BOUNDS)?radarPriorityMask(bounds,ESTONIA_RADAR_PRIORITY_POLYGONS):'';}
// Display ownership seam through the shared Kattegat / Oresund coverage.
// Bornholm and Danish waters south of Sweden stay on the Danish side.
const DENMARK_RADAR_DOMAIN=[[2,52],[22,52],[22,54.8],[15.5,54.8],[15.5,55.4],[12.75,55.4],[12.65,55.75],[12.55,56.05],[11.3,57.75],[10,58.5],[2,58.5]];
const SWEDEN_RADAR_DOMAIN=[[22,61],[2,61],[2,58.5],[10,58.5],[11.3,57.75],[12.55,56.05],[12.65,55.75],[12.75,55.4],[15.5,55.4],[15.5,54.8],[22,54.8]];
function radarDomainInCoverage(polygon,layer){
  const coverage=layer?.radarCoverage;
  if(!coverage?.cells)return [polygon];
  const [[south,west],[north,east]]=coverage.bounds,top=radarMercatorY(north),bottom=radarMercatorY(south),out=[];
  for(let row=0;row<coverage.rows;row++)for(let col=0;col<coverage.cols;col++){
    if(!coverage.cells[row*coverage.cols+col])continue;
    const left=west+col/coverage.cols*(east-west),right=west+(col+1)/coverage.cols*(east-west);
    const high=radarLatitudeAtY(top-row/coverage.rows*(top-bottom)),low=radarLatitudeAtY(top-(row+1)/coverage.rows*(top-bottom));
    let points=polygon;
    for(const [axis,limit,direction] of [[0,left,1],[0,right,-1],[1,low,1],[1,high,-1]]){
      const next=[];
      for(let i=0;i<points.length;i++){
        const a=points[i],b=points[(i+1)%points.length],insideA=direction*(a[axis]-limit)>=0,insideB=direction*(b[axis]-limit)>=0;
        if(insideA)next.push(a);
        if(insideA!==insideB){const t=(limit-a[axis])/(b[axis]-a[axis]);next.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
      }
      points=next;if(!points.length)break;
    }
    if(points.length>=3)out.push(points);
  }
  return out;
}
function secondaryRadarElement(layer){return layer?.getElement?.()||layer?._canvas||null;}
function secondaryRadarBounds(layer){
  const bounds=layer?.getBounds?.();
  return bounds?[[bounds.getSouth(),bounds.getWest()],[bounds.getNorth(),bounds.getEast()]]:null;
}
function setEstoniaRadarPriorityMask(layer,enabled){
  const element=secondaryRadarElement(layer);if(!element)return;
  const bounds=secondaryRadarBounds(layer),holes=enabled&&radarBoundsOverlap(bounds,ESTONIA_RADAR_PRIORITY_BOUNDS)?[...ESTONIA_RADAR_PRIORITY_POLYGONS]:[];
  if(typeof nordicRadarLayers!=='undefined'&&nordicRadarLayers.has('dk:dk')&&nordicRadarLayers.has('se:se')){
    if(layer===nordicRadarLayers.get('dk:dk'))holes.push(...radarDomainInCoverage(SWEDEN_RADAR_DOMAIN,nordicRadarLayers.get('se:se')));
    if(layer===nordicRadarLayers.get('se:se'))holes.push(...radarDomainInCoverage(DENMARK_RADAR_DOMAIN,nordicRadarLayers.get('dk:dk')));
  }
  const mask=radarPriorityMask(bounds,holes);
  element.style.maskImage=mask;element.style.webkitMaskImage=mask;
  element.style.maskRepeat=mask?'no-repeat':'';element.style.webkitMaskRepeat=mask?'no-repeat':'';
  element.style.maskSize=mask?'100% 100%':'';element.style.webkitMaskSize=mask?'100% 100%':'';
}
function syncEstoniaRadarPriorityMasks(){
  const enabled=!!(typeof radarLayer!=='undefined'&&radarLayer&&typeof map!=='undefined'&&map.hasLayer?.(radarLayer));
  if(typeof directRadarLayers!=='undefined')for(const layer of directRadarLayers.values())setEstoniaRadarPriorityMask(layer,enabled);
  if(typeof nordicRadarLayers!=='undefined')for(const layer of nordicRadarLayers.values())setEstoniaRadarPriorityMask(layer,enabled);
}
let estoniaRadarMaskSyncQueued=false;
function queueEstoniaRadarPrioritySync(){
  if(estoniaRadarMaskSyncQueued)return;
  estoniaRadarMaskSyncQueued=true;
  requestAnimationFrame(()=>{
    estoniaRadarMaskSyncQueued=false;
    try{syncEstoniaRadarPriorityMasks();}catch(error){console.warn('Estonia radar overlap mask could not update',error);}
  });
}
const radarOverlayPane=typeof map!=='undefined'?map.getPane?.('overlayPane'):null;
if(radarOverlayPane&&typeof MutationObserver!=='undefined'){
  new MutationObserver(queueEstoniaRadarPrioritySync).observe(radarOverlayPane,{childList:true});
}
