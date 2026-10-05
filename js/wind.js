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
let windHeatmapLayer=null;
let windProbe=null;
let windPopup=null;

// Continuous colour stops in m/s; these are visual anchors, not alert levels.
const WIND_COLOUR_STOPS=[
  {speed:0,color:'#8fdcff'}, {speed:3,color:'#45dfac'},
  {speed:6,color:'#f5e653'}, {speed:10,color:'#ffad42'},
  {speed:15,color:'#ff585d'}, {speed:25,color:'#bd75ff'},
  // Extreme winds brighten rapidly beyond purple and reach pure white at 34 m/s.
  {speed:28,color:'#dc7dff'}, {speed:31,color:'#ff72e6'},
  {speed:33,color:'#ffd4f6'}, {speed:34,color:'#ffffff'}
];
const WIND_GUST_COLOUR_STOPS=WIND_COLOUR_STOPS;
const WIND_COLOUR_STEP=.5,WIND_COLOUR_MAX=50;
function currentWindMode(){return $('windMode')?.value==='gust'?'gust':'sustained';}
function windVisualEnabled(){return !!($('windOn')?.checked||$('windHeatmapOn')?.checked);}
function windColour(speed,mode='sustained'){
  if(!Number.isFinite(speed))return '#8a97a5';
  const stops=mode==='gust'?WIND_GUST_COLOUR_STOPS:WIND_COLOUR_STOPS;
  speed=Math.max(0,speed);
  if(speed>=stops.at(-1).speed)return stops.at(-1).color;
  const index=stops.findIndex((stop,i)=>i>0 && speed<=stop.speed);
  const a=stops[index-1],b=stops[index],f=(speed-a.speed)/(b.speed-a.speed);
  const channel=(colour,offset)=>parseInt(colour.slice(offset,offset+2),16);
  return '#'+[1,3,5].map(offset=>Math.round(channel(a.color,offset)+(channel(b.color,offset)-channel(a.color,offset))*f).toString(16).padStart(2,'0')).join('');
}
function windColourIndex(speed){return Math.round(Math.max(0,Math.min(WIND_COLOUR_MAX,speed))/WIND_COLOUR_STEP);}
const WIND_COLOUR_PALETTES=Object.fromEntries(['sustained','gust'].map(mode=>[
  mode,Array.from({length:WIND_COLOUR_MAX/WIND_COLOUR_STEP+1},(_,i)=>windColour(i*WIND_COLOUR_STEP,mode))
]));
function showWindLegend(){
  const legend=$('windLegend');if(!legend)return;
  const mode=currentWindMode(),gust=mode==='gust',max=34;
  const stops=gust?WIND_GUST_COLOUR_STOPS:WIND_COLOUR_STOPS;
  $('windLegendLabel').textContent=(gust?'Wind gust speed':'Sustained wind speed')+' · m/s';
  const gradient=stops.map(s=>s.color+' '+s.speed/max*100+'%').join(',');
  const ticks=[0,5,10,15,20,25,30,34];
  legend.innerHTML='<div class="wind-gradient" style="background:linear-gradient(90deg,'+gradient+')"></div><div class="wind-gradient-ticks">'+ticks.map(speed=>'<span style="left:'+speed/max*100+'%">'+speed+(speed===max?'+':'')+'</span>').join('')+'</div>';
}
showWindLegend();

function windPopupContent(point,unix){
  const slice=windTimeSlice(unix);
  const vector=windAt(point.lat,point.lng,slice);
  if(!vector) return '<div class="wind-popup"><b>Wind unavailable</b><p>No wind data for this location at the selected time.</p></div>';
  const speed=Math.hypot(vector[0],vector[1]);
  const gust=windGustAt(point.lat,point.lng,slice);
  const mode=currentWindMode();
  const colourSpeed=mode==='gust'?gust:speed;
  const colour=windColour(colourSpeed,mode);
  const bearing=(Math.atan2(-vector[0],-vector[1])*180/Math.PI+360)%360;
  const compass=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const direction=speed<0.1?'Calm':`From ${compass[Math.round(bearing/22.5)%16]} · ${Math.round(bearing)%360}°`;
  const lon=((point.lng+180)%360+360)%360-180;
  return `<div class="wind-popup">
    <div class="wind-popup-heading"><i style="background:${colour}"></i>Wind at this point</div>
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
  if(!windVisualEnabled()) return;
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
  if(!windVisualEnabled()) return;
  if(windData && Date.now()-windData.savedAt<WIND_CACHE_MS){
    if($('windOn').checked) renderWind(selectedWindTime());
    if($('windHeatmapOn').checked) renderWindHeatmap(selectedWindTime());
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
  if($('windHeatmapOn').checked) renderWindHeatmap(selectedWindTime());
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
    mapInstance.on('moveend zoomend resize',this.scheduleReset,this);
    this.visibilityHandler=()=>document.hidden?this.pause():this.reset();
    document.addEventListener('visibilitychange',this.visibilityHandler);
    this.reset();
  },
  onRemove(mapInstance){
    this.pause();
    mapInstance.off('movestart zoomstart',this.pause,this);
    mapInstance.off('moveend zoomend resize',this.scheduleReset,this);
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
    if(this._map) this.scheduleReset();
  },
  scheduleReset(){
    if(this.resetRaf) return;
    this.resetRaf=requestAnimationFrame(()=>{this.resetRaf=null;this.reset();});
  },
  pause(){
    if(this.resetRaf) cancelAnimationFrame(this.resetRaf);
    this.resetRaf=null;
    if(this.raf) cancelAnimationFrame(this.raf);
    this.raf=null;
    if(this.canvas) this.canvas.style.visibility='hidden';
  },
  reset(){
    this.pause();
    if(!this._map||!this.ctx||document.hidden) return;
    const size=this._map.getSize();
    this.width=size.x;this.height=size.y;
    // Large desktop canvases cost far more to fade and redraw than phone canvases.
    // Render the animation at CSS-pixel resolution once the viewport is large;
    // smaller screens can keep a modest DPR boost without a meaningful cost.
    const area=size.x*size.y;
    const dpr=area>=900000?1:Math.min(window.devicePixelRatio||1,1.25);
    const pixelWidth=Math.round(size.x*dpr),pixelHeight=Math.round(size.y*dpr);
    if(this.canvas.width!==pixelWidth) this.canvas.width=pixelWidth;
    if(this.canvas.height!==pixelHeight) this.canvas.height=pixelHeight;
    this.canvas.style.width=size.x+'px';this.canvas.style.height=size.y+'px';
    L.DomUtil.setPosition(this.canvas,this._map.containerPointToLayerPoint([0,0]));
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
    this.ctx.clearRect(0,0,size.x,size.y);
    const slice=windTimeSlice(this.unix);
    if(!slice) return;
    // Project the geographic field once per map/time change, not per particle.
    this.step=24;
    this.cols=Math.ceil(size.x/this.step)+1;
    this.rows=Math.ceil(size.y/this.step)+1;
    const origin=this._map.containerPointToLatLng([0,0]);
    const fieldKey=[size.x,size.y,this._map.getZoom(),origin.lat,origin.lng,this.unix,this.mode].join('/');
    if(this.fieldKey!==fieldKey || this.fieldData!==windData){
      this.field=[];this.seeds=[];
      for(let row=0;row<this.rows;row++){
        for(let col=0;col<this.cols;col++){
          const x=col*this.step,y=row*this.step;
          const ll=this._map.containerPointToLatLng([x,y]);
          let vector=windAt(ll.lat,ll.lng,slice);
          if(this.mode==='gust'){
            const gust=windGustAt(ll.lat,ll.lng,slice);
            // Gust magnitude is an hourly peak; use modeled wind direction.
            vector=vector && gust!==null && (Math.hypot(vector[0],vector[1])>0.01 || gust===0)
              ? [vector[0],vector[1],gust] : null;
          }
          this.field.push(vector);
          if(vector&&x<size.x&&y<size.y) this.seeds.push([x,y]);
        }
      }
      this.fieldKey=fieldKey;this.fieldData=windData;
    }
    const seeds=this.seeds;
    if(!seeds.length){
      $('windStatus').textContent='Pan between the eastern United States, Atlantic, Europe and Moscow to see wind.';
      $('windStatus').className='status';
      return;
    }
    const density=Number($('windDensity').value)/100;
    // Particle cost also scales with viewport area. Phones keep the previous
    // density, while large desktop views use a tighter ceiling so 1080p/1440p
    // screens can hold 30 fps instead of spending the frame budget on >1600 trails.
    const particleTarget=Math.round(seeds.length*this.step*this.step/900*density);
    const particleCap=area>=900000?Math.min(1050,Math.round(area/1700)):1200;
    const count=Math.max(80,Math.min(particleCap,particleTarget));
    this.particles=Array.from({length:count},()=>this.seed(true));
    this.colours=WIND_COLOUR_PALETTES[this.mode];
    this.segments=this.colours.map(()=>[]);
    this.canvas.style.visibility='visible';
    this.lastFrame=null;this.nextFrameAt=null;
    this.sampleVector=[0,0,0];
    this.raf=requestAnimationFrame(t=>this.animate(t));
  },
  seed(randomAge=false,particle={}){
    const p=this.seeds[Math.floor(Math.random()*this.seeds.length)];
    particle.x=p[0]+Math.random()*this.step;particle.y=p[1]+Math.random()*this.step;
    particle.age=randomAge?Math.random()*3:0;particle.life=2+Math.random()*3;
    return particle;
  },
  sample(x,y,out){
    if(x<0||y<0||x>=this.width||y>=this.height) return null;
    const gx=x/this.step,gy=y/this.step,col=Math.floor(gx),row=Math.floor(gy);
    const fx=gx-col,fy=gy-row,index=row*this.cols+col;
    const a=this.field[index],b=this.field[index+1],c=this.field[index+this.cols],d=this.field[index+this.cols+1];
    if(!a||!b||!c||!d) return null;
    const wa=(1-fx)*(1-fy),wb=fx*(1-fy),wc=(1-fx)*fy,wd=fx*fy;
    let u=a[0]*wa+b[0]*wb+c[0]*wc+d[0]*wd,v=a[1]*wa+b[1]*wb+c[1]*wc+d[1]*wd;
    let speed=0;
    if(this.mode==='gust'){
      speed=a[2]*wa+b[2]*wb+c[2]*wc+d[2]*wd;
      const sustained=Math.hypot(u,v);
      if(speed===0){u=0;v=0;}
      else if(sustained<=0.01) return null;
      else{u=u/sustained*speed;v=v/sustained*speed;}
    }
    out=out||[0,0,0];out[0]=u;out[1]=v;out[2]=speed;
    return out;
  },
  validPoint(x,y){
    if(x<0||y<0||x>=this.width||y>=this.height)return false;
    const index=Math.floor(y/this.step)*this.cols+Math.floor(x/this.step);
    return !!(this.field[index]&&this.field[index+1]&&this.field[index+this.cols]&&this.field[index+this.cols+1]);
  },
  animate(t){
    this.raf=requestAnimationFrame(next=>this.animate(next));
    const interval=1000/30;
    // Keep a target clock: rounded browser timestamps otherwise skip valid
    // frames at 60 Hz and make a nominal 30 fps animation run at about 20 fps.
    if(this.nextFrameAt!=null&&t+0.5<this.nextFrameAt) return;
    this.nextFrameAt=(this.nextFrameAt??t)+interval;
    if(this.nextFrameAt<=t) this.nextFrameAt=t+interval;
    const dt=this.lastFrame===null?1/30:Math.min((t-this.lastFrame)/1000,0.1);
    this.lastFrame=t;
    const ctx=this.ctx;
    ctx.globalCompositeOperation='destination-out';
    ctx.fillStyle=`rgba(0,0,0,${1-Math.exp(-dt*5.5)})`;
    ctx.fillRect(0,0,this.width,this.height);
    ctx.globalCompositeOperation='source-over';
    ctx.lineWidth=1.15;ctx.lineCap='round';
    // Blurred shadows multiply the cost of gradient strokes on large canvases.
    ctx.shadowBlur=0;
    for(const segments of this.segments) segments.length=0;
    for(let i=0;i<this.particles.length;i++){
      let p=this.particles[i];
      const vector=this.sample(p.x,p.y,this.sampleVector||(this.sampleVector=[0,0,0]));
      p.age+=dt;
      if(!vector||p.age>p.life){this.seed(false,p);continue;}
      const speed=this.mode==='gust'?vector[2]:Math.hypot(vector[0],vector[1]);
      // 6 screen pixels/second for each m/s. Mercator preserves local angles.
      const scale=dt*6*Math.min(1,45/Math.max(speed,0.01));
      const x=p.x+vector[0]*scale,y=p.y-vector[1]*scale;
      if(speed>0.1 && this.validPoint(x,y)){
        this.segments[windColourIndex(speed)].push(p.x,p.y,x,y);
      }
      p.x=x;p.y=y;
    }
    // Fine colour buckets keep the gradient smooth without a stroke per particle.
    for(let band=0;band<this.colours.length;band++){
      const segments=this.segments[band];
      if(!segments.length) continue;
      ctx.strokeStyle=this.colours[band];
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

function windHeatmapCorrections(unix,slice,mode){
  const blend=globalThis.WindObservationBlend;
  if(!blend||typeof officialWindData==='undefined'||!officialWindData||typeof officialWindReading!=='function')return [];
  const target=Math.min(unix,Date.now()/1000),corrections=[];
  for(const station of officialWindData.stations){
    const reading=officialWindReading(station,unix);if(!reading)continue;
    const observed=mode==='gust'?reading[2]:reading[1];if(!Number.isFinite(observed))continue;
    const vector=windAt(station.lat,station.lon,slice);
    const model=mode==='gust'?windGustAt(station.lat,station.lon,slice):(vector?Math.hypot(vector[0],vector[1]):null);
    const correction=blend.makeCorrection(station.lat,station.lon,observed,model,Math.max(0,target-reading[0]));
    if(correction)corrections.push(correction);
  }
  return corrections;
}
function windHeatmapCorrectionIndex(corrections){
  const cell=2,bins=new Map();
  for(const correction of corrections){
    const lon=((correction.lon+180)%360+360)%360-180;
    const key=Math.floor(correction.lat/cell)+','+Math.floor(lon/cell);
    if(!bins.has(key))bins.set(key,[]);bins.get(key).push(correction);
  }
  return {cell,bins,count:corrections.length};
}
function windHeatmapNearbyCorrections(index,lat,lon){
  if(!index?.count)return [];
  lon=((lon+180)%360+360)%360-180;
  const cy=Math.floor(lat/index.cell),cx=Math.floor(lon/index.cell),out=[];
  for(let dy=-1;dy<=1;dy++)for(let dx=-2;dx<=2;dx++){
    const rows=index.bins.get((cy+dy)+','+(cx+dx));if(rows)out.push(...rows);
  }
  return out;
}

const WindHeatmapLayer=L.Layer.extend({
  onAdd(mapInstance){
    this._map=mapInstance;
    if(!mapInstance.getPane('windHeatmapPane')){
      mapInstance.createPane('windHeatmapPane');
      mapInstance.getPane('windHeatmapPane').style.zIndex='570';
      mapInstance.getPane('windHeatmapPane').style.pointerEvents='none';
    }
    this.canvas=L.DomUtil.create('canvas','wind-heatmap-canvas leaflet-zoom-hide',mapInstance.getPane('windHeatmapPane'));
    this.canvas.setAttribute('aria-hidden','true');
    this.ctx=this.canvas.getContext('2d');
    mapInstance.on('moveend zoomend resize',this.scheduleReset,this);
    this.reset();
  },
  onRemove(mapInstance){
    mapInstance.off('moveend zoomend resize',this.scheduleReset,this);
    if(this.resetRaf)cancelAnimationFrame(this.resetRaf);
    this.canvas?.remove();this._map=null;
  },
  setTime(unix){
    const mode=currentWindMode();
    const observations=typeof officialWindData!=='undefined'&&officialWindData?officialWindData.generatedAt:0;
    if(this.unix===unix&&this.data===windData&&this.mode===mode&&this.observations===observations)return;
    this.unix=unix;this.data=windData;this.mode=mode;this.observations=observations;
    if(this._map)this.scheduleReset();
  },
  setOpacity(value){if(this.canvas)this.canvas.style.opacity=String(value);},
  scheduleReset(){
    if(this.resetRaf)return;
    this.resetRaf=requestAnimationFrame(()=>{this.resetRaf=null;this.reset();});
  },
  reset(){
    if(!this._map||!this.ctx||!windData)return;
    const slice=windTimeSlice(this.unix);if(!slice)return;
    const size=this._map.getSize(),area=size.x*size.y;
    this.canvas.width=Math.max(1,size.x);this.canvas.height=Math.max(1,size.y);
    this.canvas.style.width=size.x+'px';this.canvas.style.height=size.y+'px';
    this.canvas.style.opacity=String(Number($('windHeatmapOpacity').value)/100);
    L.DomUtil.setPosition(this.canvas,this._map.containerPointToLayerPoint([0,0]));
    const step=area>=1500000?32:area>=900000?28:24;
    // Anchor samples to fixed Web-Mercator world pixels instead of the viewport.
    // Panning now reveals the same wind field rather than resampling at new
    // geographic points every time the screen origin changes.
    const zoom=this._map.getZoom();
    const topLeft=this._map.project(this._map.containerPointToLatLng([0,0]),zoom);
    const anchorX=Math.floor(topLeft.x/step)*step,anchorY=Math.floor(topLeft.y/step)*step;
    const startX=anchorX-topLeft.x,startY=anchorY-topLeft.y;
    const cols=Math.ceil((size.x-startX)/step)+2,rows=Math.ceil((size.y-startY)/step)+2;
    const low=document.createElement('canvas');low.width=cols;low.height=rows;
    const lowCtx=low.getContext('2d'),img=lowCtx.createImageData(cols,rows),palette=WIND_COLOUR_PALETTES[this.mode];
    const rgb=palette.map(hex=>[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]);
    const corrections=windHeatmapCorrections(this.unix,slice,this.mode);
    const correctionIndex=windHeatmapCorrectionIndex(corrections);
    let shown=0;
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const world=L.point(anchorX+col*step,anchorY+row*step),ll=this._map.unproject(world,zoom);
      const vector=windAt(ll.lat,ll.lng,slice);
      let speed=null;
      if(vector) speed=this.mode==='gust'?windGustAt(ll.lat,ll.lng,slice):Math.hypot(vector[0],vector[1]);
      if(!Number.isFinite(speed))continue;
      const nearby=windHeatmapNearbyCorrections(correctionIndex,ll.lat,ll.lng);
      if(nearby.length&&globalThis.WindObservationBlend) speed=globalThis.WindObservationBlend.adjustSpeed(speed,ll.lat,ll.lng,nearby);
      const c=rgb[windColourIndex(speed)],i=(row*cols+col)*4;
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=230;shown++;
    }
    lowCtx.putImageData(img,0,0);
    this.ctx.clearRect(0,0,size.x,size.y);
    this.ctx.imageSmoothingEnabled=true;this.ctx.imageSmoothingQuality='high';
    // Source pixel centres line up with the anchored sample coordinates.
    this.ctx.drawImage(low,0,0,cols,rows,startX-step/2,startY-step/2,cols*step,rows*step);
    const source=corrections.length?`model + ${corrections.length} fresh official readings`:'model field';
    $('windHeatmapStatus').textContent=shown?`${this.mode==='gust'?'Gust':'Sustained wind'} heatmap · ${source} · ${fmt(this.unix)}`:'Wind heatmap unavailable in this view.';
  }
});

function hideWindHeatmap(){
  if(windHeatmapLayer&&map.hasLayer(windHeatmapLayer))map.removeLayer(windHeatmapLayer);
  $('windHeatmapStatus').textContent='Wind heatmap is off.';
}
function renderWindHeatmap(unix){
  if(!$('windHeatmapOn').checked)return false;
  const slice=windTimeSlice(unix);
  if(!slice){hideWindHeatmap();$('windHeatmapStatus').textContent=windData?'Wind heatmap is unavailable for this time.':'Loading wind heatmap…';return false;}
  if(!windHeatmapLayer)windHeatmapLayer=new WindHeatmapLayer();
  windHeatmapLayer.setTime(unix);
  if(!map.hasLayer(windHeatmapLayer))windHeatmapLayer.addTo(map);
  windHeatmapLayer.setOpacity(Number($('windHeatmapOpacity').value)/100);
  return true;
}

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
