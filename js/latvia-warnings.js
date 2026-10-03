// LVGMC has real polygons, but does not enable cross-origin browser requests.
// GitHub Actions publishes the public feed as JSON; raw GitHub allows CORS.
const LATVIA_WARNING_URL='https://raw.githubusercontent.com/Snowblind54/weather-page/main/data/latvia-warnings.json';
const LATVIA_WARNING_MAX_AGE=60*60*1000;
let latviaWarningSnapshotUpdatedAt=null;
const LATVIA_WARNING_CACHE_KEY='weatherMapLatviaWarningsV89';

function validateLatviaSnapshot(data){
  if(data?.version!==1||!Number.isFinite(Date.parse(data.updatedAt))||!Array.isArray(data.records))
    throw new Error('Invalid Latvia warning snapshot');
  const age=Date.now()-Date.parse(data.updatedAt);
  if(age< -5*60*1000)
    throw new Error('Invalid Latvia warning update time');
  for(const record of data.records){
    if(record.country!=='Latvia'||!Array.isArray(record.polygons)||!record.polygons.length ||
      !record.polygons.every(p=>Array.isArray(p)&&p.length>=3&&p.every(point=>
        Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)&&
        Math.abs(point[0])<=90&&Math.abs(point[1])<=180)))
      throw new Error('Invalid Latvia warning geometry');
  }
  latviaWarningSnapshotUpdatedAt=data.updatedAt;
  return data.records.filter(record=>{
    const expiry=Date.parse(record.expires);
    return Number.isFinite(expiry)&&expiry>Date.now();
  }).map(record=>({...record,sourceUpdatedAt:data.updatedAt}));
}

async function loadLatviaWarnings(){
  let lastError;
  for(const url of [LATVIA_WARNING_URL,'data/latvia-warnings.json']){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),10000);
    try{
      const response=await fetch(url,{cache:'no-store',signal:ctrl.signal});
      if(!response.ok) throw new Error('Latvia warnings HTTP '+response.status);
      const data=await response.json();
      const records=validateLatviaSnapshot(data);
      try{localStorage.setItem(LATVIA_WARNING_CACHE_KEY,JSON.stringify(data));}catch(_){}
      return {records,official:true,updatedAt:data.updatedAt};
    }catch(error){lastError=error;}finally{clearTimeout(timer);}
  }
  try{
    const cached=JSON.parse(localStorage.getItem(LATVIA_WARNING_CACHE_KEY));
    return {records:validateLatviaSnapshot(cached),official:true,fromCache:true};
  }catch(_){}
  throw lastError||new Error('Latvia warning feed unavailable');
}
