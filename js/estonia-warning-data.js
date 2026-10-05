// Official Estonia XML uses Tallinn wall-clock times in its warning text.
// Date-only validity fields describe whole local calendar days, not UTC expiry.
function estoniaWarningTime(value,{endOfDay=false}={}){
  const text=String(value||'').trim();
  if(!text)return '';
  if(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)&&text.includes('T')){
    const ms=Date.parse(text);return Number.isFinite(ms)?new Date(ms).toISOString():'';
  }
  const match=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if(!match)return '';
  const [,year,month,day,hour='0',minute='0',second='0']=match;
  const wall=Date.UTC(+year,+month-1,+day,+hour,+minute,+second);
  const original=new Date(wall);
  if(original.getUTCFullYear()!==+year||original.getUTCMonth()!==+month-1||original.getUTCDate()!==+day||+hour>23||+minute>59||+second>59)return '';
  const target=wall+(!match[4]&&endOfDay?86400000:0);
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Tallinn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let utc=target;
  for(let i=0;i<4;i++){
    const parts=Object.fromEntries(formatter.formatToParts(new Date(utc)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const shown=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    if(shown===target)return new Date(utc).toISOString();
    utc+=target-shown;
  }
  return ''; // A nonexistent local time during a clock change is not invented.
}
function estoniaWarningValidity(effective,expires,description){
  const range=String(description||'').match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/);
  const start=range?estoniaWarningTime(range[1]):'',end=range?estoniaWarningTime(range[2]):'';
  const exactRange=start&&end&&Date.parse(end)>Date.parse(start);
  const fullTime=value=>/[ T]\d{2}:\d{2}/.test(String(value||''));
  return {
    effective:fullTime(effective)?estoniaWarningTime(effective):exactRange?start:estoniaWarningTime(effective),
    expires:fullTime(expires)?estoniaWarningTime(expires):exactRange?end:estoniaWarningTime(expires,{endOfDay:true})
  };
}

async function fetchEstoniaWarningForecast(){
  const response=await fetch('data/estonia-warnings.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Estonia forecast HTTP '+response.status);
  const snapshot=await response.json();
  const fetched=Date.parse(snapshot.fetchedAt);
  if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.records)||!Array.isArray(snapshot.forecastDays)||!Number.isFinite(fetched))throw new Error('Invalid Estonia forecast snapshot');
  if(Date.now()-fetched>6*60*60*1000||fetched>Date.now()+5*60*1000)throw new Error('Estonia forecast snapshot is out of date');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Tallinn',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!snapshot.forecastDays.includes(today))throw new Error('Estonia forecast does not cover today');
  if(snapshot.records.some(w=>!w.area||!w.event||![1,2,3].includes(w.level)||!Number.isFinite(Date.parse(w.effective))||!Number.isFinite(Date.parse(w.expires))||Date.parse(w.expires)<=Date.parse(w.effective)))throw new Error('Invalid Estonia forecast warning');
  return snapshot.records;
}

let estoniaMarineWarningGeometry=null,estoniaMarineWarningGeometryPending=null;
function loadEstoniaMarineWarningGeometry(){
  if(estoniaMarineWarningGeometry)return Promise.resolve(estoniaMarineWarningGeometry);
  if(estoniaMarineWarningGeometryPending)return estoniaMarineWarningGeometryPending;
  const promise=(async()=>{
    const response=await fetch('data/estonia-marine-warning-zones.geojson?v=8.60',{cache:'force-cache'});
    if(!response.ok)throw new Error('Marine coastline geometry HTTP '+response.status);
    const collection=await response.json();
    if(collection.type!=='FeatureCollection'||!collection.features?.length)throw new Error('Empty marine coastline geometry');
    const zones=new Map();
    for(const feature of collection.features){
      if(feature.type==='Feature'&&feature.properties?.area&&['Polygon','MultiPolygon'].includes(feature.geometry?.type))zones.set(normalizeMarineArea(feature.properties.area),feature);
    }
    if(zones.size!==6)throw new Error('Incomplete marine coastline geometry');
    estoniaMarineWarningGeometry=zones;return zones;
  })().finally(()=>{if(estoniaMarineWarningGeometryPending===promise)estoniaMarineWarningGeometryPending=null;});
  estoniaMarineWarningGeometryPending=promise;return promise;
}
