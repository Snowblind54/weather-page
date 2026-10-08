// Install before ui.js so Forecast uses the existing navigation and menus.
(function(){
  const nav=document.querySelector('.category-nav');
  if(!nav)return;
  const button=document.createElement('button');
  button.id='nav-forecastSection';button.className='category-tab';
  button.dataset.panel='forecastSection';button.setAttribute('aria-controls','forecastSection');button.setAttribute('aria-expanded','false');
  button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v15H4zM8 3v4m8-4v4M4 10h16M8 14h3m-3 3h6"/></svg><span>Forecast</span>';
  nav.prepend(button);
  map.createPane('forecastPoint');map.getPane('forecastPoint').style.zIndex='650';
  const panel=document.createElement('div');
  panel.id='forecastSection';panel.className='weather-panel weather-section';panel.hidden=true;
  panel.setAttribute('role','region');panel.setAttribute('aria-labelledby','forecastSection-title');
  panel.innerHTML=`
    <div class="panel-heading"><div><div class="eyebrow" id="forecastProvider">MET NORWAY</div><h2 id="forecastSection-title">Forecast</h2><p>Choose a place on the map</p></div><div class="panel-actions"><button class="info-button" data-info="forecastSection-sources" aria-controls="forecastSection-sources" aria-expanded="false" aria-label="Forecast sources">i</button><button class="close-panel" aria-label="Close Forecast menu">×</button></div></div>
    <div id="forecastSection-sources" class="source-card" hidden><h3>Sources &amp; attribution</h3><p>Weather forecast data from MET Norway, Locationforecast 2.0, under CC BY 4.0. Nordic short-range forecasts use MEPS with local post-processing; other regions and longer ranges use the models described by MET Norway. These are automatic model forecasts, not measured conditions.</p><div class="source-links"><a href="https://api.met.no/doc/locationforecast/datamodel" target="_blank" rel="noopener">Forecast models ↗</a><a href="https://api.met.no/doc/License" target="_blank" rel="noopener">MET Norway licence ↗</a><a href="https://github.com/Snowblind54/weather-page" target="_blank" rel="noopener">Northern Weather project ↗</a></div><p>Forecast times and quantities retain their original intervals. Rain/snow is liquid-water equivalent in mm, not snow depth. Missing Iceland gusts are supplemented from cached ECMWF IFS open-data grids (CC BY 4.0). These use the nearest 0.25° grid point and nearest native forecast within 90 minutes; each reading retains its actual maximum-gust period and model run. Daily gust maxima use available samples. Other missing gusts and probabilities are shown as unavailable. Location forecasts do not change the observation layers.</p></div>
    <div class="forecast-location" id="forecastLocation">Choose a location</div>
    <div class="forecast-actions"><button type="button" id="forecastCenter">Use map centre</button><button type="button" id="forecastRetry">Check for updates</button></div>
    <div id="forecastStatus" class="status" role="status" aria-live="polite">Open Forecast to load this map location.</div>
    <div id="forecastContent" hidden>
      <div class="forecast-tabs" role="tablist" aria-label="Forecast view"><button id="forecastHourlyTab" type="button" role="tab" aria-selected="true" aria-controls="forecastHourly">Next 72 hours</button><button id="forecastDailyTab" type="button" role="tab" aria-selected="false" aria-controls="forecastDaily" tabindex="-1">7-day overview</button></div>
      <div id="forecastHourly" role="tabpanel" aria-labelledby="forecastHourlyTab">
        <label class="label" for="forecastTimeline">Forecast time</label><input id="forecastTimeline" type="range" min="0" max="0" value="0" step="1" aria-label="Forecast time" aria-describedby="forecastSelectedTime">
        <time id="forecastSelectedTime" class="forecast-time"></time>
        <div id="forecastSelected"></div>
        <p class="forecast-note">Move the slider through the forecast. Later times may be 6 hours apart; rain totals retain their stated interval.</p>
        <div class="forecast-hour-scroll"><table class="forecast-hours"><caption class="forecast-note">Available forecast times · wind and gusts in m/s</caption><thead><tr><th scope="col">Time</th><th scope="col">°C</th><th scope="col">Rain/snow</th><th scope="col">Wind</th><th scope="col">Gust</th></tr></thead><tbody id="forecastHours"></tbody></table></div>
      </div>
      <div id="forecastDaily" role="tabpanel" aria-labelledby="forecastDailyTab" hidden><div id="forecastDays" class="forecast-days"></div><p class="forecast-note">Temperature ranges use available forecast times. ≥ marks a partial rain/snow total: periods crossing midnight are excluded rather than split. Today covers the remaining forecast period. Gusts may be unavailable later in the forecast.</p></div>
    </div>
    <div class="forecast-attribution"><a href="https://api.met.no/" target="_blank" rel="noopener">Data from MET Norway</a><span id="forecastGustAttribution" hidden> · Iceland gusts © <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF</a></span> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> · Summaries by Northern Weather<br><span id="forecastIssued">Forecast update time will appear here.</span><br><span id="forecastZone"></span></div>`;
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);L.DomEvent.disableScrollPropagation(panel);

  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('forecastZone').textContent='Times in '+zone;
  const date=time=>new Date(time).toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:zone});
  const num=(value,digits=1)=>value===null||value===undefined?'—':value.toFixed(digits);
  const text=(tag,value,className)=>{const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;};
  let point=null,marker=null,payload=null,forecastRows=[],selectedTime=null,requestId=0,controller=null,refreshAfter=0,view='hourly';
  let gustGrid=null,gustChecked=0,gustPromise=null;
  const inIceland=p=>p&&Number(p.lat)>=61&&Number(p.lat)<=69&&Number(p.lon)>=-28&&Number(p.lon)<=-12;
  async function getGustGrid(){
    if(gustGrid&&Date.now()-gustChecked<15*60000)return gustGrid;
    if(gustPromise)return gustPromise;
    gustPromise=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
      try{
        const response=await fetch('data/forecast-iceland.json?v='+Math.floor(Date.now()/900000),{signal:abort.signal,cache:'no-cache'});
        if(!response.ok)throw Error('Iceland gust index unavailable');
        const meta=await response.json(),run=Date.parse(meta.reference_time);
        if(!Number.isFinite(run)||meta.asset_root!=='forecast-iceland-cache'||meta.asset_version!=='atlantic-v1')throw Error('Invalid gust index');
        const cycle=new Date(run).toISOString().replace(/[-:]/g,'').slice(0,11)+'Z-atlantic-v1';
        const path='data/forecast-iceland-cache/'+cycle+'/gust-grid-v1.json';
        if(meta.gust_grid?.path!==path||meta.gust_grid.units!=='m/s')throw Error('No shared Iceland gust grid');
        const reply=await fetch(path,{signal:abort.signal,cache:'force-cache'});
        if(!reply.ok)throw Error('Iceland gust grid unavailable');
        gustGrid=MetForecastData.validateGustGrid(await reply.json(),meta.reference_time);gustChecked=Date.now();
      }catch{gustChecked=Date.now()-13*60000;}
      finally{clearTimeout(timer);}
      return gustGrid;
    })().finally(()=>{gustPromise=null;});
    return gustPromise;
  }
  async function loadGusts(){
    if(panel.hidden||!payload||!inIceland(point))return;
    const id=requestId,key=point.lat+','+point.lon;
    const grid=await getGustGrid();
    if(!grid||id!==requestId||panel.hidden||!payload||point.lat+','+point.lon!==key)return;
    const wanted=selectedTime;render(payload,false);selectedTime=wanted;
  }
  const cache=new Map();
  const storageKey='northern-weather-met-forecast-v1';
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(saved))for(const item of saved.slice(-6)){if(typeof item?.key==='string'&&item.payload?.properties?.timeseries&&Number.isFinite(item.expires))cache.set(item.key,item);}}catch{}
  function remember(key,item){
    cache.delete(key);cache.set(key,{...item,key});
    while(cache.size>6)cache.delete(cache.keys().next().value);
    try{localStorage.setItem(storageKey,JSON.stringify(Array.from(cache.values())));}catch{}
  }
  function weather(symbol){
    const name=symbol.replace(/_(day|night|polartwilight)$/,'');
    const names={clearsky:'Clear sky',fair:'Mostly clear',partlycloudy:'Partly cloudy',cloudy:'Cloudy',fog:'Fog'};
    const label=names[name]||name.replace(/andthunder/g,' with thunder').replace(/showers/g,' showers').replace(/lightrain/g,'Light rain').replace(/heavyrain/g,'Heavy rain').replace(/lightsnow/g,'Light snow').replace(/heavysnow/g,'Heavy snow').replace(/lightsleet/g,'Light sleet').replace(/heavysleet/g,'Heavy sleet').replace(/^rain/,'Rain').replace(/^snow/,'Snow').replace(/^sleet/,'Sleet')||'Weather unavailable';
    const icon=/thunder/.test(name)?'⛈':/snow|sleet/.test(name)?'❄':/rain/.test(name)?'🌧':name==='clearsky'?(/night/.test(symbol)?'☾':'☀'):name==='fog'?'≋':'☁';
    return {label,icon};
  }
  function metric(label,value,note){
    const card=text('div','', 'forecast-metric');card.append(text('small',label),text('strong',value));if(note)card.append(text('small',note));return card;
  }
  function renderSelected(syncMap=true){
    const index=Number($('forecastTimeline').value),row=forecastRows[index];if(!row)return;
    selectedTime=row.time;
    $('forecastSelectedTime').textContent=date(row.time);$('forecastSelectedTime').dateTime=new Date(row.time).toISOString();
    const selected=$('forecastSelected');selected.replaceChildren();
    const condition=weather(row.symbol),hero=text('div','', 'forecast-hero');
    const description=text('div','');description.append(text('span',condition.icon,'forecast-symbol'),text('div',condition.label,'forecast-condition'));
    hero.append(text('strong',num(row.temp)+'°'),description);selected.append(hero);
    const metrics=text('div','', 'forecast-metrics');
    const direction=row.direction===null?'': 'From '+['N','NE','E','SE','S','SW','W','NW'][Math.round(row.direction/45)%8];
    const gustNote=row.gustSource?'ECMWF IFS · maximum for '+date(row.gustStart)+' – '+date(row.gustEnd)+' · nearest 0.25° grid point. Model run '+date(row.gustRun)+'.':null;
    metrics.append(metric('Sustained wind',row.wind===null?'Unavailable':num(row.wind)+' m/s',direction),metric('Wind gusts',row.gust===null?'Unavailable':num(row.gust)+' m/s',gustNote),metric('Rain / snow',row.rain===null?'Unavailable':num(row.rain)+' mm',row.hours?'Over the next '+row.hours+' hour'+(row.hours===1?'':'s'):''),metric('Precipitation chance',row.probability===null?'Unavailable':num(row.probability,0)+'%',row.hours?'For the same '+row.hours+'h period':''),metric('Cloud cover',row.cloud===null?'Unavailable':num(row.cloud,0)+'%'),metric('Sea-level pressure',row.pressure===null?'Unavailable':num(row.pressure,0)+' hPa'));
    selected.append(metrics);
    if(row.min!==null&&row.max!==null)selected.append(text('p','Temperature uncertainty (10th–90th percentile): '+num(row.min)+' to '+num(row.max)+' °C.','forecast-note'));
    for(const tr of $('forecastHours').children)tr.setAttribute('aria-current',String(Number(tr.dataset.index)===index));
    if(syncMap!==false)window.NorthernForecastMap?.setTime(row.time);
  }
  function render(data,syncMap=true){
    payload=data;
    const original=MetForecastData.rows(data),all=MetForecastData.addGusts(original,gustGrid,Number(point?.lat),Number(point?.lon)),end=Date.now()+72*3600000;
    forecastRows=all.filter(r=>r.time<=end);
    let index=0;if(selectedTime!==null)index=forecastRows.reduce((best,row,i)=>Math.abs(row.time-selectedTime)<Math.abs(forecastRows[best].time-selectedTime)?i:best,0);
    $('forecastTimeline').max=String(forecastRows.length-1);$('forecastTimeline').value=String(index);
    $('forecastHours').replaceChildren();
    forecastRows.forEach((row,i)=>{
      const tr=document.createElement('tr');tr.dataset.index=String(i);
      if(row.gustSource)tr.setAttribute('title','Gust: ECMWF IFS maximum for '+date(row.gustStart)+' – '+date(row.gustEnd));
      for(const value of [new Date(row.time).toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:zone}),num(row.temp),row.rain===null?'—':num(row.rain)+' mm / '+row.hours+'h',num(row.wind),num(row.gust)])tr.append(text('td',value));
      $('forecastHours').append(tr);
    });
    $('forecastDays').replaceChildren();
    for(const day of MetForecastData.days(all,zone)){
      const card=text('div','', 'forecast-day'),top=text('div','', 'forecast-day-top');
      top.append(text('strong',new Date(day.time).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:zone})),text('span',num(day.low)+'° to '+num(day.high)+'°'));
      card.append(top,text('p','Rain/snow '+(day.rainHours?(day.partial?'≥ ':'')+num(day.rain)+' mm':'unavailable')+' · wind up to '+num(day.wind)+' m/s · '+(day.gust===null?'gusts unavailable':'gusts up to '+num(day.gust)+' m/s'+(day.ecmwfGusts?' (available ECMWF samples)':''))));
      $('forecastDays').append(card);
    }
    const issued=Date.parse(data.properties?.meta?.updated_at);
    $('forecastIssued').textContent=Number.isFinite(issued)?'Forecast updated '+date(issued):'Forecast update time unavailable';
    $('forecastGustAttribution').hidden=!all.some(row=>row.gustSource);
    $('forecastProvider').textContent=all.some(row=>row.gustSource)?'MET NORWAY + ECMWF':'MET NORWAY';
    $('forecastContent').hidden=false;renderSelected(syncMap);
  }
  function setStatus(message,bad=false){$('forecastStatus').textContent=message;$('forecastStatus').className='status'+(bad?' bad':'');}
  async function loadForecast(){
    if(panel.hidden||!point||controller)return;
    const key=point.lat+','+point.lon,saved=cache.get(key),now=Date.now();
    if(saved&&saved.expires>now){try{render(saved.payload);loadGusts();refreshAfter=saved.expires;setStatus('Forecast ready · cached until '+new Date(saved.expires).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}));return;}catch{cache.delete(key);}}
    const id=++requestId,abort=new AbortController();controller=abort;
    const timer=setTimeout(()=>abort.abort(),20000);
    setStatus(payload?'Checking for a newer forecast…':'Loading forecast from MET Norway…');
    const url='https://api.met.no/weatherapi/locationforecast/2.0/complete?'+new URLSearchParams({lat:point.lat,lon:point.lon});
    try{
      // Simple CORS GET: browser Origin identifies the site. No custom headers
      // or cache-busting queries; browser HTTP caching handles revalidation.
      const response=await fetch(url,{signal:abort.signal,credentials:'omit',referrerPolicy:'no-referrer-when-downgrade'});
      if(!response.ok)throw new Error('MET Norway returned '+response.status);
      const data=await response.json();MetForecastData.rows(data);
      if(id!==requestId||panel.hidden)return;
      const headerExpires=Date.parse(response.headers.get('Expires'));
      const expires=Number.isFinite(headerExpires)&&headerExpires>Date.now()?headerExpires:Date.now()+30*60000;
      remember(key,{payload:data,expires});refreshAfter=expires;render(data);
      loadGusts();
      setStatus(response.status===203?'Forecast available · MET Norway reports a service version notice.':'Forecast ready · updates automatically while this panel is open.');
    }catch(error){
      if(id!==requestId||panel.hidden)return;
      refreshAfter=Date.now()+2*60000;
      if(saved){try{render(saved.payload);setStatus('Update unavailable. Showing the previous forecast for this location; see its update time.',true);}catch{$('forecastContent').hidden=true;setStatus('No current forecast available for this location. Try again shortly.',true);}}
      else{setStatus('Forecast unavailable. Check your connection and try again shortly.',true);$('forecastContent').hidden=true;}
    }finally{clearTimeout(timer);if(controller===abort)controller=null;}
  }
  function choose(latlng){
    requestId++;controller?.abort();controller=null;payload=null;refreshAfter=0;
    const longitude=((latlng.lng+180)%360+360)%360-180;
    point={lat:Math.max(-90,Math.min(90,latlng.lat)).toFixed(3),lon:longitude.toFixed(3)};
    $('forecastLocation').textContent=point.lat+'°, '+point.lon+'°';$('forecastContent').hidden=true;$('forecastIssued').textContent='Forecast update time will appear here.';
    if(marker)map.removeLayer(marker);
    marker=L.marker([Number(point.lat),Number(point.lon)],{pane:'forecastPoint',interactive:false,keyboard:false,icon:L.divIcon({className:'forecast-marker',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(map);
    clearTimeout(choose.timer);choose.timer=setTimeout(loadForecast,350);
  }
  $('forecastCenter').addEventListener('click',()=>choose(map.getCenter()));
  $('forecastRetry').addEventListener('click',()=>{gustChecked=0;loadForecast();});
  $('forecastTimeline').addEventListener('input',renderSelected);
  function switchView(next){
    view=next;
    for(const name of ['hourly','daily']){
      const prefix='forecast'+name[0].toUpperCase()+name.slice(1),active=name===next;
      $(prefix).hidden=!active;$(prefix+'Tab').setAttribute('aria-selected',String(active));$(prefix+'Tab').tabIndex=active?0:-1;
    }
  }
  for(const name of ['hourly','daily']){
    const tab=$('forecast'+name[0].toUpperCase()+name.slice(1)+'Tab');
    tab.addEventListener('click',()=>switchView(name));
    tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();switchView(event.key==='Home'?'hourly':event.key==='End'?'daily':view==='hourly'?'daily':'hourly');$('forecast'+view[0].toUpperCase()+view.slice(1)+'Tab').focus();}});
  }
  map.on('click',event=>{
    if(panel.hidden&&!window.NorthernForecastMap?.isActive())return;
    if(event.originalEvent?.target?.closest?.('.leaflet-interactive,.leaflet-marker-icon,.leaflet-popup,.leaflet-control'))return;
    if(panel.hidden&&typeof openWeatherPanel==='function')openWeatherPanel('forecastSection');
    map.closePopup();choose(event.latlng);
  });
  new MutationObserver(()=>{
    
    if(panel.hidden){requestId++;controller?.abort();controller=null;clearTimeout(choose.timer);if(marker){map.removeLayer(marker);marker=null;}}
    else{
      if(typeof stop==='function')stop();
      if(!point)choose(map.getCenter());
      else{if(!marker)marker=L.marker([Number(point.lat),Number(point.lon)],{pane:'forecastPoint',interactive:false,keyboard:false,icon:L.divIcon({className:'forecast-marker',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(map);loadForecast();}
    }
  }).observe(panel,{attributes:true,attributeFilter:['hidden']});
  setInterval(()=>{if(!document.hidden&&!panel.hidden){if(Date.now()>=refreshAfter)loadForecast();else if(payload&&Date.now()-gustChecked>=15*60000)loadGusts();}},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!panel.hidden)loadForecast();});
  window.addEventListener('online',()=>{if(!panel.hidden)loadForecast();});
  document.addEventListener('forecast-map-time',event=>{
    const wanted=event.detail.time;if(!Number.isFinite(wanted))return;selectedTime=wanted;
    if(!forecastRows.length)return;
    const i=forecastRows.reduce((best,row,index)=>Math.abs(row.time-wanted)<Math.abs(forecastRows[best].time-wanted)?index:best,0);
    $('forecastTimeline').value=String(i);renderSelected(false);selectedTime=wanted;
  });
})();
