// Natural Earth geometry is loaded once. Failed verification never admits a spot.
(function(root){
  'use strict';
  function ringIndex(ring){
    if(!Array.isArray(ring)||ring.length<4)throw Error('Invalid land boundary');
    let previous=Number(ring[0][0]);
    const points=ring.map(p=>{let lon=p[0];if(!Number.isFinite(lon)||!Number.isFinite(p[1]))throw Error('Invalid land coordinate');while(lon-previous>180)lon-=360;while(lon-previous< -180)lon+=360;previous=lon;return [lon,p[1]];});
    return {points,west:Math.min(...points.map(p=>p[0])),east:Math.max(...points.map(p=>p[0])),south:Math.min(...points.map(p=>p[1])),north:Math.max(...points.map(p=>p[1]))};
  }
  function inside(ring,point){
    if(point.lat<ring.south||point.lat>ring.north)return false;
    let lon=point.lon+360*Math.round(((ring.west+ring.east)/2-point.lon)/360);
    if(lon<ring.west||lon>ring.east)return false;
    let result=false;const ps=ring.points;
    for(let i=0,j=ps.length-1;i<ps.length;j=i++){
      const a=ps[i],b=ps[j];
      if((a[1]>point.lat)!==(b[1]>point.lat)&&lon<(b[0]-a[0])*(point.lat-a[1])/(b[1]-a[1])+a[0])result=!result;
    }
    return result;
  }
  function compile(asset){
    if(asset?.version!==1||!Array.isArray(asset.land)||!asset.land.length||!Array.isArray(asset.water))throw Error('Land boundaries unavailable');
    const build=polys=>polys.map(poly=>poly.map(ringIndex));
    const land=build(asset.land),water=build(asset.water);
    const contains=(polys,p)=>polys.some(poly=>inside(poly[0],p)&&!poly.slice(1).some(r=>inside(r,p)));
    return point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lon)&&contains(land,point)&&!contains(water,point);
  }
  let promise=null;
  async function load(){
    if(!promise)promise=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),20000);
      try{const response=await fetch('assets/aurora-land-v1.json',{cache:'force-cache',signal:abort.signal});if(!response.ok)throw Error('Land verification unavailable. Try again shortly.');return compile(await response.json());}finally{clearTimeout(timer);}
    })().catch(error=>{promise=null;throw error;});
    return promise;
  }
  root.NorthernAuroraLand={compile,load};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.NorthernAuroraLand;
})(typeof window!=='undefined'?window:globalThis);
