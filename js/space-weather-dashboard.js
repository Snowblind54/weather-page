// Space Weather dashboard metadata, aurora-favorability colours and history charts.
(function(){
  'use strict';

  const panel=document.getElementById('spaceWeatherSection');
  if(!panel)return;

  const SNAPSHOT_URL='data/space-weather.json';
  const CLOUD_URL='data/aurora-cloud.json';
  const SPACE_REFRESH_MS=2*60*1000;
  const CLOUD_REFRESH_MS=30*60*1000;
  const STALE={
    power:30*60,
    wind:15*60,
    bz:15*60,
    kp:7*60*60,
    ovationForecastGrace:20*60,
    cloud:9*60*60
  };

  const METRICS={
    power:{valueId:'spacePowerValue',title:'Aurora power',unit:'GW',range:'24 h'},
    kp:{valueId:'spaceKpValue',title:'Planetary Kp',unit:'Kp',range:'72 h'},
    wind:{valueId:'spaceWindValue',title:'Solar-wind speed',unit:'km/s',range:'24 h'},
    bz:{valueId:'spaceBzValue',title:'IMF Bz',unit:'nT',range:'24 h'}
  };

  const FAVOURABILITY={
    weak:{label:'Weak',color:'#8fa4b8'},
    fair:{label:'Fair',color:'#6fc6d7'},
    good:{label:'Good',color:'#83e5cd'},
    strong:{label:'Strong',color:'#d7e86d'},
    excellent:{label:'Excellent',color:'#ff82ce'}
  };

  let spaceData=null,cloudMeta=null;
  let spaceFetchedAt=0,cloudFetchedAt=0;
  let spacePromise=null,cloudPromise=null;
  let openHistoryMetric=null;

  function $(id){return document.getElementById(id);}

  function unixTime(value){
    if(Number.isFinite(value))return value>1e12?value/1000:value;
    if(!value)return null;
    let text=String(value).trim();
    if(!/[zZ]|[+-]\d\d:?\d\d$/.test(text))text=text.replace(' ','T')+'Z';
    const ms=Date.parse(text);
    return Number.isFinite(ms)?ms/1000:null;
  }

  function shortTime(value){
    const unix=unixTime(value);
    if(!unix)return '—';
    return new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'}).format(new Date(unix*1000));
  }

  function graphTime(value){
    const unix=unixTime(value);
    if(!unix)return '—';
    return new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(unix*1000));
  }

  function ageText(value){
    const unix=unixTime(value);
    if(!unix)return null;
    const seconds=Math.max(0,Date.now()/1000-unix);
    if(seconds<90)return 'just now';
    if(seconds<3600)return Math.floor(seconds/60)+' min ago';
    if(seconds<86400){
      const hours=seconds/3600;
      return (hours<10?hours.toFixed(1):Math.floor(hours))+' h ago';
    }
    return Math.floor(seconds/86400)+' d ago';
  }

  function isStale(value,staleAfter){
    const unix=unixTime(value);
    if(!unix)return true;
    return Date.now()/1000-unix>staleAfter;
  }

  function setAge(id,value,staleAfter,staleReference=value,referenceGrace=staleAfter){
    const el=$(id);if(!el)return;
    const age=ageText(value);
    const stale=isStale(staleReference,referenceGrace);
    el.textContent=age?(stale?'Stale · updated ':'Updated ')+age:'Update time unavailable';
    el.classList.toggle('stale',stale);
    const metric=el.closest('.space-metric');
    if(metric)metric.classList.toggle('stale',stale);
  }

  function powerLabel(value){
    if(!Number.isFinite(value))return 'Unavailable';
    if(value<20)return 'Low';
    if(value<50)return 'Moderate';
    if(value<100)return 'Strong';
    return 'Very strong';
  }

  function favourability(metric,value){
    if(!Number.isFinite(value))return FAVOURABILITY.weak;
    if(metric==='power'){
      if(value<20)return FAVOURABILITY.weak;
      if(value<30)return FAVOURABILITY.fair;
      if(value<50)return FAVOURABILITY.good;
      if(value<80)return FAVOURABILITY.strong;
      return FAVOURABILITY.excellent;
    }
    if(metric==='kp'){
      if(value<2)return FAVOURABILITY.weak;
      if(value<3)return FAVOURABILITY.fair;
      if(value<4)return FAVOURABILITY.good;
      if(value<6)return FAVOURABILITY.strong;
      return FAVOURABILITY.excellent;
    }
    if(metric==='wind'){
      if(value<350)return FAVOURABILITY.weak;
      if(value<450)return FAVOURABILITY.fair;
      if(value<550)return FAVOURABILITY.good;
      if(value<700)return FAVOURABILITY.strong;
      return FAVOURABILITY.excellent;
    }
    if(metric==='bz'){
      // Southward (negative) IMF Bz couples more efficiently to Earth's field.
      if(value>=3)return FAVOURABILITY.weak;
      if(value>=0)return FAVOURABILITY.fair;
      if(value>=-5)return FAVOURABILITY.good;
      if(value>=-10)return FAVOURABILITY.strong;
      return FAVOURABILITY.excellent;
    }
    return FAVOURABILITY.weak;
  }

  function currentMetricValue(metric){
    if(!spaceData)return NaN;
    if(metric==='power')return Number(spaceData.hemisphericPower?.north);
    if(metric==='kp')return Number(spaceData.kp?.value);
    if(metric==='wind')return Number(spaceData.solarWind?.speed);
    if(metric==='bz')return Number(spaceData.solarWind?.bz);
    return NaN;
  }

  function setMetricColour(metric){
    const spec=METRICS[metric],value=currentMetricValue(metric);
    const valueEl=$(spec.valueId);if(!valueEl)return;
    const card=valueEl.closest('.space-metric');if(!card)return;
    const state=favourability(metric,value);
    card.dataset.favourability=state.label.toLowerCase();
    card.style.setProperty('--metric-color',state.color);
    valueEl.style.color=state.color;
    valueEl.title=`${state.label} for aurora activity`;
  }

  function historyRows(metric){
    let rows=[];
    if(metric==='power')rows=spaceData?.hemisphericPower?.history;
    else if(metric==='kp')rows=spaceData?.kp?.history;
    else if(metric==='wind')rows=spaceData?.solarWind?.speedHistory;
    else if(metric==='bz')rows=spaceData?.solarWind?.bzHistory;
    if(!Array.isArray(rows))return [];
    return rows.map(row=>[unixTime(row?.[0]),Number(row?.[1])])
      .filter(row=>Number.isFinite(row[0])&&Number.isFinite(row[1]))
      .sort((a,b)=>a[0]-b[0]);
  }

  function metricFormat(metric,value){
    if(!Number.isFinite(value))return '—';
    if(metric==='power')return `${Math.round(value)} GW`;
    if(metric==='kp')return value.toFixed(1);
    if(metric==='wind')return `${Math.round(value)} km/s`;
    if(metric==='bz')return `${value>0?'+':''}${value.toFixed(1)} nT`;
    return String(value);
  }

  function graphDomain(metric,values){
    let min=Math.min(...values),max=Math.max(...values);
    if(metric==='kp')return [0,Math.max(5,Math.ceil(max+1))];
    if(metric==='wind'){
      min=Math.max(200,Math.floor((min-40)/50)*50);
      max=Math.ceil((max+40)/50)*50;
    }else if(metric==='power'){
      min=0;max=Math.max(40,Math.ceil((max+10)/20)*20);
    }else if(metric==='bz'){
      min=Math.floor(Math.min(min-2,-5)/5)*5;
      max=Math.ceil(Math.max(max+2,5)/5)*5;
    }
    if(min===max){min-=1;max+=1;}
    return [min,max];
  }

  function graphPath(points,x,y,step=false){
    if(!points.length)return '';
    let path=`M ${x(points[0][0]).toFixed(2)} ${y(points[0][1]).toFixed(2)}`;
    for(let i=1;i<points.length;i++){
      const px=x(points[i][0]),py=y(points[i][1]);
      path+=step?` H ${px.toFixed(2)} V ${py.toFixed(2)}`:` L ${px.toFixed(2)} ${py.toFixed(2)}`;
    }
    return path;
  }

  function ensureHistoryDrawers(){
    const powerCard=$('spacePowerValue')?.closest('.space-metric');
    const kpCard=$('spaceKpValue')?.closest('.space-metric');
    const windCard=$('spaceWindValue')?.closest('.space-metric');
    const bzCard=$('spaceBzValue')?.closest('.space-metric');
    const cards={power:powerCard,kp:kpCard,wind:windCard,bz:bzCard};

    for(const [metric,card] of Object.entries(cards)){
      if(!card||card.dataset.historyMetric)continue;
      card.dataset.historyMetric=metric;
      card.tabIndex=0;
      card.setAttribute('role','button');
      card.setAttribute('aria-expanded','false');
      card.setAttribute('aria-label',`${METRICS[metric].title}. Click to show recent history.`);
      card.addEventListener('click',event=>{
        if(event.target.closest('.space-metric-info,.space-metric-help'))return;
        toggleHistory(metric);
      });
      card.addEventListener('keydown',event=>{
        if(event.key!=='Enter'&&event.key!==' ')return;
        event.preventDefault();toggleHistory(metric);
      });
    }

    for(const card of [powerCard,kpCard,windCard,bzCard]){
      const grid=card?.closest('.space-dashboard');
      if(!grid||grid.nextElementSibling?.classList.contains('space-history-drawer'))continue;
      const drawer=document.createElement('div');
      drawer.className='space-history-drawer';
      drawer.hidden=true;
      grid.insertAdjacentElement('afterend',drawer);
    }
  }

  function drawerForMetric(metric){
    return document.querySelector(`.space-metric[data-history-metric="${metric}"]`)?.closest('.space-dashboard')?.nextElementSibling;
  }

  function renderHistory(metric){
    const drawer=drawerForMetric(metric);if(!drawer)return;
    const rows=historyRows(metric),spec=METRICS[metric];
    const current=currentMetricValue(metric),state=favourability(metric,current);
    if(rows.length<2){
      drawer.innerHTML=`<div class="space-history-heading"><div><strong>${spec.title} history</strong><span>Recent ${spec.range}</span></div></div><div class="space-history-empty">History will appear after the next NOAA snapshot refresh.</div>`;
      return;
    }

    const W=360,H=150,L=38,R=10,T=16,B=25;
    const times=rows.map(row=>row[0]),values=rows.map(row=>row[1]);
    const t0=times[0],t1=times.at(-1),[v0,v1]=graphDomain(metric,values);
    const x=t=>L+(t-t0)/Math.max(1,t1-t0)*(W-L-R);
    const y=v=>T+(v1-v)/Math.max(.0001,v1-v0)*(H-T-B);
    const path=graphPath(rows,x,y,metric==='kp');
    const yTicks=[v1,(v0+v1)/2,v0];
    const grid=yTicks.map(v=>`<line x1="${L}" y1="${y(v).toFixed(2)}" x2="${W-R}" y2="${y(v).toFixed(2)}"/><text x="${L-5}" y="${(y(v)+3).toFixed(2)}" text-anchor="end">${metric==='kp'?v.toFixed(0):Math.round(v)}</text>`).join('');
    const zero=metric==='bz'&&v0<0&&v1>0?`<line class="space-history-zero" x1="${L}" y1="${y(0).toFixed(2)}" x2="${W-R}" y2="${y(0).toFixed(2)}"/>`:'';
    const last=rows.at(-1),min=Math.min(...values),max=Math.max(...values);

    drawer.innerHTML=`
      <div class="space-history-heading">
        <div><strong>${spec.title} history</strong><span>Recent ${spec.range}</span></div>
        <span class="space-history-current" style="color:${state.color}">${metricFormat(metric,current)}</span>
      </div>
      <svg class="space-history-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${spec.title} recent history">
        <g class="space-history-grid">${grid}</g>${zero}
        <path class="space-history-line" style="stroke:${state.color}" d="${path}"/>
        <circle class="space-history-dot" style="fill:${state.color}" cx="${x(last[0]).toFixed(2)}" cy="${y(last[1]).toFixed(2)}" r="3.2"/>
        <text class="space-history-time" x="${L}" y="${H-5}">${graphTime(t0)}</text>
        <text class="space-history-time" x="${W-R}" y="${H-5}" text-anchor="end">${graphTime(t1)}</text>
      </svg>
      <div class="space-history-stats"><span>Min <b>${metricFormat(metric,min)}</b></span><span>Max <b>${metricFormat(metric,max)}</b></span><span>${rows.length} points</span></div>`;
  }

  function toggleHistory(metric){
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshVisible(true);});

  ensureHistoryDrawers();
    const card=document.querySelector(`.space-metric[data-history-metric="${metric}"]`);
    const drawer=drawerForMetric(metric);if(!card||!drawer)return;
    const opening=openHistoryMetric!==metric||drawer.hidden;

    for(const item of panel.querySelectorAll('.space-history-drawer'))item.hidden=true;
    for(const item of panel.querySelectorAll('.space-metric[data-history-metric]')){
      item.classList.remove('history-open');item.setAttribute('aria-expanded','false');
    }
    openHistoryMetric=null;
    if(!opening)return;

    renderHistory(metric);
    drawer.hidden=false;
    card.classList.add('history-open');
    card.setAttribute('aria-expanded','true');
    openHistoryMetric=metric;
  }

  function updateSpaceDashboard(){
    if(!spaceData)return;
    const power=Number(spaceData.hemisphericPower?.north);
    const powerValue=$('spacePowerValue');
    const powerMeta=$('spacePowerMeta');
    if(powerValue)powerValue.textContent=Number.isFinite(power)?`${Math.round(power)} GW`:'—';
    if(powerMeta){
      const valid=shortTime(spaceData.hemisphericPower?.forecastTime);
      powerMeta.textContent=Number.isFinite(power)?`${powerLabel(power)} · forecast valid ${valid}`:'Awaiting NOAA hemispheric-power data';
    }

    for(const metric of Object.keys(METRICS))setMetricColour(metric);
    ensureHistoryDrawers();
    if(openHistoryMetric)renderHistory(openHistoryMetric);

    setAge('spacePowerAge',spaceData.hemisphericPower?.observationTime,STALE.power);
    setAge('spaceKpAge',spaceData.kp?.time,STALE.kp);
    setAge('spaceWindAge',spaceData.solarWind?.speedTime,STALE.wind);
    setAge('spaceBzAge',spaceData.solarWind?.magTime,STALE.bz);
    setAge(
      'spaceOvationAge',
      spaceData.aurora?.observationTime,
      STALE.ovationForecastGrace,
      spaceData.aurora?.forecastTime,
      STALE.ovationForecastGrace
    );
  }

  function updateCloudDashboard(){
    if(!cloudMeta)return;
    const valid=$('spaceCloudValid');
    if(valid)valid.textContent='Valid '+shortTime(cloudMeta.validTime);
    setAge('spaceCloudAge',cloudMeta.generatedAt||cloudMeta.runTime,STALE.cloud);
  }

  function updateAges(){
    updateSpaceDashboard();
    updateCloudDashboard();
  }

  async function fetchSpace(force=false){
    if(!force && spaceData && Date.now()-spaceFetchedAt<SPACE_REFRESH_MS)return spaceData;
    if(spacePromise)return spacePromise;
    spacePromise=(async()=>{
      const bucket=Math.floor(Date.now()/SPACE_REFRESH_MS);
      const response=await fetch(`${SNAPSHOT_URL}?dashboard=${bucket}`,{cache:'no-store'});
      if(!response.ok)throw new Error(`space weather HTTP ${response.status}`);
      spaceData=await response.json();
      spaceFetchedAt=Date.now();
      updateSpaceDashboard();
      return spaceData;
    })().finally(()=>{spacePromise=null;});
    return spacePromise;
  }

  async function fetchCloudMeta(force=false){
    if(!force && cloudMeta && Date.now()-cloudFetchedAt<CLOUD_REFRESH_MS)return cloudMeta;
    if(cloudPromise)return cloudPromise;
    cloudPromise=(async()=>{
      const bucket=Math.floor(Date.now()/CLOUD_REFRESH_MS);
      const response=await fetch(`${CLOUD_URL}?dashboard=${bucket}`,{cache:'no-store'});
      if(!response.ok)throw new Error(`ECMWF cloud HTTP ${response.status}`);
      const cloud=await response.json();
      cloudMeta={generatedAt:cloud.generatedAt,runTime:cloud.runTime,validTime:cloud.validTime};
      cloudFetchedAt=Date.now();
      updateCloudDashboard();
      return cloudMeta;
    })().finally(()=>{cloudPromise=null;});
    return cloudPromise;
  }

  function refreshVisible(force=false){
    if(panel.hidden)return;
    fetchSpace(force).catch(()=>{});
    fetchCloudMeta(force).catch(()=>{});
  }

  new MutationObserver(()=>{
    if(!panel.hidden)refreshVisible(false);
  }).observe(panel,{attributes:true,attributeFilter:['hidden']});

  $('spaceWeatherRefresh')?.addEventListener('click',()=>refreshVisible(true));

  setInterval(()=>{
    updateAges();
    refreshVisible(false);
  },60*1000);

  ensureHistoryDrawers();
  if(!panel.hidden)refreshVisible(false);
})();
