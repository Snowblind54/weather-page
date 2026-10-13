// Local CME countdowns. Data arrives through the existing shared space-weather snapshot.
(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
  if(!root.document)return;root.NorthernSolarEruptions=api;
  const panel=root.document.getElementById('spaceWeatherSection');if(!panel)return;
  const section=root.document.createElement('details');section.className='section space-cme-section';section.id='solarCmeSection';
  section.innerHTML=`<summary><span>Solar eruptions · CMEs</span><small>Last 7 days <span id="spaceCmeCount"></span></small></summary>
    <div class="space-cme-content"><div class="row"><label class="small"><input type="checkbox" id="spaceCmeAll"> Show all recent CMEs</label></div>
    <div id="spaceCmeAge" class="space-data-age">Awaiting shared CME data</div>
    <div id="spaceCmeList" class="space-cme-list"></div>
    <details class="space-cme-help"><summary>About CME arrivals &amp; sources</summary><p>NASA DONKI / Moon to Mars Space Weather Analysis Office supplies experimental CME analyses and WSA-ENLIL arrival forecasts. The list shows modelled Earth impacts first; enable “Show all” for other eruptions. Speed is not a storm-strength rating. Arrivals are estimates and can differ by hours. An elapsed countdown does not confirm arrival. A combined simulation may give several CMEs the same arrival time.</p><p>Dates use your device’s local time. G1–G5 describes the resulting geomagnetic storm at Earth, not the CME itself.</p><a href="https://ccmc.gsfc.nasa.gov/tools/DONKI/" target="_blank" rel="noopener">NASA DONKI ↗</a></details></div>`;
  panel.appendChild(section);
  const $=id=>root.document.getElementById(id);let data=null,signature='';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=v=>api.time(v)?new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'}).format(new Date(api.time(v))):'Unavailable';
  const link=u=>{try{const p=new URL(u);return p.protocol==='https:'&&['ccmc.gsfc.nasa.gov','kauai.ccmc.gsfc.nasa.gov','webtools.ccmc.gsfc.nasa.gov'].includes(p.hostname)?esc(p.href):null;}catch{return null;}};
  function render(){
    if(!data)return;const now=Date.now(),feed=data.solarEruptions,all=Array.isArray(feed?.entries)?feed.entries:[];
    const stale=api.stale(feed?.fetchedAt,now,2*3600),rows=api.recent(all,now,$('spaceCmeAll').checked);
    const age=api.time(feed?.fetchedAt);$('spaceCmeAge').textContent=age?(stale?'Updates overdue · ':'Updated ')+Math.max(0,Math.floor((now-age)/60000))+' min ago':'CME data unavailable';$('spaceCmeAge').classList.toggle('stale',stale);
    $('spaceCmeCount').textContent='· '+rows.length;
    const next=JSON.stringify([feed?.fetchedAt,rows]);
    if(next!==signature){
      signature=next;const open=new Set([...section.querySelectorAll('.space-cme-analysis[open]')].map(e=>e.dataset.cmeId));
      $('spaceCmeList').innerHTML=rows.length?rows.map(r=>{
        const title=api.impactLabel(r),source=link(r.sourceUrl),model=link(r.modelUrl);
        const error=api.uncertainty(r);
        return `<article class="space-cme-card"><h4>${esc(title)}</h4><div class="small">Detected ${esc(date(r.detectedAt))} · ${Number.isFinite(r.speed)&&r.speed>0?Math.round(r.speed).toLocaleString()+' km/s':'Speed unavailable'}</div>
          <dl><dt>Estimated arrival</dt><dd>${r.estimatedArrival?esc(date(r.estimatedArrival)):'Not supplied'}</dd><dt>Arrival uncertainty</dt><dd>${error?'± '+error+' hours (source)':'Not supplied by source'}</dd></dl>
          <strong class="space-cme-countdown" data-cme-id="${esc(r.id)}"></strong>
          <details class="space-cme-analysis" data-cme-id="${esc(r.id)}" ${open.has(r.id)?'open':''}><summary>Source analysis</summary><div class="small">${r.modelTime?'Model completed '+esc(date(r.modelTime)):'No arrival model supplied'}${r.combinedForecast?' · Combined CME forecast':''}</div><p>${esc(r.note||'No additional analysis supplied.')}</p>${source?`<a href="${source}" target="_blank" rel="noopener">NASA event ↗</a>`:''} ${model?`<a href="${model}" target="_blank" rel="noopener">Arrival model ↗</a>`:''}</details></article>`;
      }).join(''): '<div class="small space-cme-empty">'+(!feed?'Awaiting CME data.':$('spaceCmeAll').checked?'No reported CMEs in the last 7 days.':'No Earth impacts predicted among the reported CMEs. Enable “Show all” to see other recent eruptions.')+'</div>';
    }
    const lookup=new Map(rows.map(r=>[r.id,r]));for(const e of section.querySelectorAll('.space-cme-countdown'))e.textContent=api.countdown(lookup.get(e.dataset.cmeId),now,stale);
    const g=api.gState(data.geomagneticStorm,now),card=$('spaceGValue')?.closest('.space-metric');
    if($('spaceGValue'))$('spaceGValue').textContent=g.value;
    if($('spaceGMeta'))$('spaceGMeta').textContent=g.label;
    if($('spaceGAge')){$('spaceGAge').textContent=g.time?'NOAA current · '+date(g.time):'Current NOAA rating unavailable';$('spaceGAge').classList.toggle('stale',g.stale);}
    if(card){card.classList.toggle('stale',g.stale);card.style.setProperty('--metric-color',g.color);}
  }
  api.update=snapshot=>{data=snapshot;render();};
  $('spaceCmeAll').addEventListener('change',render);section.addEventListener('toggle',render);
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  function time(v){if(typeof v==='number')return Number.isFinite(v)?(v<1e12?v*1000:v):null;if(!v)return null;const n=Date.parse(v);return Number.isFinite(n)?n:null;}
  function stale(v,now,seconds){const t=time(v);return !t||now-t>seconds*1000||t>now+300000;}
  function recent(rows,now,all=false){return rows.filter(r=>time(r?.detectedAt)>=now-7*86400000&&time(r.detectedAt)<=now+300000&&(all||['expected','glancing','minor'].includes(r.earthImpact))).sort((a,b)=>time(b.detectedAt)-time(a.detectedAt));}
  function impactLabel(r){return ({expected:'Earth-directed CME',glancing:'Possible glancing Earth impact',minor:'Possible minor Earth impact','not-predicted':'No Earth impact predicted',unassessed:'CME · Earth impact not assessed'})[r?.earthImpact]||'CME · Earth impact not assessed';}
  function uncertainty(r){const n=r?.arrivalUncertaintyHours;return typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=72?n:null;}
  function countdown(r,now,isStale=false){
    if(!r)return '';if(isStale)return 'Forecast stale · arrival estimate needs an update';
    const eta=time(r.estimatedArrival);if(!eta)return r.earthImpact==='not-predicted'?'No Earth arrival forecast':'Awaiting arrival estimate';
    const remaining=eta-now;
    if(remaining<=0)return 'Estimated arrival time passed · arrival unconfirmed';
    if(remaining<60000)return 'Estimated arrival in less than a minute';
    const minutes=Math.ceil(remaining/60000),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
    if(days)return 'About '+days+' day'+(days===1?'':'s')+(hours%24?' '+hours%24+' h':'')+' remaining';
    return 'About '+(hours?hours+' h ':'')+(minutes%60?minutes%60+' min':'')+' remaining';
  }
  function gState(g,now){
    const n=g?.scale,valid=Number.isInteger(n)&&n>=0&&n<=5;
    if(!valid)return {value:'—',label:'Awaiting NOAA current rating',time:null,stale:true,color:'#8fa4b8'};
    const old=stale(g.time,now,30*60);return {value:'G'+n,label:(old?'Last reported · ':'')+['No geomagnetic storm','Minor storm','Moderate storm','Strong storm','Severe storm','Extreme storm'][n],time:g.time,stale:old,color:['#8fa4b8','#83e5cd','#d7e86d','#ffbf69','#ff946d','#ff82ce'][n]};
  }
  return {time,stale,recent,impactLabel,uncertainty,countdown,gState};
});
