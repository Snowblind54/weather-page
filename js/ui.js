// Navigation opens controls independently of whether their map layers are enabled.
const weatherCategories=[
  ['tempSection','tempOn'],['windSection','windOn'],['cloudSection','cloudOn'],
  ['radarSection','radarOn'],['snowSection','snowOn'],['cycloneSection','cycloneOn'],['warningSection','warningOn']
];
let openedWeatherPanel=null;
function closeWeatherPanel(returnFocus=false,refreshRain=true){
  if(!openedWeatherPanel)return;
  const id=openedWeatherPanel;
  $(id).hidden=true;
  $('nav-'+id).setAttribute('aria-expanded','false');
  openedWeatherPanel=null;
  if(refreshRain&&activeAccumulationHours())requestAnimationFrame(renderOfficialRainLabels);
  if(returnFocus)$('nav-'+id).focus();
  syncTimelineCadence();
}
function positionWeatherPanel(){
  if(!openedWeatherPanel)return;
  const panel=$(openedWeatherPanel);
  panel.style.left='auto';
  panel.style.right=(window.innerWidth<=760?12:16)+'px';
  if(activeAccumulationHours())requestAnimationFrame(renderOfficialRainLabels);
}
function openWeatherPanel(id){
  if(id==='snowSection')enterSnowView();
  else if(id!=='mapSettings' && snowMode)exitSnowView();
  if(openedWeatherPanel===id){closeWeatherPanel(true);return;}
  closeWeatherPanel();
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
  if(!event.target.closest('.topbar,.weather-panel')){
    // Keep a gauge under the pointer until its click has opened the popup.
    const gauge=event.target.closest('.leaflet-marker-icon')?.querySelector('.rain-station-label');
    closeWeatherPanel(false,!gauge);
  }
});
window.addEventListener('resize',positionWeatherPanel);
function updateCategoryIndicators(){
  for(const [section,toggle] of weatherCategories){
    const active=$(toggle).checked || (section==='windSection' && ['windHeatmapOn','officialWindSustained','officialWindGusts'].some(id=>$(id).checked)) || (section==='tempSection' && $('heatmapOn').checked) || (section==='radarSection' && ['rain1h','rain24h','rain48h'].some(id=>$(id).checked));
    $('nav-'+section).classList.toggle('layer-active',active);
  }
}
for(const id of [...weatherCategories.map(c=>c[1]),'rain1h','rain24h','rain48h','heatmapOn','windHeatmapOn','officialWindSustained','officialWindGusts']){
  $(id).addEventListener('change',updateCategoryIndicators);
}
updateCategoryIndicators();
function renderTimelineTicks(){
  const ticks=$('timelineTicks');
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
    (statusPending('nordicRadarStatus') && $('radarOn').checked) ||
    (statusPending('radarStatus') && ($('radarOn').checked || /requesting.*frame list/i.test($('radarStatus').textContent))); 
  const cloudsPending=$('cloudOn').checked && statusPending('cloudStatus');
  const modelPending=(temperatureEnabled() && statusPending('tempStatus')) ||
    (windVisualEnabled() && (statusPending('windStatus') || statusPending('windHeatmapStatus'))) ||
    (activeAccumulationHours() && statusPending('rainAccumStatus'));
  const busy=!!(radarPending || cloudsPending || modelPending);
  $('timelineLoading').hidden=!busy;
  document.querySelector('.timeline-dock').setAttribute('aria-busy',String(busy));
  const text=cloudsPending && /buffering/i.test($('cloudStatus').textContent)?'Buffering…':'Loading data…';
  if($('timelineLoadingText').textContent!==text)$('timelineLoadingText').textContent=text;
}
const timelineLoadingObserver=new MutationObserver(updateTimelineLoading);
for(const id of ['radarStatus','nordicRadarStatus','cloudStatus','tempStatus','windStatus','windHeatmapStatus','rainAccumStatus']){
  timelineLoadingObserver.observe($(id),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
}
for(const id of ['radarOn','cloudOn','tempOn','heatmapOn','windOn','windHeatmapOn','rain1h','rain24h','rain48h']){
  $(id).addEventListener('change',updateTimelineLoading);
}
updateTimelineLoading();

function syncTimelineCadence(){
  const tenMinutes=openedWeatherPanel==='cloudSection' || $('cloudOn').checked;
  if(tenMinutes===cloudTimelineMode)return;
  stop();
  updateWeatherTimeline(tenMinutes);
  applyFrame().catch(console.error);
  if($('cloudOn').checked)scheduleCloudPrecache();
}
$('cloudOn').addEventListener('change',syncTimelineCadence);
syncTimelineCadence();


