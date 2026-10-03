// Navigation opens controls independently of whether their map layers are enabled.
const weatherCategories=[
  ['tempSection','tempOn'],['windSection','windOn'],['cloudSection','cloudOn'],
  ['radarSection','radarOn'],['cycloneSection','cycloneOn'],['warningSection','warningOn']
];
let openedWeatherPanel=null,cycloneTimelineMode=false,savedObservationTime=null;
function closeWeatherPanel(returnFocus=false,sync=true){
  if(!openedWeatherPanel)return;
  const id=openedWeatherPanel;
  $(id).hidden=true;
  $('nav-'+id).setAttribute('aria-expanded','false');
  openedWeatherPanel=null;
  if(returnFocus)$('nav-'+id).focus();
  if(sync)syncTimelineCadence();
}
function positionWeatherPanel(){
  if(!openedWeatherPanel)return;
  const button=$('nav-'+openedWeatherPanel),panel=$(openedWeatherPanel);
  const width=Math.min(420,window.innerWidth-24);
  panel.style.left=Math.max(12,Math.min(button.getBoundingClientRect().left,window.innerWidth-width-12))+'px';
}
function openWeatherPanel(id){
  if(openedWeatherPanel===id){closeWeatherPanel(true);return;}
  closeWeatherPanel(false,false);
  openedWeatherPanel=id;
  $(id).hidden=false;
  $('nav-'+id).setAttribute('aria-expanded','true');
  positionWeatherPanel();
  syncTimelineCadence();
}
for(const button of document.querySelectorAll('[data-panel]')){
  button.addEventListener('click',()=>openWeatherPanel(button.dataset.panel));
}
for(const button of document.querySelectorAll('.close-panel')){
  button.addEventListener('click',()=>closeWeatherPanel(true));
}
for(const button of document.querySelectorAll('[data-info]')){
  button.addEventListener('click',()=>{
    const drawer=$(button.dataset.info),expanded=drawer.hidden;
    drawer.hidden=!expanded;button.setAttribute('aria-expanded',String(expanded));
  });
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeWeatherPanel(true);});
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('.topbar,.weather-panel,.timeline-dock'))closeWeatherPanel();
});
window.addEventListener('resize',positionWeatherPanel);
function updateCategoryIndicators(){
  for(const [section,toggle] of weatherCategories){
    const active=$(toggle).checked || (section==='tempSection' && $('heatmapOn').checked) || (section==='radarSection' && ['rain1h','rain24h','rain48h'].some(id=>$(id).checked));
    $('nav-'+section).classList.toggle('layer-active',active);
  }
}
for(const id of [...weatherCategories.map(c=>c[1]),'rain1h','rain24h','rain48h','heatmapOn']){
  $(id).addEventListener('change',updateCategoryIndicators);
}
updateCategoryIndicators();
function renderTimelineTicks(){
  const ticks=$('timelineTicks');
  if(cycloneTimelineMode){renderCycloneTicks();return;}
  if(!frames.length)return;
  ticks.replaceChildren();
  const count=Math.min(5,frames.length);
  for(let n=0;n<count;n++){
    const index=count===1?0:Math.round(n*(frames.length-1)/(count-1));
    const label=document.createElement('span');
    label.textContent=new Date(frames[index].time*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',hour12:false});
    ticks.append(label);
  }
}
new MutationObserver(renderTimelineTicks).observe($('timeline'),{attributes:true,attributeFilter:['min','max']});
renderTimelineTicks();

// Mirror the existing loaders without starting requests or delaying playback.
function updateTimelineLoading(){
  const pending=text=>/\b(loading|downloading|requesting|buffering|preparing|updating)\b/i.test(text);
  const statusPending=id=>{const el=$(id);return !el.classList.contains('bad') && pending(el.textContent);};
  const radarPending=(!frames.length && !$('radarStatus').classList.contains('bad')) ||
    (statusPending('radarStatus') && ($('radarOn').checked || /requesting.*frame list/i.test($('radarStatus').textContent))); 
  const cloudsPending=$('cloudOn').checked && statusPending('cloudStatus');
  const modelPending=(temperatureEnabled() && statusPending('tempStatus')) ||
    ($('windOn').checked && statusPending('windStatus')) ||
    (activeAccumulationHours() && statusPending('rainAccumStatus'));
  const busy=cycloneTimelineMode?($('cycloneOn').checked && statusPending('cycloneStatus')):!!(radarPending || cloudsPending || modelPending);
  $('timelineLoading').hidden=!busy;
  document.querySelector('.timeline-dock').setAttribute('aria-busy',String(busy));
  const text=cloudsPending && /buffering/i.test($('cloudStatus').textContent)?'Buffering…':'Loading data…';
  if($('timelineLoadingText').textContent!==text)$('timelineLoadingText').textContent=text;
}
const timelineLoadingObserver=new MutationObserver(updateTimelineLoading);
for(const id of ['radarStatus','cloudStatus','tempStatus','windStatus','rainAccumStatus','cycloneStatus']){
  timelineLoadingObserver.observe($(id),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
}
for(const id of ['radarOn','cloudOn','tempOn','heatmapOn','windOn','rain1h','rain24h','rain48h']){
  $(id).addEventListener('change',updateTimelineLoading);
}
updateTimelineLoading();

function cycloneTimelineActive(){return cycloneTimelineMode;}
function cycloneTimelineMinimum(){
  if(!cycloneData)return -48;
  const times=cycloneData.systems.flatMap(s=>[...(s.history||[]),...s.points].map(p=>p.time));
  return times.length?Math.max(-48,Math.min(0,Math.ceil((Math.min(...times)-cycloneTrackStart())/3600))):0;
}
function renderCycloneTicks(){
  const min=Number($('timeline').min),max=Number($('timeline').max);
  const ticks=[min,Math.round(min/2),0,24,max];
  $('timelineTicks').replaceChildren(...[...new Set(ticks)].map(hour=>{
    const span=document.createElement('span');span.textContent=hour===0?'Now':(hour>0?'+':'')+hour+' h';return span;
  }));
}
function updateCycloneTimeline(){
  if(!cycloneTimelineMode)return;
  const min=cycloneTimelineMinimum();
  if($('timeline').min!==String(min))$('timeline').min=min;
  if($('timeline').max!=='48')$('timeline').max=48;
  $('timeline').step=1;
  $('cycloneForecastHour').min=min;
  const hour=Math.max(min,Math.min(48,Number($('cycloneForecastHour').value)));
  $('cycloneForecastHour').value=hour;$('timeline').value=hour;
  $('timeLabel').textContent=(hour===0?'Now':(hour>0?'+':'')+hour+' h')+' · '+fmt(cycloneSelectedTime());
  $('play').textContent=cyclonePlaying?'❚❚ Pause':'▶ Play';
  renderCycloneTicks();updateTimelineLoading();
}
function syncTimelineCadence(){
  const cyclone=openedWeatherPanel==='cycloneSection';
  if(cyclone!==cycloneTimelineMode){
    stop();stopCyclonePlayback();clearTimeout(timelineDebounceTimer);
    if(cyclone){
      savedObservationTime=frames[Number($('timeline').value)]?.time;
      cycloneTimelineMode=true;$('cycloneForecastHour').value=0;
      $('timelineTitle').textContent='Cyclone timeline';
      $('timeline').setAttribute('aria-label','Cyclone movement time');
      $('oldest').textContent='← Past';$('latest').textContent='Now';
      updateCycloneTimeline();renderCyclones();return;
    }
    cycloneTimelineMode=false;
    $('timelineTitle').textContent='2-hour timeline';
    $('timeline').setAttribute('aria-label','Weather observation time');
    $('oldest').textContent='← Oldest';$('latest').textContent='Latest →';
    $('timeline').min=0;$('timeline').step=1;
    updateWeatherTimeline(openedWeatherPanel==='cloudSection' || $('cloudOn').checked);
    if(frames.length && savedObservationTime!=null){
      $('timeline').value=frames.reduce((best,f,i)=>Math.abs(f.time-savedObservationTime)<Math.abs(frames[best].time-savedObservationTime)?i:best,0);
    }
    renderTimelineTicks();applyFrame().catch(console.error);updateTimelineLoading();return;
  }
  if(cyclone)return;
  const tenMinutes=openedWeatherPanel==='cloudSection' || $('cloudOn').checked;
  if(tenMinutes===cloudTimelineMode)return;
  stop();updateWeatherTimeline(tenMinutes);applyFrame().catch(console.error);
  if($('cloudOn').checked)scheduleCloudPrecache();
}
$('cloudOn').addEventListener('change',syncTimelineCadence);
syncTimelineCadence();
