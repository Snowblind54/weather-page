// Measured station labels load independently of the modeled particle animation.
const OFFICIAL_WIND_CHECK_MS=5*60*1000,OFFICIAL_WIND_MAX_AGE=3*3600;
const OFFICIAL_WIND_COUNTRIES=['EE','FI','SE','NO','IS'];
const OFFICIAL_WIND_COUNTRY_NAMES={EE:'Estonia',FI:'Finland',SE:'Sweden',NO:'Norway',IS:'Iceland'};
const OFFICIAL_WIND_SOURCE_LINKS={
  EE:'https://www.ilmateenistus.ee/',
  FI:'https://en.ilmatieteenlaitos.fi/open-data',
  SE:'https://www.smhi.se/data/meteorologi/vind',
  NO:'https://seklima.met.no/',
  IS:'https://api.vedur.is/weather/'
};
let officialWindData=null,officialWindPromise=null,officialWindLoadedAt=0,officialWindRetryAt=0,officialWindFailed=false;
const officialWindLabels=L.layerGroup();
map.createPane('officialWindPane');map.getPane('officialWindPane').style.zIndex='625';
let officialWindRenderKey='';
function officialWindEnabled(){return $('officialWindSustained').checked||$('officialWindGusts').checked;}
function officialWindTime(){
  // Latest means the latest available station feed; historical frames must not
  // borrow later measurements just because the radar's latest frame is older.
  if(Number($('timeline').value)===Number($('timeline').max))return Math.floor(Date.now()/1000);
  return frames[Number($('timeline').value)]?.time||Math.floor(Date.now()/1000);
}
function validateOfficialWind(data){
  const now=Date.now()/1000;
  if(data?.version!==1||data.units!=='m/s'||data.refreshMinutes!==60||!Number.isInteger(data.generatedAt)||data.generatedAt>now+300||!Array.isArray(data.stations)||data.stations.length>1500)throw new Error('Invalid official wind snapshot');
  const ids=new Set();
  for(const s of data.stations){
    if(!OFFICIAL_WIND_COUNTRIES.includes(s.country)||!data.sources?.[s.country]||typeof s.code!=='string'||!s.code||typeof s.name!=='string'||!Number.isFinite(s.lat)||s.lat<53||s.lat>72.5||!Number.isFinite(s.lon)||s.lon<-26||s.lon>33||!Array.isArray(s.rows)||s.rows.length>100)throw new Error('Invalid official wind station');
    const id=s.country+'/'+s.code;if(ids.has(id))throw new Error('Duplicate official wind station');ids.add(id);
    s.rows.forEach((r,i)=>{
      if(!Array.isArray(r)||r.length!==4||!Number.isInteger(r[0])||r[0]>data.generatedAt+60||(i&&r[0]<=s.rows[i-1][0])||
        r.slice(1).some((v,j)=>v!==null&&(!Number.isFinite(v)||v<0||v>(j===2?360:100)))||(r[1]===null&&r[2]===null))throw new Error('Invalid official wind observation');
    });
  }
  for(const c of OFFICIAL_WIND_COUNTRIES){
    const source=data.sources?.[c];
    // Missing new-country metadata is tolerated briefly during rollout, but any
    // station from that country above still requires its source to exist.
    if(!source)continue;
    if(!['ok','unavailable'].includes(source.status)||source.timeKind!==(c==='EE'?'feed':'observation'))throw new Error('Invalid wind source');
  }
  return data;
}
function officialWindReading(s,unix){
  const limit=Math.min(unix,Date.now()/1000);
  for(let i=s.rows.length-1;i>=0;i--){const r=s.rows[i];if(r[0]<=limit)return limit-r[0]<=OFFICIAL_WIND_MAX_AGE?r:null;}
  return null;
}
function officialWindPopup(s,r){
  const source=officialWindData.sources[s.country],value=n=>n===null?'Unavailable':n.toFixed(1)+' <span>m/s</span>';
  const direction=r[3]===null?'':`<div class="wind-popup-meta">Wind from ${Math.round(r[3])}°</div>`;
  const old=officialWindTime()-r[0]>90*60;
  return `<div class="wind-popup official-wind-popup"><div class="wind-popup-heading">${htmlEscape(s.name)}</div><div class="wind-popup-meta">Official station · ${OFFICIAL_WIND_COUNTRY_NAMES[s.country]}</div>
    <div class="wind-popup-readings"><div><div class="wind-popup-label">Sustained wind</div><div class="wind-popup-speed">${value(r[1])}</div></div><div><div class="wind-popup-label">Wind gusts</div><div class="wind-popup-speed">${value(r[2])}</div></div></div>
    ${direction}<div class="wind-popup-meta">${source.timeKind==='feed'?'Source feed timestamp':'Observed'}: ${htmlEscape(fmt(r[0]))}${old?' · delayed reading':''}</div>
    <div class="wind-popup-meta">${htmlEscape(source.period||'Reported station measurements.')} Updated hourly on this map.</div>
    <div class="wind-popup-meta"><a href="${OFFICIAL_WIND_SOURCE_LINKS[s.country]}" target="_blank" rel="noopener">${htmlEscape(source.name)}</a></div></div>`;
}
function renderOfficialWind(){
  if(!officialWindEnabled()){
    officialWindLabels.clearLayers();if(map.hasLayer(officialWindLabels))map.removeLayer(officialWindLabels);
    officialWindRenderKey='';$('officialWindStatus').textContent='Official station readings are off.';return;
  }
  if(!officialWindData){$('officialWindStatus').textContent=officialWindFailed?'Official wind observations could not load.':'Loading official station wind…';return;}
  const unix=officialWindTime(),sustained=$('officialWindSustained').checked,gusts=$('officialWindGusts').checked;
  const bounds=map.getBounds(),key=[officialWindData.generatedAt,Math.floor(unix/60),bounds.toBBoxString(),map.getZoom(),sustained,gusts].join('/');
  const available=officialWindData.stations.map(s=>({s,r:officialWindReading(s,unix)})).filter(({r})=>r&&((sustained&&r[1]!==null)||(gusts&&r[2]!==null)));
  if(key!==officialWindRenderKey){
    officialWindLabels.clearLayers();const occupied=new Map(),width=sustained&&gusts?105:62,height=25;
    const candidates=available.filter(({s})=>bounds.contains([s.lat,s.lon])).sort((a,b)=>(gusts?b.r[2]??-1:b.r[1]??-1)-(gusts?a.r[2]??-1:a.r[1]??-1));
    for(const {s,r} of candidates){
      const p=map.latLngToContainerPoint([s.lat,s.lon]),cx=Math.floor(p.x/width),cy=Math.floor(p.y/height);let clashes=false;
      for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const q of occupied.get(x+','+y)||[])if(Math.abs(p.x-q.x)<width&&Math.abs(p.y-q.y)<height)clashes=true;
      if(clashes)continue;const cell=cx+','+cy;if(!occupied.has(cell))occupied.set(cell,[]);occupied.get(cell).push(p);
      const old=unix-r[0]>90*60,parts=[];
      if(sustained&&r[1]!==null)parts.push(`<span style="color:${windColour(r[1])}">${gusts?'S ':''}${r[1].toFixed(1)}</span>`);
      if(gusts&&r[2]!==null)parts.push(`<span style="color:${windColour(r[2],'gust')}">${sustained?'G ':''}${r[2].toFixed(1)}</span>`);
      const title=s.name+' · '+(sustained&&r[1]!==null?'Sustained '+r[1].toFixed(1)+' m/s · ':'')+(gusts&&r[2]!==null?'Gust '+r[2].toFixed(1)+' m/s · ':'')+fmt(r[0])+(old?' · delayed':'');
      L.marker([s.lat,s.lon],{pane:'officialWindPane',title,keyboard:true,icon:L.divIcon({className:'official-wind-marker',iconSize:[width,24],iconAnchor:[width/2,12],popupAnchor:[0,-12],html:`<span class="official-wind-label${old?' official-wind-delayed':''}">${parts.join(' <span class="official-wind-separator">/</span> ')} <small>m/s</small>${old?' ◷':''}</span>`})})
        .bindPopup(officialWindPopup(s,r),{className:'official-wind-popup-container',maxWidth:330,autoPan:false,keepInView:false}).addTo(officialWindLabels);
    }
    if(!map.hasLayer(officialWindLabels))officialWindLabels.addTo(map);officialWindRenderKey=key;
  }
  const countries=OFFICIAL_WIND_COUNTRIES.map(c=>{
    const source=officialWindData.sources?.[c],rows=available.filter(({s})=>s.country===c),latest=rows.length?Math.max(...rows.map(({r})=>r[0])):null;
    if(!source)return OFFICIAL_WIND_COUNTRY_NAMES[c]+': awaiting first refresh';
    return OFFICIAL_WIND_COUNTRY_NAMES[c]+': '+rows.length+' stations'+(latest?' · '+fmt(latest):' · no readings at this time')+(source.status==='unavailable'?' · source refresh failed':'');
  });
  $('officialWindStatus').textContent=countries.join(' | ')+'. '+officialWindLabels.getLayers().length+' labels in view · hourly updates'+(sustained&&gusts?' · S = sustained, G = gusts':'')+'.'+(officialWindFailed?' Latest snapshot refresh failed; showing retained readings.':'');
}
async function loadOfficialWind(force=false){
  if(!officialWindEnabled())return;
  if(officialWindPromise)return officialWindPromise;
  if(!force&&Date.now()-officialWindLoadedAt<OFFICIAL_WIND_CHECK_MS){renderOfficialWind();return;}
  if(Date.now()<officialWindRetryAt){renderOfficialWind();return;}
  officialWindRetryAt=Date.now()+60000;
  officialWindPromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{const r=await fetch('data/official-wind.json',{cache:'no-cache',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);
      officialWindData=validateOfficialWind(await r.json());officialWindLoadedAt=Date.now();officialWindFailed=false;officialWindRenderKey='';
    }catch(e){officialWindFailed=true;console.warn('Official station wind unavailable',e.message);}
    finally{clearTimeout(timer);if(officialWindEnabled())renderOfficialWind();}
  })();
  try{await officialWindPromise;}finally{officialWindPromise=null;}
}
for(const id of ['officialWindSustained','officialWindGusts'])$(id).addEventListener('change',()=>{
  renderOfficialWind();if(officialWindEnabled())loadOfficialWind();
});
map.on('moveend zoomend',renderOfficialWind);
setInterval(()=>{if(officialWindEnabled()&&!document.hidden)loadOfficialWind();},OFFICIAL_WIND_CHECK_MS);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&officialWindEnabled()){renderOfficialWind();loadOfficialWind();}});
