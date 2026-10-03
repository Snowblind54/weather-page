// Wind crosses coastlines: never apply the temperature layer's land mask.
const WIND_CACHE_KEY='balticWeatherWindV5';
const WIND_CACHE_MS=45*60*1000;
const WIND_GRIDS=[
  // Broad Atlantic grid, European detail, then the existing Baltic detail.
  {south:25,north:82,west:-85,east:42,rows:12,cols:25},
  {south:34,north:74,west:-15,east:42,rows:11,cols:17},
  {south:53,north:61,west:19,east:31,rows:9,cols:9}
];
let windData=null;
let windLoadPromise=null;
let windRetryAt=0;
let windLayer=null;
let windProbe=null;
let windPopup=null;

// Display bands in m/s; these are a visual scale, not warning thresholds.
const WIND_SPEED_BANDS=[
  {min:0,color:'#8fdcff',label:'0–3'},
  {min:3,color:'#45dfac',label:'3–6'},
  {min:6,color:'#f5e653',label:'6–10'},
  {min:10,color:'#ffad42',label:'10–15'},
  {min:15,color:'#ff585d',label:'15–25'},
  {min:25,color:'#bd75ff',label:'25+'}
];

const WIND_GUST_SPEED_BANDS=[
  ...WIND_SPEED_BANDS.slice(0,-1),
  {min:25,color:'#bd75ff',label:'25–33'},
  {min:33,color:'#ff52c8',label:'>33'}
];

function currentWindMode(){
  return $('windMode')?.value==='gust'?'gust':'sustained';
}

function windSpeedBand(speed,mode='sustained'){
  if(mode==='gust' && speed>33) return WIND_GUST_SPEED_BANDS.length-1;
  let index=0;
  while(index<WIND_SPEED_BANDS.length-1 && speed>=WIND_SPEED_BANDS[index+1].min) index++;
  return index;
}

function showWindLegend(){
  const legend=$('windLegend');
  if(!legend) return;
  const gustMode=currentWindMode()==='gust';
  const label=$('windLegendLabel');
  if(label) label.textContent=(gustMode?'Wind gust speed':'Sustained wind speed')+' · m/s';
  legend.innerHTML=(gustMode?WIND_GUST_SPEED_BANDS:WIND_SPEED_BANDS).map(band=>
    `<span class="wind-speed-key"><i style="background:${band.color}"></i>${band.label}</span>`
  ).join('');
}
showWindLegend();

function windPopupContent(point,unix){
  const slice=windTimeSlice(unix);
  const vector=windAt(point.lat,point.lng,slice);
  if(!vector) return '<div class="wind-popup"><b>Wind unavailable</b><p>No wind data for this location at the selected time.</p></div>';
  const speed=Math.hypot(...vector);
  const gust=windGustAt(point.lat,point.lng,slice);
  const mode=currentWindMode();
  const bands=mode==='gust'?WIND_GUST_SPEED_BANDS:WIND_SPEED_BANDS;
  const colourSpeed=mode==='gust'?gust:speed;
  const band=colourSpeed===null?{color:'#8a97a5'}:bands[windSpeedBand(colourSpeed,mode)];
  const bearing=(Math.atan2(-vector[0],-vector[1])*180/Math.PI+360)%360;
  const compass=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const direction=speed<0.1?'Calm':`From ${compass[Math.round(bearing/22.5)%16]} · ${Math.round(bearing)%360}°`;
  const lon=((point.lng+180)%360+360)%360-180;
  return `<div class="wind-popup">
    <div class="wind-popup-heading"><i style="background:${band.color}"></i>Wind at this point</div>
    <div class="wind-popup-readings">
      <div><div class="wind-popup-label">Sustained wind</div><div class="wind-popup-speed">${speed.toFixed(1)} <span>m/s</span></div></div>
      <div><div class="wind-popup-label">Wind gusts</div><div class="wind-popup-speed">${gust===null?'<span>Unavailable</span>':gust.toFixed(1)+' <span>m/s</span>'}</div></div>
    </div>
    <div>${direction}</div>
    <div class="wind-popup-meta">${point.lat.toFixed(3)}°, ${lon.toFixed(3)}°<br>${htmlEscape(fmt(unix))}</div>
    <div class="wind-popup-meta">10 m model wind · interpolated estimate</div>
    ${gust===null?'':`<div class="wind-popup-meta">Gust estimate for hour ending ${htmlEscape(fmt(windData.times[windGustHour(slice)]))}</div>`}
  </div>`;
}

function updateWindPopup(){
  if(!windPopup||!windProbe||!map.hasLayer(windPopup)) return;
  windPopup.setContent(windPopupContent(windProbe,selectedWindTime()));
}

map.on('click',event=>{
  if(!$('windOn').checked) return;
  // The rainfall popup includes both wind readings when both layers are on.
  if(typeof activeAccumulationHours==='function' && activeAccumulationHours()) return;
  // Keep warning polygons and station markers' existing click actions.
  if(event.originalEvent?.target?.closest?.('.leaflet-interactive,.leaflet-marker-icon,.leaflet-popup')) return;
  windProbe=event.latlng;
  if(!windPopup) windPopup=L.popup({maxWidth:280,className:'wind-popup-container',autoPan:false,keepInView:false});
  windPopup.setLatLng(windProbe).setContent(windPopupContent(windProbe,selectedWindTime())).openOn(map);
});

function windVector(speed,direction){
  if(!Number.isFinite(speed)||speed<0||!Number.isFinite(direction)) return null;
  // API bearings describe where wind comes FROM; particles travel the other way.
  const radians=direction*Math.PI/180;
  return [-speed*Math.sin(radians),-speed*Math.cos(radians)];
}

function windSample(speed,direction,gust){
  const vector=windVector(speed,direction);
  return vector?[...vector,Number.isFinite(gust)&&gust>=0?gust:null]:null;
}

function windPoints(grid){
  const points=[];
  for(let row=0;row<grid.rows;row++){
    for(let col=0;col<grid.cols;col++){
      points.push([
        grid.south+(grid.north-grid.south)*row/(grid.rows-1),
        grid.west+(grid.east-grid.west)*col/(grid.cols-1)
      ]);
    }
  }
  return points;
}

function validWindData(data){
  return data?.version===3 && Number.isFinite(data.savedAt) &&
    data.times?.length>=2 && data.times.every(Number.isFinite) &&
    data.times.every((time,i)=>i===0||time>data.times[i-1]) &&
    Array.isArray(data.grids) && data.grids.length===WIND_GRIDS.length &&
    data.grids.every((grid,i)=>grid.length===WIND_GRIDS[i].rows*WIND_GRIDS[i].cols &&
      grid.every(series=>Array.isArray(series)&&series.length===data.times.length &&
        series.every(v=>v===null||(Array.isArray(v)&&v.length===3&&
          Number.isFinite(v[0])&&Number.isFinite(v[1])&&
          (v[2]===null||(Number.isFinite(v[2])&&v[2]>=0))))));
}

function restoreWind(){
  try{
    const data=JSON.parse(localStorage.getItem(WIND_CACHE_KEY));
    if(validWindData(data) && Date.now()-data.savedAt<WIND_CACHE_MS) windData=data;
  }catch(e){ /* Storage is optional, including in private browsing. */ }
}
restoreWind();

async function fetchWindData(){
  const points=WIND_GRIDS.flatMap(windPoints);
  const series=[];
  let times=null;
  // Multi-location requests still count as individual locations at the provider.
  // 568 samples, short time range, no eager loading or concurrent burst.
  for(let offset=0;offset<points.length;offset+=50){
    if($('windOn').checked){$('windStatus').textContent='Loading Atlantic and European wind… '+Math.round(offset/points.length*100)+'%';}
    const batch=points.slice(offset,offset+50);
    const params=new URLSearchParams({
      latitude:batch.map(p=>p[0]).join(','),
      longitude:batch.map(p=>p[1]).join(','),
      hourly:'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      wind_speed_unit:'ms',timeformat:'unixtime',timezone:'UTC',
      past_hours:'4',forecast_hours:'3',cell_selection:'nearest'
    });
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),20000);
    let json;
    try{
      const response=await fetch('https://api.open-meteo.com/v1/forecast?'+params,{
        cache:'no-store',signal:controller.signal
      });
      if(response.status===429){
        windRetryAt=Date.now()+5*60*1000;
        throw new Error('Wind service is rate limited. Retrying in 5 minutes.');
      }
      if(!response.ok) throw new Error('Wind service HTTP '+response.status);
      json=await response.json();
    }finally{clearTimeout(timeout);}
    const items=Array.isArray(json)?json:[json];
    if(items.length!==batch.length) throw new Error('Incomplete wind grid returned.');
    for(const item of items){
      const hourly=item.hourly;
      if(!hourly||hourly.time.length<2) throw new Error('Wind hours are unavailable.');
      if(!times) times=hourly.time;
      if(JSON.stringify(times)!==JSON.stringify(hourly.time)) throw new Error('Wind grid hours do not match.');
      series.push(times.map((_,i)=>windSample(hourly.wind_speed_10m?.[i],hourly.wind_direction_10m?.[i],hourly.wind_gusts_10m?.[i])));
    }
  }
  let offset=0;
  const grids=WIND_GRIDS.map(grid=>{
    const count=grid.rows*grid.cols;
    const values=series.slice(offset,offset+count);
    offset+=count;
    return values;
  });
  const data={version:3,savedAt:Date.now(),times,grids};
  if(!validWindData(data)||!grids[0].some(s=>s.some(Boolean))) throw new Error('No usable wind data returned.');
  return data;
}

function selectedWindTime(){
  return frames[Number($('timeline').value)]?.time||Math.floor(Date.now()/1000);
}

function reportWindError(error){
  console.warn(error);
  if(!$('windOn').checked) return;
  const visible=renderWind(selectedWindTime());
  $('windStatus').textContent=(visible?'Showing cached wind. ':'Wind unavailable. ')+error.message;
  $('windStatus').className='status warn';
}

async function loadWind(){
  if(!$('windOn').checked) return;
  if(windData && Date.now()-windData.savedAt<WIND_CACHE_MS){
    renderWind(selectedWindTime());
    return;
  }
  if(Date.now()<windRetryAt) throw new Error('Wind service is cooling down. Please try again shortly.');
  renderWind(selectedWindTime());
  $('windStatus').textContent=windData?'Updating wind data…':'Loading wind over land and sea…';
  $('windStatus').className='status';
  if(!windLoadPromise){
    windLoadPromise=fetchWindData().then(data=>{
      windData=data;
      try{localStorage.setItem(WIND_CACHE_KEY,JSON.stringify(data));}catch(e){}
    }).catch(error=>{
      windRetryAt=Math.max(windRetryAt,Date.now()+60000);
      throw error;
    }).finally(()=>{windLoadPromise=null;});
  }
  // A disabled layer can finish caching but must never add itself back.
  await windLoadPromise;
  if($('windOn').checked) renderWind(selectedWindTime());
}

function windTimeSlice(unix){
  if(!windData||unix<windData.times[0]||unix>windData.times.at(-1)) return null;
  let i=0;
  while(i<windData.times.length-2 && windData.times[i+1]<unix) i++;
  return {i,f:(unix-windData.times[i])/(windData.times[i+1]-windData.times[i])};
}

function windGridWeights(grid,lat,lon){
    lon=((lon+180)%360+360)%360-180;
    if(lat<grid.south||lat>grid.north||lon<grid.west||lon>grid.east) return null;
    const x=(lon-grid.west)/(grid.east-grid.west)*(grid.cols-1);
    const y=(lat-grid.south)/(grid.north-grid.south)*(grid.rows-1);
    const col=Math.min(grid.cols-2,Math.floor(x));
    const row=Math.min(grid.rows-2,Math.floor(y));
    const fx=x-col,fy=y-row;
    const indices=[row*grid.cols+col,row*grid.cols+col+1,(row+1)*grid.cols+col,(row+1)*grid.cols+col+1];
    const weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
    return {indices,weights};
}

function windAt(lat,lon,slice){
  if(!slice) return null;
  // Prefer the finer Baltic grid; fall back to the continuous regional grid.
  for(let g=WIND_GRIDS.length-1;g>=0;g--){
    const cell=windGridWeights(WIND_GRIDS[g],lat,lon);
    if(!cell) continue;
    const {indices,weights}=cell;
    let u=0,v=0,valid=true;
    for(let n=0;n<4;n++){
      if(weights[n]===0) continue;
      const series=windData.grids[g][indices[n]];
      const a=series[slice.i],b=series[slice.i+1];
      if(!a||!b){valid=false;break;}
      u+=(a[0]*(1-slice.f)+b[0]*slice.f)*weights[n];
      v+=(a[1]*(1-slice.f)+b[1]*slice.f)*weights[n];
    }
    if(valid) return [u,v];
  }
  return null;
}

function windGustHour(slice){
  // Gusts are hourly maxima for the preceding hour, not instantaneous vectors.
  // Select the hour containing the map time; do not smooth away peaks in time.
  return slice.i+(slice.f>0?1:0);
}

function windGustAt(lat,lon,slice){
  if(!slice) return null;
  const hour=windGustHour(slice);
  for(let g=WIND_GRIDS.length-1;g>=0;g--){
    const cell=windGridWeights(WIND_GRIDS[g],lat,lon);
    if(!cell) continue;
    let gust=0,valid=true;
    for(let n=0;n<4;n++){
      if(cell.weights[n]===0) continue;
      const value=windData.grids[g][cell.indices[n]][hour]?.[2];
      if(!Number.isFinite(value)||value<0){valid=false;break;}
      gust+=value*cell.weights[n];
    }
    if(valid) return gust;
  }
  return null;
}

const WindCanvasLayer=L.Layer.extend({
  onAdd(mapInstance){
    this._map=mapInstance;
    if(!mapInstance.getPane('windPane')){
      mapInstance.createPane('windPane');
      mapInstance.getPane('windPane').style.zIndex='580';
      mapInstance.getPane('windPane').style.pointerEvents='none';
    }
    this.canvas=L.DomUtil.create('canvas','wind-canvas leaflet-zoom-hide',mapInstance.getPane('windPane'));
    this.canvas.setAttribute('aria-hidden','true');
    this.ctx=this.canvas.getContext('2d');
    mapInstance.on('movestart zoomstart',this.pause,this);
    mapInstance.on('moveend zoomend resize',this.reset,this);
    this.visibilityHandler=()=>document.hidden?this.pause():this.reset();
    document.addEventListener('visibilitychange',this.visibilityHandler);
    this.reset();
  },
  onRemove(mapInstance){
    this.pause();
    mapInstance.off('movestart zoomstart',this.pause,this);
    mapInstance.off('moveend zoomend resize',this.reset,this);
    document.removeEventListener('visibilitychange',this.visibilityHandler);
    this.canvas.remove();
    this._map=null;
  },
  setTime(unix){
    const mode=currentWindMode();
    if(this.unix===unix && this.data===windData && this.mode===mode) return;
    this.mode=mode;
    this.unix=unix;
    this.data=windData;
    if(this._map) this.reset();
  },
  pause(){
    if(this.raf) cancelAnimationFrame(this.raf);
    this.raf=null;
    if(this.canvas) this.canvas.style.visibility='hidden';
  },
  reset(){
    this.pause();
    if(!this._map||!this.ctx||document.hidden) return;
    const size=this._map.getSize();
    this.width=size.x;this.height=size.y;
    const dpr=Math.min(window.devicePixelRatio||1,2);
    this.canvas.width=Math.round(size.x*dpr);
    this.canvas.height=Math.round(size.y*dpr);
    this.canvas.style.width=size.x+'px';this.canvas.style.height=size.y+'px';
    L.DomUtil.setPosition(this.canvas,this._map.containerPointToLayerPoint([0,0]));
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
    const slice=windTimeSlice(this.unix);
    if(!slice) return;
    // Project the geographic field once per map/time change, not per particle.
    this.step=24;
    this.cols=Math.ceil(size.x/this.step)+1;
    this.rows=Math.ceil(size.y/this.step)+1;
    this.field=[];
    const seeds=[];
    for(let row=0;row<this.rows;row++){
      for(let col=0;col<this.cols;col++){
        const x=col*this.step,y=row*this.step;
        const ll=this._map.containerPointToLatLng([x,y]);
        let vector=windAt(ll.lat,ll.lng,slice);
        if(this.mode==='gust'){
          const gust=windGustAt(ll.lat,ll.lng,slice);
          // Gust magnitude is an hourly peak. Use modeled wind direction for
          // its animation; the gust API does not supply a separate direction.
          vector=vector && gust!==null && (Math.hypot(...vector)>0.01 || gust===0)
            ? [...vector,gust] : null;
        }
        this.field.push(vector);
        if(vector&&x<size.x&&y<size.y) seeds.push([x,y]);
      }
    }
    this.seeds=seeds;
    if(!seeds.length){
      $('windStatus').textContent='Pan between the eastern United States, Atlantic, Europe and Moscow to see wind.';
      $('windStatus').className='status';
      return;
    }
    const density=Number($('windDensity').value)/100;
    const count=Math.min(2400,Math.round(seeds.length*this.step*this.step/900*density));
    this.particles=Array.from({length:count},()=>this.seed(true));
    this.bands=this.mode==='gust'?WIND_GUST_SPEED_BANDS:WIND_SPEED_BANDS;
    this.segments=this.bands.map(()=>[]);
    this.canvas.style.visibility='visible';
    this.lastFrame=null;
    this.raf=requestAnimationFrame(t=>this.animate(t));
  },
  seed(randomAge=false){
    const p=this.seeds[Math.floor(Math.random()*this.seeds.length)];
    return {x:p[0]+Math.random()*this.step,y:p[1]+Math.random()*this.step,age:randomAge?Math.random()*3:0,life:2+Math.random()*3};
  },
  sample(x,y){
    if(x<0||y<0||x>=this.width||y>=this.height) return null;
    const col=Math.floor(x/this.step),row=Math.floor(y/this.step);
    const fx=x/this.step-col,fy=y/this.step-row;
    const indices=[row*this.cols+col,row*this.cols+col+1,(row+1)*this.cols+col,(row+1)*this.cols+col+1];
    const weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
    let u=0,v=0,gust=0;
    for(let i=0;i<4;i++){
      const vector=this.field[indices[i]];
      if(!vector) return null;
      u+=vector[0]*weights[i];v+=vector[1]*weights[i];
      if(this.mode==='gust') gust+=vector[2]*weights[i];
    }
    if(this.mode==='gust'){
      const sustained=Math.hypot(u,v);
      if(gust===0) return [0,0,0];
      if(sustained<=0.01) return null;
      return [u/sustained*gust,v/sustained*gust,gust];
    }
    return [u,v];
  },
  animate(t){
    this.raf=requestAnimationFrame(next=>this.animate(next));
    if(this.lastFrame!==null&&t-this.lastFrame<1000/30) return;
    const dt=this.lastFrame===null?1/30:Math.min((t-this.lastFrame)/1000,0.1);
    this.lastFrame=t;
    const ctx=this.ctx;
    ctx.globalCompositeOperation='destination-out';
    ctx.fillStyle=`rgba(0,0,0,${1-Math.exp(-dt*5.5)})`;
    ctx.fillRect(0,0,this.width,this.height);
    ctx.globalCompositeOperation='source-over';
    ctx.lineWidth=1.15;ctx.lineCap='round';
    ctx.shadowColor='rgba(0,25,40,0.8)';ctx.shadowBlur=1.5;
    for(const segments of this.segments) segments.length=0;
    for(let i=0;i<this.particles.length;i++){
      let p=this.particles[i];
      const vector=this.sample(p.x,p.y);
      p.age+=dt;
      if(!vector||p.age>p.life){this.particles[i]=this.seed();continue;}
      const speed=this.mode==='gust'?vector[2]:Math.hypot(...vector);
      // 6 screen pixels/second for each m/s. Mercator preserves local angles.
      const scale=dt*6*Math.min(1,45/Math.max(speed,0.01));
      const x=p.x+vector[0]*scale,y=p.y-vector[1]*scale;
      if(speed>0.1 && this.sample(x,y)){
        this.segments[windSpeedBand(speed,this.mode)].push(p.x,p.y,x,y);
      }
      p.x=x;p.y=y;
    }
    // One stroke per speed band rather than per particle keeps drawing cheap.
    for(let band=0;band<this.bands.length;band++){
      const segments=this.segments[band];
      if(!segments.length) continue;
      ctx.strokeStyle=this.bands[band].color;
      ctx.beginPath();
      for(let i=0;i<segments.length;i+=4){
        ctx.moveTo(segments[i],segments[i+1]);
        ctx.lineTo(segments[i+2],segments[i+3]);
      }
      ctx.stroke();
    }
    ctx.shadowBlur=0;
  }
});

function hideWind(){
  if(windLayer&&map.hasLayer(windLayer)) map.removeLayer(windLayer);
  if(windPopup&&map.hasLayer(windPopup)) map.removeLayer(windPopup);
  windProbe=null;
  $('windStatus').textContent='Wind layer is off.';
  $('windStatus').className='status';
}

function renderWind(unix){
  if(!$('windOn').checked) return false;
  showWindLegend();
  updateWindPopup();
  if(typeof updateAccumulationPopup==='function') updateAccumulationPopup();
  const slice=windTimeSlice(unix);
  if(!slice){
    if(windLayer&&map.hasLayer(windLayer)) map.removeLayer(windLayer);
    $('windStatus').textContent=windData?'Wind is unavailable for this time.':'Loading wind over land and sea…';
    $('windStatus').className='status';
    return false;
  }
  if(!windLayer) windLayer=new WindCanvasLayer();
  windLayer.setTime(unix);
  if(!map.hasLayer(windLayer)) windLayer.addTo(map);
  const covered=windLayer.seeds?.length;
  $('windStatus').textContent=covered
    ? `10 m model ${currentWindMode()==='gust'?'gusts · hourly peaks':'sustained wind'} · ${fmt(unix)} · land + sea`
    : 'Pan between the eastern United States, Atlantic, Europe and Moscow to see wind.';
  $('windStatus').className=covered?'status ok':'status';
  return true;
}
