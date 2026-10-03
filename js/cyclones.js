// Closed low-pressure centres derived from a consistent NOAA GFS forecast run.
let cycloneData=null,cycloneLoadPromise=null,cycloneLoadedAt=0,cycloneRetryAt=0,cycloneRefreshFailed=false;
let cycloneMarkerGroup=null,cyclonePathGroup=null,cycloneHistoryGroup=null,cyclonePopup=null,cycloneProbeId=null;
let cyclonePlaying=false,cyclonePlayTimer=null,cycloneTrackTime=null;
const cycloneMarkers=new Map();
map.createPane('cyclonePathsPane');map.getPane('cyclonePathsPane').style.zIndex='610';
map.createPane('cyclonePane');map.getPane('cyclonePane').style.zIndex='645';
map.getPane('cyclonePathsPane').style.pointerEvents='none';

function validateCyclones(data){
  const now=Date.now()/1000;
  if(data?.version!==1 || !Number.isFinite(data.modelRun) || data.modelRun>now+300 ||
    !Number.isFinite(data.generatedAt) || data.generatedAt>now+300 ||
    !Number.isFinite(data.forecastEnd) || data.forecastEnd<=data.modelRun ||
    !Array.isArray(data.systems) || data.systems.length>150) throw new Error('Invalid cyclone snapshot');
  const ids=new Set();
  for(const system of data.systems){
    if(typeof system.id!=='string' || ids.has(system.id) || !Array.isArray(system.points) || system.points.length<4) throw new Error('Invalid cyclone track');
    ids.add(system.id);
    if(system.nhc && (!Number.isFinite(system.nhc.issuedAt) || ['pressure','windMS','movementKMH'].some(k=>!Number.isFinite(system.nhc[k])))) throw new Error('Invalid cyclone advisory');
    system.points.forEach((p,i)=>{
      if(!Number.isFinite(p.time)||p.time<data.modelRun||p.time>data.forecastEnd||
        (i&&p.time<=system.points[i-1].time)||!Number.isFinite(p.lat)||p.lat<20||p.lat>82||
        !Number.isFinite(p.lon)||p.lon< -85||p.lon>45||!Number.isFinite(p.pressure)||p.pressure<850||p.pressure>1100||
        ['nearbyWind','nearbyGust'].some(k=>p[k]!=null&&(!Number.isFinite(p[k])||p[k]<0||p[k]>150))) throw new Error('Invalid cyclone point');
    });
    if(system.history!=null){
      if(!Array.isArray(system.history)||system.history.length>200)throw new Error('Invalid cyclone history');
      system.history.forEach((p,i)=>{
        if(!Number.isFinite(p.time)||p.time>data.generatedAt||p.time<data.generatedAt-73*3600||
          (i&&p.time<=system.history[i-1].time)||!Number.isFinite(p.lat)||p.lat<20||p.lat>82||
          !Number.isFinite(p.lon)||p.lon< -85||p.lon>45||!Number.isFinite(p.pressure)||p.pressure<850||p.pressure>1100)
          throw new Error('Invalid cyclone history point');
      });
    }

  }
  return data;
}

function cycloneVisiblePosition(point){
  return point && point.lon>=-80&&point.lon<=40&&point.lat>=25&&point.lat<=78&&(point.lon< -12||point.lat>=45);
}

function cycloneDistance(a,b){
  const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;
  return 6371*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2)));
}

function cycloneBearing(a,b){
  const rad=Math.PI/180,dlon=(b.lon-a.lon)*rad;
  const angle=Math.atan2(Math.sin(dlon)*Math.cos(b.lat*rad),Math.cos(a.lat*rad)*Math.sin(b.lat*rad)-Math.sin(a.lat*rad)*Math.cos(b.lat*rad)*Math.cos(dlon));
  return (angle/rad+360)%360;
}

function cyclonePointAt(system,unix){
  const points=system.points;
  if(!points.length || unix<points[0].time || unix>points.at(-1).time) return null;
  let a=points[0],b=points[1];
  for(let i=1;i<points.length;i++){
    a=points[i-1];b=points[i];if(unix<=b.time)break;
  }
  if(b.time-a.time>6*3600) return null;
  const f=(unix-a.time)/(b.time-a.time),point={time:unix};
  for(const field of ['lat','lon','pressure','nearbyWind','nearbyGust']) point[field]=Number.isFinite(a[field])&&Number.isFinite(b[field])?a[field]+(b[field]-a[field])*f:null;
  point.speed=cycloneDistance(a,b)/((b.time-a.time)/3600);
  point.bearing=point.speed<1?null:cycloneBearing(a,b);
  return point;
}

function cycloneTrackStart(){return cycloneTrackTime??(cycloneTrackTime=Math.floor(Date.now()/1000));}
function cycloneSelectedTime(){return cycloneTrackStart()+Number($('cycloneForecastHour').value)*3600;}
function cycloneUsable(){return cycloneData && Date.now()/1000-cycloneData.modelRun<=18*3600 && cycloneSelectedTime()<=cycloneData.forecastEnd;}
function cycloneColour(pressure){return pressure<970?'#cc83ff':pressure<985?'#ff6976':pressure<1000?'#ffc65b':'#7ddcff';}
function cycloneName(system){return system.name||'Unnamed low-pressure system';}

function cycloneIcon(system,point){
  const colour=cycloneColour(point.pressure);
  // Rotation indicates cyclonic circulation; its animation rate is decorative.
  const svg='<svg class="cyclone-spin" viewBox="0 0 48 48" aria-hidden="true"><path d="M25 8C13 8 5 19 11 30c3 5 9 7 15 6-12 0-13-15-5-18 6-2 12 3 10 8 8-9 4-23-8-25"/><path d="M23 40c12 0 20-11 14-22-3-5-9-7-15-6 12 0 13 15 5 18-6 2-12-3-10-8-8 9-4 23 8 25"/><circle cx="24" cy="24" r="4"/></svg>';
  return L.divIcon({className:'cyclone-marker',iconSize:[62,62],iconAnchor:[31,31],
    html:'<div class="cyclone-symbol" style="--cyclone-colour:'+colour+'">'+svg+
      '<span class="cyclone-pressure">'+Math.round(point.pressure)+' hPa</span></div>'});
}

function cyclonePopupContent(system,point){
  const direction=point.bearing==null?'Almost stationary':['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(point.bearing/22.5)%16]+' · '+Math.round(point.bearing)+'°';
  const before=cyclonePointAt(system,point.time-6*3600);
  const change=before?point.pressure-before.pressure:null;
  const pressureChange=change==null?'Unavailable':(change>=0?'+':'')+change.toFixed(1)+' hPa / 6 h';
  const end=Math.min(point.time+48*3600,system.points.at(-1).time);
  const nhc=system.nhc;
  const official=nhc?'<div class="cyclone-advisory"><b>Latest NHC advisory · '+htmlEscape(fmt(nhc.issuedAt))+'</b><br>'+htmlEscape(nhc.classification)+
    ' · '+nhc.pressure.toFixed(0)+' hPa · sustained wind '+nhc.windMS.toFixed(1)+' m/s<br>Moving '+nhc.movementKMH.toFixed(1)+' km/h'+
    (typeof nhc.url==='string'&&nhc.url.startsWith('https://www.nhc.noaa.gov/')?' · <a href="'+htmlEscape(nhc.url)+'" target="_blank" rel="noopener">Official advisory</a>':'')+'</div>':'';
  return '<div class="cyclone-popup"><b>'+htmlEscape(cycloneName(system))+'</b><div class="small">'+htmlEscape(system.id)+
    (system.name?' · name matched to NHC':' · no official name available')+'</div><div class="cyclone-readings">'+
    '<div><span>Centre pressure</span><strong>'+point.pressure.toFixed(1)+' hPa</strong></div>'+
    '<div><span>Moving speed</span><strong>'+point.speed.toFixed(1)+' km/h <small>('+ (point.speed/3.6).toFixed(1)+' m/s)</small></strong></div>'+
    '<div><span>Moving towards</span><strong>'+direction+'</strong></div>'+
    '<div><span>Pressure change</span><strong>'+pressureChange+'</strong></div>'+
    '<div><span>Highest model wind within 200 km</span><strong>'+(point.nearbyWind==null?'Unavailable':point.nearbyWind.toFixed(1)+' m/s')+'</strong><small>10 m wind; excludes gusts</small></div>'+
    '<div><span>Highest model gust within 200 km</span><strong>'+(point.nearbyGust==null?'Unavailable':point.nearbyGust.toFixed(1)+' m/s')+'</strong><small>GFS surface gust estimate</small></div></div>'+
    '<div class="cyclone-meta">Position: '+point.lat.toFixed(2)+'°, '+point.lon.toFixed(2)+'°<br>Valid: '+htmlEscape(fmt(point.time))+
    '<br>Model run: '+htmlEscape(fmt(cycloneData.modelRun))+'<br>Track available until '+htmlEscape(fmt(end))+
    '<br>NOAA / NCEP GFS 0.5° · derived centre and forecast track. Forecast uncertainty grows with time. Symbol rotation is illustrative.</div>'+official+'</div>';
}

function closeCyclonePopup(){
  if(cyclonePopup && map.hasLayer(cyclonePopup))map.removeLayer(cyclonePopup);
  cycloneProbeId=null;
}
function openCyclonePopup(system){
  const point=cyclonePointAt(system,cycloneSelectedTime());if(!point)return;
  cycloneProbeId=system.id;
  if(!cyclonePopup)cyclonePopup=L.popup({className:'cyclone-popup-container',maxWidth:345,autoPan:false,keepInView:false});
  cyclonePopup.setLatLng([point.lat,point.lon]).setContent(cyclonePopupContent(system,point)).openOn(map);
}

function renderCyclonePaths(){
  const unix=cycloneTrackStart();
  if(cyclonePathGroup){map.removeLayer(cyclonePathGroup);cyclonePathGroup=null;}
  if(!$('cyclonePathsOn').checked || !cycloneUsable())return;
  const layers=[];
  for(const system of cycloneData.systems){
    const current=cyclonePointAt(system,unix);
    if(!cycloneVisiblePosition(current))continue;
    const end=Math.min(unix+48*3600,system.points.at(-1).time);
    const points=[current,...system.points.filter(p=>p.time>unix&&p.time<end)];
    const endpoint=cyclonePointAt(system,end);if(endpoint&&end>unix)points.push(endpoint);
    // Split any association gap; don't draw an invented path across a break.
    const pieces=[];let piece=[points[0]];
    for(let i=1;i<points.length;i++){
      if(points[i].time-points[i-1].time>6*3600){if(piece.length>1)pieces.push(piece);piece=[];}
      piece.push(points[i]);
    }
    if(piece.length>1)pieces.push(piece);
    for(const part of pieces)layers.push(L.polyline(part.map(p=>[p.lat,p.lon]),{pane:'cyclonePathsPane',color:cycloneColour(current.pressure),weight:2.5,dashArray:'7 7',opacity:.9,interactive:false}));
    for(const h of [12,24,36,48]){
      const t=unix+h*3600,p=cyclonePointAt(system,t);if(!p||t>end)continue;
      layers.push(L.circleMarker([p.lat,p.lon],{pane:'cyclonePathsPane',radius:3,weight:1,color:'#fff',fillColor:cycloneColour(p.pressure),fillOpacity:1,interactive:false}));
      layers.push(L.marker([p.lat,p.lon],{pane:'cyclonePathsPane',interactive:false,keyboard:false,
        icon:L.divIcon({className:'cyclone-track-label',html:'+'+h+' h',iconSize:[42,18],iconAnchor:[-5,9]})}));
    }
  }
  cyclonePathGroup=L.layerGroup(layers).addTo(map);
}

function renderCycloneHistory(){
  if(cycloneHistoryGroup){map.removeLayer(cycloneHistoryGroup);cycloneHistoryGroup=null;}
  if(!$('cycloneHistoryOn').checked || !cycloneUsable())return;
  const now=Math.floor(Date.now()/1000),layers=[];
  for(const system of cycloneData.systems){
    // History is tied to actual clock time, even while viewing a future forecast.
    const current=cyclonePointAt(system,now);
    if(!cycloneVisiblePosition(current))continue;
    const byTime=new Map();
    for(const point of [...(system.history||[]),...system.points]){
      if(point.time>=now-48*3600 && point.time<=now)byTime.set(point.time,point);
    }
    byTime.set(now,current);
    const points=[...byTime.values()].sort((a,b)=>a.time-b.time);
    const pieces=[];let piece=[];
    for(const point of points){
      if(piece.length && point.time-piece.at(-1).time>6*3600){if(piece.length>1)pieces.push(piece);piece=[];}
      piece.push(point);
    }
    if(piece.length>1)pieces.push(piece);
    for(const part of pieces)layers.push(L.polyline(part.map(p=>[p.lat,p.lon]),{
      pane:'cyclonePathsPane',color:cycloneColour(current.pressure),weight:3,opacity:.75,interactive:false}));
  }
  cycloneHistoryGroup=L.layerGroup(layers).addTo(map);
}

function renderCyclones(){
  if(!$('cycloneOn').checked)return;
  const hour=Number($('cycloneForecastHour').value),unix=cycloneSelectedTime();
  $('cycloneTimeLabel').textContent=(hour?'+'+hour+' h · ':'Now · ')+fmt(unix);
  if(!cycloneUsable()){
    stopCyclonePlayback();hideCycloneLayers();$('cycloneStatus').textContent='Cyclone forecast is unavailable or too old. Refresh to load a recent model run.';
    $('cycloneStatus').className='status warn';return;
  }
  if(!cycloneMarkerGroup)cycloneMarkerGroup=L.layerGroup().addTo(map);
  const shown=new Set();
  for(const system of cycloneData.systems){
    const point=cyclonePointAt(system,unix);if(!cycloneVisiblePosition(point))continue;
    shown.add(system.id);
    let marker=cycloneMarkers.get(system.id);
    if(!marker){
      marker=L.marker([point.lat,point.lon],{pane:'cyclonePane',icon:cycloneIcon(system,point),title:cycloneName(system)+' · '+Math.round(point.pressure)+' hPa',riseOnHover:true});
      marker.on('click',()=>openCyclonePopup(cycloneData.systems.find(s=>s.id===system.id)||system));
      marker.addTo(cycloneMarkerGroup);cycloneMarkers.set(system.id,marker);
    }else{marker.setLatLng([point.lat,point.lon]);}
    const element=marker.getElement();
    if(element){
      element.setAttribute('title',cycloneName(system)+' · '+Math.round(point.pressure)+' hPa');
      // Keep the SVG in place so forecast playback doesn't restart its rotation.
      element.querySelector('.cyclone-symbol').style.setProperty('--cyclone-colour',cycloneColour(point.pressure));
      element.querySelector('.cyclone-pressure').textContent=Math.round(point.pressure)+' hPa';
    }
  }
  for(const [id,marker] of cycloneMarkers)if(!shown.has(id)){cycloneMarkerGroup.removeLayer(marker);cycloneMarkers.delete(id);}
  renderCyclonePaths();renderCycloneHistory();
  if(cycloneProbeId){
    const system=cycloneData.systems.find(s=>s.id===cycloneProbeId),point=system&&cyclonePointAt(system,unix);
    if(point&&shown.has(system.id)&&map.hasLayer(cyclonePopup))cyclonePopup.setLatLng([point.lat,point.lon]).setContent(cyclonePopupContent(system,point));
    else closeCyclonePopup();
  }
  const old=Date.now()/1000-cycloneData.modelRun>12*3600;
  $('cycloneStatus').textContent=shown.size+' '+(shown.size===1?'system':'systems')+' across the region · '+(hour?'forecast':'modelled current positions')+
    ' · model run '+fmt(cycloneData.modelRun)+(cycloneData.status==='error'||cycloneRefreshFailed?' · latest refresh failed; using previous forecast':old?' · older model run':'');
  $('cycloneStatus').className='status '+(old||cycloneData.status==='error'||cycloneRefreshFailed?'warn':'ok');
}

function hideCycloneLayers(){
  if(cycloneMarkerGroup){map.removeLayer(cycloneMarkerGroup);cycloneMarkerGroup=null;}
  if(cyclonePathGroup){map.removeLayer(cyclonePathGroup);cyclonePathGroup=null;}
  if(cycloneHistoryGroup){map.removeLayer(cycloneHistoryGroup);cycloneHistoryGroup=null;}
  cycloneMarkers.clear();closeCyclonePopup();
}

async function loadCyclones(force=false){
  if(!$('cycloneOn').checked)return;
  if(!force&&cycloneData&&Date.now()-cycloneLoadedAt<10*60*1000)return renderCyclones();
  if(Date.now()<cycloneRetryAt)return renderCyclones();
  if(!cycloneLoadPromise){
    $('cycloneStatus').textContent='Loading North Atlantic and northern Europe cyclones…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    cycloneLoadPromise=(async()=>{
      try{
        const response=await fetch('data/cyclones.json',{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Cyclone feed HTTP '+response.status);
        cycloneData=validateCyclones(await response.json());cycloneTrackTime=Math.floor(Date.now()/1000);cycloneLoadedAt=Date.now();cycloneRetryAt=0;cycloneRefreshFailed=false;
      }catch(error){
        cycloneRetryAt=Date.now()+60000;cycloneRefreshFailed=true;
        if(!cycloneData)throw error;
        console.warn('Cyclone refresh failed',error.message);
      }finally{clearTimeout(timer);}
    })().finally(()=>{cycloneLoadPromise=null;});
  }
  await cycloneLoadPromise;if($('cycloneOn').checked)renderCyclones();
}

function reportCycloneError(error){
  if(!$('cycloneOn').checked)return;
  hideCycloneLayers();$('cycloneStatus').textContent='Cyclone data could not load: '+error.message;$('cycloneStatus').className='status bad';
}
function stopCyclonePlayback(){
  cyclonePlaying=false;if(cyclonePlayTimer)clearInterval(cyclonePlayTimer);cyclonePlayTimer=null;$('cyclonePlay').textContent='▶ Forecast';
}
$('cycloneOn').addEventListener('change',()=>{
  setWeatherSectionState('cycloneSection',$('cycloneOn').checked);
  if($('cycloneOn').checked)loadCyclones().catch(reportCycloneError);
  else{stopCyclonePlayback();hideCycloneLayers();$('cycloneStatus').textContent='Cyclones are off.';}
});
$('cycloneHistoryOn').addEventListener('change',()=>{if($('cycloneOn').checked)renderCyclones();});
$('cyclonePathsOn').addEventListener('change',()=>{if($('cycloneOn').checked)renderCyclones();});
$('cycloneForecastHour').addEventListener('input',()=>{stopCyclonePlayback();renderCyclones();});
$('cycloneNow').addEventListener('click',()=>{stopCyclonePlayback();$('cycloneForecastHour').value='0';renderCyclones();});
$('cycloneCoverage').addEventListener('click',()=>map.fitBounds([[30,-75],[75,35]],{padding:[30,30]}));
$('cyclonePlay').addEventListener('click',()=>{
  if(cyclonePlaying)return stopCyclonePlayback();
  if(!cycloneUsable())return;
  cyclonePlaying=true;$('cyclonePlay').textContent='❚❚ Pause';
  cyclonePlayTimer=setInterval(()=>{
    let hour=Number($('cycloneForecastHour').value)+3;if(hour>48)hour=0;
    $('cycloneForecastHour').value=String(hour);renderCyclones();
  },900);
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCyclonePlayback();});
setInterval(()=>{if($('cycloneOn').checked)loadCyclones().catch(reportCycloneError);},5*60*1000);
