// Measured station labels load independently of the modeled particle animation.
const OFFICIAL_WIND_CHECK_MS=5*60*1000,OFFICIAL_WIND_MAX_AGE=3*3600;
const OFFICIAL_WIND_COUNTRIES=['EE','LV','LT','FI','SE','NO','DK','IS','PL','CA','GL','US'];
const OFFICIAL_WIND_COUNTRY_NAMES={EE:'Estonia',LV:'Latvia',LT:'Lithuania',FI:'Finland',SE:'Sweden',NO:'Norway',DK:'Denmark',IS:'Iceland',PL:'Poland',CA:'Canada',GL:'Greenland',US:'Florida, USA'};
const OFFICIAL_WIND_GUST_LABELS={
  EE:'Gust max · latest feed period',FI:'Gust max · 10 min',SE:'Gust max · 1 hour',NO:'Gust max · 1 hour',
  IS:'Gust max · latest observation',LV:'Gust max · observation period',LT:'Gust max · 1 hour',DK:'Max 3-sec mean · 10 min',
  GL:'Max 3-sec mean · 10 min',CA:'Instantaneous wind max · 10 min',US:'Measured gust',PL:'Gust max · 10 min'
};
const OFFICIAL_WIND_SOURCE_LINKS={
  US:'https://aviationweather.gov/data/metar/',EE:'https://www.ilmateenistus.ee/',FI:'https://en.ilmatieteenlaitos.fi/open-data',
  SE:'https://www.smhi.se/data/meteorologi/vind',NO:'https://seklima.met.no/',IS:'https://api.vedur.is/weather/',
  LV:'https://data.gov.lv/dati/lv/dataset/hidrometeorologiskie-noverojumi',LT:'https://api.meteo.lt/',PL:'https://danepubliczne.imgw.pl/',
  CA:'https://eccc-msc.github.io/open-data/msc-data/obs_station/readme_obs_insitu_en/',GL:'https://www.dmi.dk/friedata/',DK:'https://www.dmi.dk/friedata/'
};
let officialWindData=null,officialWindPromise=null,officialWindLoadedAt=0,officialWindRetryAt=0,officialWindFailed=false;
let officialWindHistoryData=null,officialWindHistoryPromise=null;
const officialWindLabels=L.layerGroup();
map.createPane('officialWindPane');map.getPane('officialWindPane').style.zIndex='625';
let officialWindRenderKey='';
if(typeof document!=='undefined'&&document.title)document.title=document.title.replace(/v\d+(?:\.\d+)*/, 'v8.128');
function officialWindEnabled(){return $('officialWindSustained').checked||$('officialWindGusts').checked;}
function officialWindNeeded(){return officialWindEnabled()||!!$('windHeatmapOn')?.checked;}
function windFieldVisible(){return !!($('windOn')?.checked||$('windHeatmapOn')?.checked);}
function setOfficialWindMeasurement(mode){
  const gust=mode==='gust';$('officialWindSustained').checked=!gust;$('officialWindGusts').checked=gust;officialWindRenderKey='';
}
function syncOfficialWindToField(){if(!windFieldVisible()||!officialWindEnabled())return;setOfficialWindMeasurement($('windMode').value==='gust'?'gust':'sustained');renderOfficialWind();}
function syncWindFieldToOfficial(){
  // Measured controls never change the modeled field. If the field is visible
  // and measurements remain enabled, keep the measured layer aligned to the
  // field's selected sustained/gust mode instead.
  if(!windFieldVisible()||!officialWindEnabled())return;
  syncOfficialWindToField();
}
$('windMode')?.addEventListener('change',syncOfficialWindToField);
function officialWindTime(){
  if(Number($('timeline').value)===Number($('timeline').max))return Math.floor(Date.now()/1000);
  return frames[Number($('timeline').value)]?.time||Math.floor(Date.now()/1000);
}
function validateOfficialWind(data,{maxRows=200}={}){
  const now=Date.now()/1000;
  if(data?.version!==1||data.units!=='m/s'||data.refreshMinutes!==10||!Number.isInteger(data.generatedAt)||data.generatedAt>now+300||!Array.isArray(data.stations)||data.stations.length>2500)throw new Error('Invalid official wind snapshot');
  const ids=new Set();
  for(const s of data.stations){
    const [south,north,west,east]=({CA:[41,84,-142,-52],GL:[59,84,-74,-10],US:[24,31,-88,-79]})[s.country]||[48.5,72.5,-26,33];
    if(!OFFICIAL_WIND_COUNTRIES.includes(s.country)||!data.sources?.[s.country]||typeof s.code!=='string'||!s.code||typeof s.name!=='string'||!Number.isFinite(s.lat)||s.lat<south||s.lat>north||!Number.isFinite(s.lon)||s.lon<west||s.lon>east||!Array.isArray(s.rows)||s.rows.length>maxRows)throw new Error('Invalid official wind station');
    const id=s.country+'/'+s.code;if(ids.has(id))throw new Error('Duplicate official wind station');ids.add(id);
    s.rows.forEach((r,i)=>{
      if(!Array.isArray(r)||r.length!==4||!Number.isInteger(r[0])||r[0]>data.generatedAt+60||(i&&r[0]<=s.rows[i-1][0])||
        r.slice(1).some((v,j)=>v!==null&&(!Number.isFinite(v)||v<0||v>(j===2?360:100)))||(r[1]===null&&r[2]===null))throw new Error('Invalid official wind observation');
    });
  }
  for(const c of OFFICIAL_WIND_COUNTRIES){
    const source=data.sources?.[c];if(!source)continue;
    if(!['ok','unavailable'].includes(source.status)||source.timeKind!==(c==='EE'?'feed':'observation'))throw new Error('Invalid wind source');
  }
  return data;
}
function officialWindReading(s,unix){
  const limit=Math.min(unix,Date.now()/1000);
  for(let i=s.rows.length-1;i>=0;i--){const r=s.rows[i];if(r[0]<=limit)return limit-r[0]<=OFFICIAL_WIND_MAX_AGE?r:null;}return null;
}
function officialWindHistoryRows(s,endUnix){
  const end=Math.min(endUnix,Date.now()/1000),start=end-24*3600;
  return s.rows.filter(r=>r[0]>=start&&r[0]<=end&&(r[1]!==null||r[2]!==null));
}
function officialWindHistoryGraph(s,endUnix){
  const rows=officialWindHistoryRows(s,endUnix);
  if(rows.length<2)return '<div class="wind-popup-meta" style="padding:10px 0 2px">Not enough measured history is available for this station yet.</div>';
  const W=304,H=154,L=31,R=7,T=11,B=28,plotW=W-L-R,plotH=H-T-B,start=rows[0][0],end=rows.at(-1)[0],span=Math.max(1,end-start);
  const values=rows.flatMap(r=>[r[1],r[2]]).filter(Number.isFinite),maxValue=Math.max(2,...values),yMax=Math.max(2,Math.ceil(maxValue/2)*2);
  const x=t=>L+(t-start)/span*plotW,y=v=>T+(1-v/yMax)*plotH;
  function path(column){let d='',drawing=false,lastTime=null;for(const r of rows){const v=r[column];if(v===null){drawing=false;lastTime=null;continue;}const gap=lastTime!==null&&r[0]-lastTime>3*3600;d+=(drawing&&!gap?'L':'M')+x(r[0]).toFixed(1)+' '+y(v).toFixed(1)+' ';drawing=true;lastTime=r[0];}return d.trim();}
  const sustained=path(1),gust=path(2),timeLabel=t=>new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),mid=(start+end)/2;
  const unit=globalThis.WeatherUnits?.windUnit()??'m/s',convert=v=>globalThis.WeatherUnits?.windValue(v)??v;
  return `<div style="margin-top:9px;border-top:1px solid #d7dfe5;padding-top:9px">
    <div class="wind-popup-meta" style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><strong style="color:#17202b">Measured history · 24 h</strong><span>${rows.length} obs</span></div>
    <div class="wind-popup-meta" style="display:flex;gap:12px;margin-bottom:3px"><span><i style="display:inline-block;width:12px;height:2px;background:#1689b5;vertical-align:middle;margin-right:4px"></i>Sustained</span><span><i style="display:inline-block;width:12px;height:2px;background:#d66b18;vertical-align:middle;margin-right:4px"></i>Gust</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="154" role="img" aria-label="24 hour measured wind history for ${htmlEscape(s.name)}">
      <g stroke="#d9e0e5" stroke-width="1"><line x1="${L}" y1="${T}" x2="${W-R}" y2="${T}"/><line x1="${L}" y1="${T+plotH/2}" x2="${W-R}" y2="${T+plotH/2}"/><line x1="${L}" y1="${T+plotH}" x2="${W-R}" y2="${T+plotH}"/></g>
      <g fill="#65727e" font-size="9" font-family="system-ui,sans-serif"><text x="${L-5}" y="${T+3}" text-anchor="end">${convert(yMax).toFixed(0)}</text><text x="${L-5}" y="${T+plotH/2+3}" text-anchor="end">${convert(yMax/2).toFixed(yMax<4?1:0)}</text><text x="${L-5}" y="${T+plotH+3}" text-anchor="end">0</text><text x="${L}" y="${H-7}">${timeLabel(start)}</text><text x="${L+plotW/2}" y="${H-7}" text-anchor="middle">${timeLabel(mid)}</text><text x="${W-R}" y="${H-7}" text-anchor="end">${timeLabel(end)}</text><text x="4" y="9">${unit}</text></g>
      ${sustained?`<path d="${sustained}" fill="none" stroke="#1689b5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`:''}${gust?`<path d="${gust}" fill="none" stroke="#d66b18" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`:''}
    </svg></div>`;
}
async function loadOfficialWindHistory(){
  if(officialWindHistoryData&&(!officialWindData||officialWindHistoryData.generatedAt>=officialWindData.generatedAt-60))return officialWindHistoryData;
  if(officialWindHistoryPromise)return officialWindHistoryPromise;
  officialWindHistoryPromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{const r=await fetch('data/official-wind-history.json',{cache:'no-cache',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);officialWindHistoryData=validateOfficialWind(await r.json(),{maxRows:1500});return officialWindHistoryData;}
    finally{clearTimeout(timer);}
  })();
  try{return await officialWindHistoryPromise;}finally{officialWindHistoryPromise=null;}
}
function officialWindHistoryStation(s){
  return officialWindHistoryData?.stations?.find(item=>item.country===s.country&&item.code===s.code)||null;
}
function officialWindHistoryPanel(s,endUnix){
  if(!officialWindHistoryData)return '<div class="wind-popup-meta" style="padding:10px 0 2px">Loading 24 h measured history…</div>';
  const station=officialWindHistoryStation(s);
  return station?officialWindHistoryGraph(station,endUnix):'<div class="wind-popup-meta" style="padding:10px 0 2px">24 h measured history is unavailable for this station.</div>';
}
function officialWindPopup(s,r){
  const source=officialWindData.sources[s.country],value=n=>n===null?'Unavailable':(globalThis.WeatherUnits?.windValue(n)??n).toFixed(1)+' <span>'+(globalThis.WeatherUnits?.windUnit()??'m/s')+'</span>';
  const direction=r[3]===null?'':`<div class="wind-popup-meta">Wind from ${Math.round(r[3])}°</div>`,old=officialWindTime()-r[0]>90*60;
  const gustLabel=OFFICIAL_WIND_GUST_LABELS[s.country]||'Wind gusts',sourceLink=s.code.startsWith('NDBC-')?'https://www.ndbc.noaa.gov/':OFFICIAL_WIND_SOURCE_LINKS[s.country],history=officialWindHistoryPanel(s,r[0]);
  return `<div class="wind-popup official-wind-popup"><div class="wind-popup-heading">${htmlEscape(s.name)}</div><div class="wind-popup-meta">Official station · ${OFFICIAL_WIND_COUNTRY_NAMES[s.country]}</div>
    <div class="wind-popup-readings"><div><div class="wind-popup-label">Sustained wind</div><div class="wind-popup-speed">${value(r[1])}</div></div><div><div class="wind-popup-label">${htmlEscape(gustLabel)}</div><div class="wind-popup-speed">${value(r[2])}</div></div></div>
    ${direction}<div class="wind-popup-meta">${source.timeKind==='feed'?'Source feed timestamp':'Observed'}: ${htmlEscape(fmt(r[0]))}${old?' · delayed reading':''}</div>
    <div class="wind-popup-meta">${htmlEscape(source.period||'Reported station measurements.')} Updated every 10 minutes on this map.</div>
    <div class="official-wind-history">${history}</div>
    <div class="wind-popup-meta" style="margin-top:7px"><a href="${sourceLink}" target="_blank" rel="noopener">${htmlEscape(source.name)}</a></div></div>`;
}
function renderOfficialWind(){
  if(!officialWindEnabled()){
    officialWindLabels.clearLayers();if(map.hasLayer(officialWindLabels))map.removeLayer(officialWindLabels);
    officialWindRenderKey='';$('officialWindStatus').textContent='Official station readings are off.';return;
  }
  if(!officialWindData){$('officialWindStatus').textContent=officialWindFailed?'Official wind observations could not load.':'Loading official station wind…';return;}
  const unix=officialWindTime(),sustained=$('officialWindSustained').checked,gusts=$('officialWindGusts').checked,bounds=map.getBounds();
  const key=[officialWindData.generatedAt,Math.floor(unix/60),bounds.toBBoxString(),map.getZoom(),sustained,gusts].join('/');
  const available=officialWindData.stations.map(s=>({s,r:officialWindReading(s,unix)})).filter(({r})=>r&&((sustained&&r[1]!==null)||(gusts&&r[2]!==null)));
  if(key!==officialWindRenderKey){
    officialWindLabels.clearLayers();const occupied=new Map(),width=(globalThis.WeatherUnits?.windUnit()==='km/h')?(sustained&&gusts?142:82):(sustained&&gusts?105:62),height=25;
    const candidates=available.filter(({s})=>bounds.contains([s.lat,s.lon])).sort((a,b)=>(gusts?b.r[2]??-1:b.r[1]??-1)-(gusts?a.r[2]??-1:a.r[1]??-1));
    for(const {s,r} of candidates){
      const p=map.latLngToContainerPoint([s.lat,s.lon]),cx=Math.floor(p.x/width),cy=Math.floor(p.y/height);let clashes=false;
      for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const q of occupied.get(x+','+y)||[])if(Math.abs(p.x-q.x)<width&&Math.abs(p.y-q.y)<height)clashes=true;
      if(clashes)continue;const cell=cx+','+cy;if(!occupied.has(cell))occupied.set(cell,[]);occupied.get(cell).push(p);
      const old=unix-r[0]>90*60,parts=[];
      if(sustained&&r[1]!==null)parts.push(`<span style="color:${windColour(r[1])}">${gusts?'S ':''}${(globalThis.WeatherUnits?.windValue(r[1])??r[1]).toFixed(1)}</span>`);
      if(gusts&&r[2]!==null)parts.push(`<span style="color:${windColour(r[2],'gust')}">${sustained?'G ':''}${(globalThis.WeatherUnits?.windValue(r[2])??r[2]).toFixed(1)}</span>`);
      const title=s.name+' · '+(sustained&&r[1]!==null?'Sustained '+(globalThis.WeatherUnits?.wind(r[1],1)??r[1].toFixed(1)+' m/s')+' · ':'')+(gusts&&r[2]!==null?'Gust '+(globalThis.WeatherUnits?.wind(r[2],1)??r[2].toFixed(1)+' m/s')+' · ':'')+fmt(r[0])+(old?' · delayed':'');
      const marker=L.marker([s.lat,s.lon],{pane:'officialWindPane',title,keyboard:true,icon:L.divIcon({className:'official-wind-marker',iconSize:[width,24],iconAnchor:[width/2,12],popupAnchor:[0,-12],html:`<span class="official-wind-label${old?' official-wind-delayed':''}">${parts.join(' <span class="official-wind-separator">/</span> ')} <small>${globalThis.WeatherUnits?.windUnit()??'m/s'}</small>${old?' ◷':''}</span>`})})
        .bindPopup(officialWindPopup(s,r),{className:'official-wind-popup-container',maxWidth:360,autoPan:false,keepInView:false});
      marker.on('popupopen',e=>{
        const root=e.popup.getElement();
        if(root){L.DomEvent.disableClickPropagation(root);L.DomEvent.disableScrollPropagation(root);}
        const refresh=()=>{
          if(!marker.isPopupOpen())return;
          marker.setPopupContent(officialWindPopup(s,r));
          marker.getPopup()?.update?.();
        };
        if(officialWindHistoryData){refresh();return;}
        loadOfficialWindHistory().then(refresh).catch(error=>{
          console.warn('Official wind history unavailable',error.message);
          if(!marker.isPopupOpen())return;
          marker.setPopupContent(officialWindPopup(s,r).replace('Loading 24 h measured history…','24 h measured history could not load.'));
          marker.getPopup()?.update?.();
        });
      });marker.addTo(officialWindLabels);
    }
    if(!map.hasLayer(officialWindLabels))officialWindLabels.addTo(map);officialWindRenderKey=key;
  }
  const countries=OFFICIAL_WIND_COUNTRIES.map(c=>{
    const source=officialWindData.sources?.[c],rows=available.filter(({s})=>s.country===c),latest=rows.length?Math.max(...rows.map(({r})=>r[0])):null;
    if(!source)return OFFICIAL_WIND_COUNTRY_NAMES[c]+': awaiting first refresh';
    return OFFICIAL_WIND_COUNTRY_NAMES[c]+': '+rows.length+' stations'+(latest?' · '+fmt(latest):' · no readings at this time')+(source.status==='unavailable'?' · source refresh failed':'');
  });
  $('officialWindStatus').textContent=countries.join(' | ')+'. '+officialWindLabels.getLayers().length+' labels in view · 10-minute updates'+(sustained&&gusts?' · S = sustained, G = gusts':'')+'.'+(officialWindFailed?' Latest snapshot refresh failed; showing retained readings.':'');
}
async function loadOfficialWind(force=false){
  if(!officialWindNeeded())return;if(officialWindPromise)return officialWindPromise;
  if(!force&&Date.now()-officialWindLoadedAt<OFFICIAL_WIND_CHECK_MS){
    renderOfficialWind();if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();
    if(!officialWindHistoryData&&!officialWindHistoryPromise)loadOfficialWindHistory().catch(error=>console.warn('Official wind history preload failed',error.message));
    return;
  }
  if(Date.now()<officialWindRetryAt){renderOfficialWind();return;}officialWindRetryAt=Date.now()+60000;
  officialWindPromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      const r=await fetch('data/official-wind.json',{cache:'no-cache',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);
      const next=validateOfficialWind(await r.json());if(officialWindHistoryData&&officialWindHistoryData.generatedAt<next.generatedAt-60)officialWindHistoryData=null;
      officialWindData=next;officialWindLoadedAt=Date.now();officialWindFailed=false;officialWindRenderKey='';if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();
      loadOfficialWindHistory().catch(error=>console.warn('Official wind history preload failed',error.message));
    }catch(e){officialWindFailed=true;console.warn('Official station wind unavailable',e.message);}
    finally{clearTimeout(timer);renderOfficialWind();if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();}
  })();
  try{await officialWindPromise;}finally{officialWindPromise=null;}
}
