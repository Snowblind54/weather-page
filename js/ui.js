// Navigation opens controls independently of whether their map layers are enabled.
const weatherCategories=[
  ['tempSection','tempOn'],['windSection','windOn'],['cloudSection','cloudOn'],
  ['radarSection','radarOn'],['cycloneSection','cycloneOn'],['warningSection','warningOn']
];
let openedWeatherPanel=null;
function closeWeatherPanel(returnFocus=false){
  if(!openedWeatherPanel)return;
  const id=openedWeatherPanel;
  $(id).hidden=true;
  $('nav-'+id).setAttribute('aria-expanded','false');
  openedWeatherPanel=null;
  if(returnFocus)$('nav-'+id).focus();
}
function positionWeatherPanel(){
  if(!openedWeatherPanel)return;
  const button=$('nav-'+openedWeatherPanel),panel=$(openedWeatherPanel);
  const width=Math.min(420,window.innerWidth-24);
  panel.style.left=Math.max(12,Math.min(button.getBoundingClientRect().left,window.innerWidth-width-12))+'px';
}
function openWeatherPanel(id){
  if(openedWeatherPanel===id){closeWeatherPanel(true);return;}
  closeWeatherPanel();
  openedWeatherPanel=id;
  $(id).hidden=false;
  $('nav-'+id).setAttribute('aria-expanded','true');
  positionWeatherPanel();
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
  if(!event.target.closest('.topbar,.weather-panel'))closeWeatherPanel();
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
  const radarPending=statusPending('radarStatus') && ($('radarOn').checked || /requesting.*frame list/i.test($('radarStatus').textContent));
  const cloudsPending=$('cloudOn').checked && statusPending('cloudStatus');
  const modelPending=(temperatureEnabled() && statusPending('tempStatus')) ||
    ($('windOn').checked && statusPending('windStatus')) ||
    (activeAccumulationHours() && statusPending('rainAccumStatus'));
  const busy=!!(radarPending || cloudsPending || modelPending);
  $('timelineLoading').hidden=!busy;
  document.querySelector('.timeline-dock').setAttribute('aria-busy',String(busy));
  const text=cloudsPending && /buffering/i.test($('cloudStatus').textContent)?'Buffering…':'Loading data…';
  if($('timelineLoadingText').textContent!==text)$('timelineLoadingText').textContent=text;
}
const timelineLoadingObserver=new MutationObserver(updateTimelineLoading);
for(const id of ['radarStatus','cloudStatus','tempStatus','windStatus','rainAccumStatus']){
  timelineLoadingObserver.observe($(id),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
}
for(const id of ['radarOn','cloudOn','tempOn','heatmapOn','windOn','rain1h','rain24h','rain48h']){
  $(id).addEventListener('change',updateTimelineLoading);
}
updateTimelineLoading();
