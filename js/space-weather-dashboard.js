// Space Weather dashboard metadata: NOAA hemispheric power + source-aware ages.
(function(){
  'use strict';

  const panel=document.getElementById('spaceWeatherSection');
  if(!panel)return;

  const SNAPSHOT_URL='data/space-weather.json';
  const CLOUD_URL='data/aurora-cloud.json';
  const SPACE_REFRESH_MS=5*60*1000;
  const CLOUD_REFRESH_MS=30*60*1000;
  const STALE={
    power:20*60,
    ovation:20*60,
    wind:15*60,
    bz:15*60,
    kp:4*60*60,
    cloud:9*60*60
  };

  let spaceData=null,cloudMeta=null;
  let spaceFetchedAt=0,cloudFetchedAt=0;
  let spacePromise=null,cloudPromise=null;

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

  function ageInfo(value,staleAfter){
    const unix=unixTime(value);
    if(!unix)return {text:'Update time unavailable',stale:true};
    const seconds=Math.max(0,Date.now()/1000-unix);
    let age;
    if(seconds<90)age='just now';
    else if(seconds<3600)age=Math.floor(seconds/60)+' min ago';
    else if(seconds<86400){
      const hours=seconds/3600;
      age=(hours<10?hours.toFixed(1):Math.floor(hours))+' h ago';
    }else age=Math.floor(seconds/86400)+' d ago';
    const stale=seconds>staleAfter;
    return {text:(stale?'Stale · updated ':'Updated ')+age,stale};
  }

  function setAge(id,value,staleAfter){
    const el=$(id);if(!el)return;
    const age=ageInfo(value,staleAfter);
    el.textContent=age.text;
    el.classList.toggle('stale',age.stale);
    const metric=el.closest('.space-metric');
    if(metric)metric.classList.toggle('stale',age.stale);
  }

  function powerLabel(value){
    if(!Number.isFinite(value))return 'Unavailable';
    if(value<20)return 'Low';
    if(value<50)return 'Moderate';
    if(value<100)return 'Strong';
    return 'Very strong';
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

    setAge('spacePowerAge',spaceData.hemisphericPower?.observationTime,STALE.power);
    setAge('spaceKpAge',spaceData.kp?.time,STALE.kp);
    setAge('spaceWindAge',spaceData.solarWind?.speedTime,STALE.wind);
    setAge('spaceBzAge',spaceData.solarWind?.magTime,STALE.bz);
    setAge('spaceOvationAge',spaceData.aurora?.observationTime,STALE.ovation);
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

  if(!panel.hidden)refreshVisible(false);
})();
