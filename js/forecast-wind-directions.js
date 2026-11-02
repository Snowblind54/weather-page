(function(root){
  'use strict';
  const merc=lat=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
  function validate(grid,time){
    return grid?.version===1&&grid.time===new Date(time).toISOString()&&
      grid.projection==='mercator'&&grid.convention==='wind_from_degrees'&&
      Number.isInteger(grid.width)&&grid.width>=2&&grid.width<=256&&
      Number.isInteger(grid.height)&&grid.height>=2&&grid.height<=256&&
      Array.isArray(grid.bounds)&&grid.bounds.length===4&&grid.bounds.every(Number.isFinite)&&
      grid.bounds[0]<grid.bounds[2]&&grid.bounds[1]<grid.bounds[3]&&grid.bounds[1]>-85&&grid.bounds[3]<85&&
      Array.isArray(grid.values)&&grid.values.length===grid.width*grid.height&&
      grid.values.every(v=>v===null||(Number.isFinite(v)&&v>=0&&v<360));
  }
  function asset(region,time){
    const key=new Date(time).toISOString(),path=region.wind_vectors?.frames?.[key];
    const root=region.asset_root||'forecast-cache';
    const image=region.images?.wind?.[key];
    const name='wind-vectors-'+key.replace(/[-:]/g,'').slice(0,11)+'Z.json';
    if(region.wind_vectors?.version!==1||typeof image!=='string'||typeof path!=='string'||
      !['forecast-cache','forecast-iceland-cache','forecast-canada-cache'].includes(root)||
      !path.startsWith('data/'+root+'/')||path.split('/').length!==4||
      path.split('/')[2]!==image.split('/')[2]||path.split('/').at(-1)!==name||path.includes('..'))return null;
    return path;
  }
  function sample(grid,lat,lon,shift=0){
    const [west,south,east,north]=grid.bounds;lon-=shift;
    if(lat<south||lat>north||lon<west||lon>east)return null;
    const x=Math.round((lon-west)/(east-west)*(grid.width-1));
    const y=Math.round((merc(north)-merc(lat))/(merc(north)-merc(south))*(grid.height-1));
    return grid.values[y*grid.width+x]??null;
  }
  // Meteorological bearings describe where wind comes FROM. Canvas arrows
  // point TO its destination: a northerly (0°) therefore points down/south.
  function flowAngle(from){return (from+180)*Math.PI/180;}
  const api={validate,asset,sample,flowAngle};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.ForecastWindDirections=api;
  if(typeof map==='undefined'||typeof L==='undefined')return;
  map.createPane('forecastWindDirections');
  const pane=map.getPane('forecastWindDirections');pane.style.zIndex='440';pane.style.pointerEvents='none';
  const canvas=document.createElement('canvas');canvas.className='leaflet-zoom-hide';
  canvas.id='forecastWindDirectionsCanvas';
  canvas.style.cssText='position:absolute;pointer-events:none;';canvas.setAttribute('aria-hidden','true');
  let grids=[],revision=0;
  const cache=new Map(),pending=new Map();
  function clear(){revision++;grids=[];canvas.remove();}
  function draw(){
    if(!grids.length){canvas.remove();return;}
    const size=map.getSize(),ratio=Math.min(root.devicePixelRatio||1,2,Math.sqrt(8000000/(size.x*size.y)));
    canvas.width=Math.round(size.x*ratio);canvas.height=Math.round(size.y*ratio);
    canvas.style.width=size.x+'px';canvas.style.height=size.y+'px';
    L.DomUtil.setPosition(canvas,map.containerPointToLayerPoint([0,0]));
    if(!canvas.parentNode)pane.append(canvas);
    const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.lineCap='round';ctx.lineJoin='round';
    const spacing=Math.max(size.x<600?76:66,Math.sqrt(size.x*size.y/900));
    for(let y=spacing/2;y<size.y;y+=spacing)for(let x=spacing/2;x<size.x;x+=spacing){
      const point=map.containerPointToLatLng([x,y]);
      const canonical=((point.lng+180)%360+360)%360-180;
      if(root.NorthernCountryFocus?.allowsPoint&&!root.NorthernCountryFocus.allowsPoint(point.lat,canonical))continue;
      let direction=null;
      for(const {grid,shift} of grids){direction=sample(grid,point.lat,point.lng,shift);if(direction!==null)break;}
      if(direction===null)continue;
      ctx.save();ctx.translate(x,y);ctx.rotate(flowAngle(direction));
      ctx.beginPath();ctx.moveTo(0,10);ctx.lineTo(0,-10);ctx.moveTo(-4,-4);ctx.lineTo(0,-10);ctx.lineTo(4,-4);
      ctx.strokeStyle='rgba(25,20,16,.85)';ctx.lineWidth=4;ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,.95)';ctx.lineWidth=1.7;ctx.stroke();ctx.restore();
    }
  }
  async function load(path,time){
    if(cache.has(path))return cache.get(path);
    if(pending.has(path))return pending.get(path);
    const work=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetch(path,{signal:controller.signal});
        if(!response.ok)throw Error('Wind direction grid unavailable');
        const grid=await response.json();if(!validate(grid,time))throw Error('Invalid forecast direction grid');
        cache.set(path,grid);while(cache.size>6)cache.delete(cache.keys().next().value);return grid;
      }finally{clearTimeout(timer);}
    })().finally(()=>pending.delete(path));pending.set(path,work);return work;
  }
  api.clear=clear;
  api.show=async(regions,time)=>{
    clear();const id=revision;
    const results=await Promise.allSettled(regions.map(async region=>{
      const path=asset(region,time);if(!path)return null;
      return {grid:await load(path,time),shift:region.longitude_shift||0,region:region.region};
    }));
    if(id!==revision)return;
    grids=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value)
      .sort((a,b)=>(a.region==='Nordics'?0:1)-(b.region==='Nordics'?0:1));
    canvas.dataset.forecastTime=new Date(time).toISOString();
    draw();
  };
  map.on('moveend resize zoomend',draw);
  document.addEventListener('country-focus-change',draw);
})(typeof window==='undefined'?{}:window);
