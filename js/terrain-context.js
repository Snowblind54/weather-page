/* Static DEM context for interpolation. Measured station values stay unchanged. */
(function(root){
 'use strict';
 let packs=[],promise=null,loaded=false;
 function decode(buffer){
  const view=new DataView(buffer),size=view.getUint32(0,true);
  if(size>1024||size+4>=buffer.byteLength)throw new Error('Invalid terrain header');
  const h=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,size)));
  if(h.version!==1||!Number.isInteger(h.rows)||!Number.isInteger(h.cols)||h.rows*h.cols>2000000||buffer.byteLength!==size+4+h.rows*h.cols*2||!(h.step>0)||h.scale!==10)throw new Error('Invalid terrain grid');
  const values=new Int16Array(h.rows*h.cols);
  for(let i=0;i<values.length;i++)values[i]=view.getInt16(size+4+i*2,true);
  return {...h,values};
 }
 async function load(name){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
  const response=await fetch((root.NorthernTerrainAssetBase||'assets/')+'terrain-'+name+'-v1.bin.gz',{cache:'force-cache',signal:controller.signal});
  if(!response.ok)throw new Error('Terrain HTTP '+response.status);
  let buffer=await response.arrayBuffer();
  // Some hosts automatically decode Content-Encoding; others serve .gz bytes.
  if(new Uint8Array(buffer)[0]===31&&new Uint8Array(buffer)[1]===139){
   buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return decode(buffer);
  }finally{clearTimeout(timer);}
 }
 function ready(){
  if(!promise)promise=Promise.allSettled(['europe','global'].map(load)).then(results=>{
   packs=results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>a.step-b.step);loaded=true;
   return packs.length>0;
  });
  return promise;
 }
 function elevation(lat,lon){
  lon=((lon+180)%360+360)%360-180;
  const p=packs.find(p=>lat>=p.south&&lat<=p.north&&lon>=p.west&&lon<=p.east);
  if(!p)return null;
  const x=(lon-p.west)/p.step,y=(lat-p.south)/p.step;
  const x0=Math.min(p.cols-2,Math.max(0,Math.floor(x))),y0=Math.min(p.rows-2,Math.max(0,Math.floor(y)));
  const fx=x-x0,fy=y-y0,i=y0*p.cols+x0,v=p.values;
  // Bathymetry is not an atmospheric sensor elevation. Use sea-level
  // surface height for negative DEM samples (including tiny coastal errors).
  return Math.max(0,((v[i]*(1-fx)+v[i+1]*fx)*(1-fy)+(v[i+p.cols]*(1-fx)+v[i+p.cols+1]*fx)*fy)*p.scale);
 }
 function influence(lat,lon,kind){
  const height=elevation(lat,lon),cache=new Map();
  const scale=kind==='wind'?500:kind==='rain'?650:1200;
  return function(targetLat,targetLon){
   const dy=(targetLat-lat)*111.2,dx=(targetLon-lon)*111.2*Math.cos(lat*Math.PI/180),km=Math.hypot(dx,dy);
   if(km<.15)return 1;
   // A few-kilometre cache bounds work per station while avoiding ridge scans
   // for every full-resolution raster pixel. Terrain is regional, not microscale.
   const a=Math.round(targetLat*25)/25,b=Math.round(targetLon*25)/25,key=a+','+b;
   if(cache.has(key))return cache.get(key);
   const target=elevation(a,b);
   let weight=.35; // Unknown terrain reduces influence, never assumes flat land.
   if(height!==null&&target!==null){
    let ridge=Math.max(height,target),count=Math.min(12,Math.max(3,Math.ceil(km/6)));
    for(let i=1;i<count;i++){
     const v=elevation(lat+(a-lat)*i/count,lon+(b-lon)*i/count);
     if(v!==null)ridge=Math.max(ridge,v);
    }
    const barrier=Math.max(0,ridge-Math.max(height,target)-150),difference=Math.abs(target-height);
    weight=Math.exp(-Math.pow(difference/scale,2)-Math.pow(barrier/(scale*.8),2));
   }
   if(cache.size>=12000)cache.clear();cache.set(key,weight);
   return weight;
  };
 }
 function temperature(value,fromLat,fromLon,toLat,toLon){
  const from=elevation(fromLat,fromLon),to=elevation(toLat,toLon);
  // Bounded standard lapse-rate estimate, not a claim to model inversions.
  return from===null||to===null?value:value+Math.max(-12,Math.min(12,(from-to)*.0065));
 }
 root.NorthernTerrain={ready,elevation,influence,temperature,decode,get loaded(){return loaded;},get available(){return packs.length>0;}};
})(typeof window!=='undefined'?window:globalThis);
