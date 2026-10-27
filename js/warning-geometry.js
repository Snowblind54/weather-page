// Pure geometry helpers. Official coordinates remain unchanged in the source.
(function(root){
  'use strict';
  const clamp=v=>Math.max(-85.05112878,Math.min(85.05112878,v));
  const latOf=(p,order)=>p[order==='geojson'?1:0],lonOf=(p,order)=>p[order==='geojson'?0:1];
  function descriptor(rings,order='cap'){
    if(!Array.isArray(rings)||!rings[0]?.length)return null;
    let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity,previous=lonOf(rings[0][0],order);
    for(const point of rings[0]){
      const lat=latOf(point,order);let lon=lonOf(point,order);
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
      while(lon-previous>180)lon-=360;while(lon-previous< -180)lon+=360;previous=lon;
      west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);
    }
    return {rings,order,bounds:{west,east,south,north},cache:new Map()};
  }
  function cap(polygons){
    return (polygons||[]).map(p=>descriptor(typeof p?.[0]?.[0]==='number'?[p]:p)).filter(Boolean);
  }
  function geojson(value){
    if(!value)return [];
    if(value.type==='Feature')return geojson(value.geometry);
    if(value.type==='FeatureCollection')return value.features.flatMap(geojson);
    if(value.type==='GeometryCollection')return value.geometries.flatMap(geojson);
    const polys=value.type==='Polygon'?[value.coordinates]:value.type==='MultiPolygon'?value.coordinates:[];
    return polys.map(p=>descriptor(p,'geojson')).filter(Boolean);
  }
  function intersects(b,v){
    if(b.north<v.south||b.south>v.north)return false;
    return Math.ceil((v.west-b.east)/360)<=Math.floor((v.east-b.west)/360);
  }
  const worldShift=(b,centre)=>360*Math.round((centre-(b.west+b.east)/2)/360);
  function distanceSq(p,a,b){
    let x=a[0],y=a[1],dx=b[0]-x,dy=b[1]-y;
    if(dx||dy){const t=((p[0]-x)*dx+(p[1]-y)*dy)/(dx*dx+dy*dy);if(t>1){x=b[0];y=b[1];}else if(t>0){x+=dx*t;y+=dy*t;}}
    dx=p[0]-x;dy=p[1]-y;return dx*dx+dy*dy;
  }
  function simplifyRing(ring,order,zoom,shift,centre){
    if(!ring.length)return [];
    const points=[];let previous=lonOf(ring[0],order);
    for(const p of ring){let lon=lonOf(p,order);while(lon-previous>180)lon-=360;while(lon-previous< -180)lon+=360;previous=lon;points.push([lon,latOf(p,order)]);}
    const correction=360*Math.round((centre-points[0][0])/360);
    // A half-pixel error budget; use the same Web Mercator coordinates as Leaflet.
    const project=p=>[p[0],Math.log(Math.tan(Math.PI/4+clamp(p[1])*Math.PI/360))*180/Math.PI];
    const tolerance=.5*360/(256*2**zoom),sq=tolerance*tolerance;
    const projected=points.map(project),keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;
    const stack=[[0,points.length-1]];
    while(stack.length){const [a,b]=stack.pop();let far=sq,index=-1;for(let i=a+1;i<b;i++){const d=distanceSq(projected[i],projected[a],projected[b]);if(d>far){far=d;index=i;}}if(index>=0){keep[index]=1;if(index-a>1)stack.push([a,index]);if(b-index>1)stack.push([index,b]);}}
    let selected=points.filter((p,i)=>keep[i]);
    // Keep tiny islands and holes instead of collapsing them into a line.
    if(selected.length<4)selected=points;
    return selected.map(([lon,lat])=>[lat,lon+correction+shift]);
  }
  function simplified(d,zoom,centre){
    const shift=worldShift(d.bounds,centre),key=zoom+':'+shift;
    if(d.cache.has(key))return d.cache.get(key);
    const target=(d.bounds.west+d.bounds.east)/2;
    const result=d.rings.map(r=>simplifyRing(r,d.order,zoom,shift,target));
    d.cache.set(key,result);while(d.cache.size>2)d.cache.delete(d.cache.keys().next().value);
    return result;
  }
  // Bound serialization before allocating a second copy of a large snapshot.
  function cacheableRecords(records){
    if(!Array.isArray(records)||records.length>500)return false;
    let points=0,textSize=0,parts=0;const pending=[];
    for(const record of records){
      for(const value of Object.values(record))if(typeof value==='string'){textSize+=value.length;if(textSize>500000)return false;}
      for(const polygon of record.polygons||[]){if(++parts>1000)return false;pending.push(polygon);}
    }
    while(pending.length){const value=pending.pop();if(!Array.isArray(value))continue;if(typeof value[0]==='number'){if(++points>30000)return false;}else for(const child of value)pending.push(child);}
    return true;
  }
  root.NorthernWarningGeometry={cap,geojson,intersects,worldShift,simplified,cacheableRecords};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.NorthernWarningGeometry;
})(typeof window!=='undefined'?window:globalThis);
