// Compact data-freshness dashboard for Northern Weather.
(function(){
  'use strict';

  const META_CACHE_MS=2*60*1000;
  const metaCache=new Map();
  let refreshTimer=null;

  function ensureCss(){
    if(document.querySelector('link[data-data-freshness]'))return;
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='css/data-freshness.css?v=1';link.dataset.dataFreshness='1';
    document.head.appendChild(link);
  }

  function ageSeconds(unix){return Number.isFinite(unix)?Math.max(0,Date.now()/1000-unix):null;}
  function ageText(seconds){
    if(seconds===null)return 'Not loaded';
    if(seconds<90)return Math.max(0,Math.round(seconds))+' sec';
    if(seconds<90*60)return Math.round(seconds/60)+' min';
    if(seconds<36*3600)return (seconds/3600).toFixed(seconds<10*3600?1:0)+' h';
    return (seconds/86400).toFixed(1)+' d';
  }
  function timeText(unix){
    if(!Number.isFinite(unix))return 'Timestamp unavailable';
    return new Date(unix*1000).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function freshnessState(age,good,warn){
    if(age===null)return 'idle';
    if(age<=good)return 'ok';
    if(age<=warn)return 'warn';
    return 'bad';
  }

  async function partialJsonMeta(path,keys,force=false){
    const cached=metaCache.get(path);
    if(!force&&cached&&Date.now()-cached.savedAt<META_CACHE_MS)return cached.values;
    const values={};
    try{
      const response=await fetch(path+'?freshness='+Math.floor(Date.now()/META_CACHE_MS),{
        cache:'no-store',headers:{Range:'bytes=0-32767'}
      });
      if(!response.ok)throw new Error('HTTP '+response.status);
      const reader=response.body?.getReader?.();
      let text='';
      if(reader){
        const decoder=new TextDecoder();
        for(let n=0;n<4&&text.length<32768;n++){
          const part=await reader.read();
          if(part.done)break;
          text+=decoder.decode(part.value,{stream:true});
          if(keys.every(key=>new RegExp('"'+key+'"\\s*:\\s*[-0-9.]+').test(text)))break;
        }
        try{await reader.cancel();}catch(_){}
      }else text=await response.text();
      for(const key of keys){
        const match=text.match(new RegExp('"'+key+'"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)'));
        if(match)values[key]=Number(match[1]);
      }
    }catch(error){
      console.warn('Freshness metadata unavailable for '+path,error);
    }
    metaCache.set(path,{savedAt:Date.now(),values});
    return values;
  }

  function newestTemperatureObservation(){
    if(typeof officialTemperatureStations==='undefined'||!officialTemperatureStations?.length)return null;
    let newest=null;
    for(const station of officialTemperatureStations)if(Number.isFinite(station.time)&&(newest===null||station.time>newest))newest=station.time;
    return newest;
  }
  function newestWindObservation(){
    if(typeof officialWindData==='undefined'||!officialWindData?.stations?.length)return null;
    let newest=null;
    for(const station of officialWindData.stations){
      const time=station.rows?.at(-1)?.[0];
      if(Number.isFinite(time)&&(newest===null||time>newest))newest=time;
    }
    return newest;
  }

  function rowHtml(item){
    const age=ageSeconds(item.time),state=freshnessState(age,item.good,item.warn);
    const detail=[item.detail,timeText(item.time)].filter(Boolean).join(' · ');
    return `<div class="freshness-row ${state}"><span class="freshness-dot ${state}" aria-hidden="true"></span><div><div class="freshness-name">${item.name}</div><div class="freshness-detail">${detail}</div></div><div class="freshness-age">${ageText(age)}</div></div>`;
  }

  async function collectRows(force=false){
    const tasks=[];

    let tempGenerated=Number(window.__officialTemperatureGeneratedAt)||null;
    if(!tempGenerated)tasks.push(partialJsonMeta('data/official-temperature.json',['generatedAt'],force).then(meta=>{tempGenerated=meta.generatedAt||null;}));

    let windGenerated=(typeof officialWindData!=='undefined'&&officialWindData?.generatedAt)||null;
    if(!windGenerated)tasks.push(partialJsonMeta('data/official-wind.json',['generatedAt'],force).then(meta=>{windGenerated=meta.generatedAt||null;}));

    let cycloneGenerated=(typeof cycloneData!=='undefined'&&cycloneData?.generatedAt)||null;
    let cycloneRun=(typeof cycloneData!=='undefined'&&cycloneData?.modelRun)||null;
    if(!cycloneGenerated)tasks.push(partialJsonMeta('data/cyclones.json',['generatedAt','modelRun'],force).then(meta=>{cycloneGenerated=meta.generatedAt||null;cycloneRun=meta.modelRun||null;}));

    let spaceGenerated=null;
    tasks.push(partialJsonMeta('data/space-weather.json',['generatedAt'],force).then(meta=>{spaceGenerated=meta.generatedAt||null;}));

    await Promise.allSettled(tasks);

    const radarFrame=(typeof radarTimelineFrames!=='undefined'&&radarTimelineFrames?.length)?radarTimelineFrames.at(-1):null;
    const radarTime=radarFrame?.url?radarFrame.time:null;
    const satelliteTime=Number(window.__cloudFreshnessTime)||null;
    const newestTemp=newestTemperatureObservation(),newestWind=newestWindObservation();

    return [
      {name:'Official temperature',time:tempGenerated,good:20*60,warn:60*60,
        detail:newestTemp?`Snapshot · newest obs ${ageText(ageSeconds(newestTemp))} old`:'Shared 10-minute snapshot'},
      {name:'Official wind',time:windGenerated,good:20*60,warn:60*60,
        detail:newestWind?`Snapshot · newest obs ${ageText(ageSeconds(newestWind))} old`:'Shared 10-minute snapshot'},
      {name:'Rain radar · Estonia',time:radarTime,good:15*60,warn:30*60,
        detail:radarFrame?.url?'Latest official KAIA frame':'Official radar timeline not available'},
      {name:'Satellite clouds',time:satelliteTime,good:20*60,warn:45*60,
        detail:satelliteTime?'Newest satellite observation currently rendered':'Open Clouds once to measure source time'},
      {name:'Cyclones / pressure',time:cycloneGenerated,good:2*3600,warn:6*3600,
        detail:cycloneRun?`GFS snapshot · model run ${ageText(ageSeconds(cycloneRun))} old`:'NOAA GFS snapshot'},
      {name:'Space weather',time:spaceGenerated,good:15*60,warn:45*60,
        detail:'NOAA SWPC shared snapshot'}
    ];
  }

  async function refresh(force=false){
    const list=document.getElementById('dataFreshnessList');
    const summary=document.getElementById('dataFreshnessSummary');
    if(!list||!summary)return;
    list.setAttribute('aria-busy','true');
    const rows=await collectRows(force);
    list.innerHTML=rows.map(rowHtml).join('');
    list.removeAttribute('aria-busy');

    const states=rows.map(item=>freshnessState(ageSeconds(item.time),item.good,item.warn));
    const overall=states.includes('bad')?'bad':states.includes('warn')?'warn':states.some(s=>s==='ok')?'ok':'idle';
    const words={ok:'Loaded feeds look fresh',warn:'One or more feeds are getting old',bad:'One or more feeds are stale',idle:'Waiting for data'};
    summary.innerHTML=`<span class="freshness-summary-dot ${overall}"></span><span>${words[overall]}</span>`;
    const button=document.getElementById('dataFreshnessButton');
    if(button)button.dataset.freshnessState=overall;
  }

  function close(){
    const panel=document.getElementById('dataFreshnessPanel'),button=document.getElementById('dataFreshnessButton');
    if(panel)panel.hidden=true;
    if(button)button.setAttribute('aria-expanded','false');
    if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null;}
  }

  function open(){
    const panel=document.getElementById('dataFreshnessPanel'),button=document.getElementById('dataFreshnessButton');
    if(!panel||!button)return;
    panel.hidden=false;button.setAttribute('aria-expanded','true');
    refresh(false);
    if(refreshTimer)clearInterval(refreshTimer);
    refreshTimer=setInterval(()=>refresh(false),30*1000);
  }

  function install(){
    if(document.getElementById('dataFreshnessButton'))return;
    ensureCss();
    const settings=document.getElementById('nav-mapSettings');
    if(!settings)return;

    const button=document.createElement('button');
    button.id='dataFreshnessButton';button.className='utility-button freshness-button';button.type='button';
    button.setAttribute('aria-label','Data freshness');button.setAttribute('aria-controls','dataFreshnessPanel');button.setAttribute('aria-expanded','false');
    button.title='Data freshness';
    button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h3l2-6 3 9 3-13 2 10h3"/><path d="M4 4v16h16"/></svg>';
    settings.parentNode.insertBefore(button,settings);

    const panel=document.createElement('div');
    panel.id='dataFreshnessPanel';panel.className='freshness-panel';panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-labelledby','dataFreshnessTitle');
    panel.innerHTML='<div class="panel-heading"><div><div class="eyebrow">SYSTEM STATUS</div><h2 id="dataFreshnessTitle">Data freshness</h2><p>Actual source and snapshot ages</p></div><div class="panel-actions"><button class="close-panel" id="dataFreshnessClose" aria-label="Close data freshness">×</button></div></div><div class="freshness-body"><div class="freshness-summary" id="dataFreshnessSummary"><span class="freshness-summary-dot idle"></span><span>Checking feeds…</span></div><div class="freshness-list" id="dataFreshnessList"></div><button class="freshness-refresh" id="dataFreshnessRefresh" type="button">Refresh freshness</button><div class="freshness-footer">Green = within the normal update window. Amber = delayed. Red = stale. “Not loaded” means the browser has not yet obtained a trustworthy source timestamp for that layer.</div></div>';
    document.body.appendChild(panel);

    button.addEventListener('click',event=>{event.stopPropagation();panel.hidden?open():close();});
    document.getElementById('dataFreshnessClose').addEventListener('click',close);
    document.getElementById('dataFreshnessRefresh').addEventListener('click',()=>refresh(true));
    panel.addEventListener('click',event=>event.stopPropagation());
    document.addEventListener('click',event=>{if(!panel.hidden&&!button.contains(event.target))close();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)close();});
  }

  install();
})();
