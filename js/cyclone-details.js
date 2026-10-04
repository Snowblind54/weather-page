// Quiet pressure contours and a forecast-synchronised list of <=1000 hPa lows.
map.createPane('isobarPane');map.getPane('isobarPane').style.zIndex='590';
map.getPane('isobarPane').style.pointerEvents='none';
let cycloneIsobarGroup=null,cycloneIsobarLabels=null,cycloneIsobarKey='',cycloneDetailsRenderTimer=null;
function cycloneTrend(system,point){
  if(!point)return {text:'Trend unavailable',change:null,kind:'unknown'};
  const points=new Map();
  for(const p of [...(system.history||[]),...system.points])points.set(p.time,p);
  const target=point.time-6*3600,ordered=[...points.values()].sort((a,b)=>a.time-b.time);
  let before=null;
  for(let i=0;i<ordered.length;i++){
    const a=ordered[i],b=ordered[i+1];
    if(a.time===target){before=a.pressure;break;}
    if(b && a.time<target && target<b.time && b.time-a.time<=6*3600){before=a.pressure+(b.pressure-a.pressure)*(target-a.time)/(b.time-a.time);break;}
  }
  if(before===null)return {text:'6 h trend unavailable',change:null,kind:'unknown'};
  const change=point.pressure-before,kind=change<=-1?'deepening':change>=1?'filling':'steady';
  return {text:(kind==='deepening'?'↓ Strengthening':kind==='filling'?'↑ Weakening':'→ Steady')+' · '+(change>0?'+':'')+change.toFixed(1)+' hPa / 6 h',change,kind};
}
function cycloneSafeNameUrl(url){
  try{const u=new URL(url);return u.protocol==='https:' && ['weather.metoffice.gov.uk','www.metoffice.gov.uk','www.met.no','api.met.no'].includes(u.hostname)?u.href:null;}catch{return null;}
}
function cycloneEuropeanNameHtml(system){
  const named=system.europeanName;if(!named)return '';
  const url=cycloneSafeNameUrl(named.url);
  return '<div class="cyclone-advisory"><b>European storm name: '+htmlEscape(system.name)+'</b><br>'+htmlEscape(named.issuer)+
    (url?' · <a href="'+htmlEscape(url)+'" target="_blank" rel="noopener">Official source</a>':'')+
    '<br><small>Model centre matched by impact region and time; association is inferred.</small></div>';
}
function renderCycloneList(){
  const list=$('cycloneList');list.replaceChildren();
  if(!$('cycloneOn').checked || !cycloneUsable()){$('cycloneListSummary').textContent='Enable Cyclones to view active systems.';return;}
  const systems=cycloneData.systems.map(system=>({system,point:cyclonePointAt(system,cycloneSelectedTime())}))
    .filter(item=>cycloneVisiblePosition(item.point)).sort((a,b)=>a.point.pressure-b.point.pressure);
  $('cycloneListSummary').textContent=systems.length+' '+(systems.length===1?'system':'systems')+' at or below 1000 hPa · lowest pressure first';
  for(const {system,point} of systems){
    const trend=cycloneTrend(system,point),button=document.createElement('button');button.type='button';button.className='cyclone-list-card';
    const name=system.name||system.id;
    button.setAttribute('aria-label','View '+name+' · '+point.pressure.toFixed(1)+' hPa');
    button.innerHTML='<span class="cyclone-card-heading"><strong>'+htmlEscape(name)+'</strong><b style="color:'+cycloneColour(point.pressure)+'">'+point.pressure.toFixed(1)+' hPa</b></span>'+
      '<span class="cyclone-trend '+trend.kind+'">'+htmlEscape(trend.text)+'</span>'+
      '<span class="cyclone-card-meta">'+(point.nearbyGust==null?'Gust unavailable':'Nearby peak gust '+point.nearbyGust.toFixed(1)+' m/s')+' · moving '+Math.round(point.speed)+' km/h</span>'+
      (system.europeanName?'<span class="cyclone-card-meta">Name: '+htmlEscape(system.europeanName.issuer)+' · inferred match</span>':system.nhc?'<span class="cyclone-card-meta">Official NHC name</span>':'');
    button.addEventListener('click',()=>{
      if(!$('cycloneOn').checked || !cycloneUsable())return;
      const selected=cyclonePointAt(system,cycloneSelectedTime());if(!cycloneVisiblePosition(selected))return;
      stopCyclonePlayback();map.setView([selected.lat,selected.lon],Math.max(map.getZoom(),5),{animate:true});openCyclonePopup(system);
    });list.appendChild(button);
  }
  const sources=cycloneData.europeanNamesStatus?.sources||[];
  const checked=sources.filter(s=>s.status==='ok').length;
  $('cycloneNamesStatus').textContent=checked
    ?'European names checked: '+sources.filter(s=>s.status==='ok').map(s=>s.issuer).join(', ')+'. '+(sources.some(s=>s.status==='error')?'Some sources unavailable. ':'')+'Ambiguous matches keep their tracking IDs.'
    :'European naming sources unavailable; tracking IDs remain visible.';
}
function validatePressureContours(data){
  const archive=data.pressureContours;
  if(!archive)return data; // Previous snapshots remain usable while the new run is prepared.
  if(archive.version!==1 || archive.modelRun!==data.modelRun || !Array.isArray(archive.frames) || archive.frames.length>100)throw new Error('Invalid pressure contour archive');
  let previous=-Infinity,total=0;
  for(const frame of archive.frames){
    if(!Number.isFinite(frame.time) || frame.time<archive.modelRun || frame.time>data.forecastEnd || frame.time<=previous || !Array.isArray(frame.lines) || frame.lines.length>700)throw new Error('Invalid pressure contour frame');
    previous=frame.time;
    for(const line of frame.lines){
      if(!Number.isFinite(line.pressure) || line.pressure<850 || line.pressure>1100 || !Array.isArray(line.points) || line.points.length<2 || line.points.length>6000)throw new Error('Invalid isobar');
      total+=line.points.length;if(total>2250000)throw new Error('Pressure contours too large');
      for(const p of line.points)if(!Array.isArray(p) || p.length!==2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0]<-85 || p[0]>45 || p[1]<20 || p[1]>82)throw new Error('Invalid isobar coordinate');
    }
  }
  return data;
}
function hideCycloneIsobars(){
  if(cycloneIsobarGroup)map.removeLayer(cycloneIsobarGroup);
  if(cycloneIsobarLabels)map.removeLayer(cycloneIsobarLabels);
  cycloneIsobarGroup=null;cycloneIsobarLabels=null;cycloneIsobarKey='';
}
function renderCycloneIsobars(){
  if(!$('cycloneOn').checked || !$('cycloneIsobarsOn').checked || !cycloneUsable()){
    hideCycloneIsobars();$('cycloneIsobarStatus').textContent=$('cycloneIsobarsOn').checked?'Pressure contours follow the cyclone forecast.':'Pressure contours are off.';return;
  }
  const frames=cycloneData.pressureContours?.frames||[],unix=cycloneSelectedTime();
  let frame=null;for(const candidate of frames)if(candidate.time<=unix)frame=candidate;else break;
  if(!frame || frame.time!==unix){hideCycloneIsobars();$('cycloneIsobarStatus').textContent='Pressure contours unavailable for this model time.';return;}
  const interval=cycloneData.pressureContours.interval||4,key=cycloneData.modelRun+'/'+frame.time+'/'+interval;
  const opacity=Number($('cycloneIsobarOpacity').value)/100;
  if(key!==cycloneIsobarKey){
    hideCycloneIsobars();const layers=[];
    for(const line of frame.lines){
      if(line.pressure%interval)continue;
      const points=line.points.map(p=>[p[1],p[0]]);
      layers.push(L.polyline(points,{pane:'isobarPane',color:'#d8e7ef',weight:1,opacity,interactive:false,smoothFactor:1.5}));
    }
    cycloneIsobarGroup=L.layerGroup(layers).addTo(map);cycloneIsobarKey=key;
  }else cycloneIsobarGroup.eachLayer(layer=>layer.setStyle({opacity}));
  if(cycloneIsobarLabels)map.removeLayer(cycloneIsobarLabels);
  const labels=[],occupied=[],size=map.getSize();const blocked=[];
  for(const id of ['cycloneSection','snowMapKey','timelineDock']){
    const el=$(id);if(el && !el.hidden){const r=el.getBoundingClientRect();blocked.push(r);}
  }
  const mapRect=map.getContainer().getBoundingClientRect();
  // A small label budget across the viewport; avoid the panel and the map edges.
  for(const line of frame.lines){
    if(line.pressure%interval || labels.length>=8)continue;
    for(let i=Math.floor(line.points.length/2),attempt=0;attempt<line.points.length;attempt++,i=(i+7)%line.points.length){
      const [lon,lat]=line.points[i],p=map.latLngToContainerPoint([lat,lon]);
      if(p.x<60 || p.y<120 || p.x>size.x-70 || p.y>size.y-100)continue;
      if(occupied.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<180))continue;
      if(blocked.some(r=>p.x+mapRect.left>r.left-35 && p.x+mapRect.left<r.right+35 && p.y+mapRect.top>r.top-18 && p.y+mapRect.top<r.bottom+18))continue;
      occupied.push(p);labels.push(L.marker([lat,lon],{pane:'isobarPane',interactive:false,keyboard:false,
        icon:L.divIcon({className:'isobar-label',html:String(line.pressure),iconSize:[40,17],iconAnchor:[20,8]})}));break;
    }
  }
  cycloneIsobarLabels=L.layerGroup(labels).addTo(map);
  $('cycloneIsobarStatus').textContent=interval+' hPa spacing · sea-level pressure · '+fmt(frame.time)+' · '+Math.round(opacity*100)+'% opacity';
}
function renderCycloneDetails(){renderCycloneList();renderCycloneIsobars();}
$('cycloneIsobarsOn').addEventListener('change',renderCycloneIsobars);
$('cycloneIsobarOpacity').addEventListener('input',renderCycloneIsobars);
map.on('moveend zoomend',()=>{clearTimeout(cycloneDetailsRenderTimer);cycloneDetailsRenderTimer=setTimeout(renderCycloneIsobars,100);});
