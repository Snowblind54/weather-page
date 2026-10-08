// Official IMGW, DMI and ECCC warning polygons, copied directly
// from their national feeds by the scheduled repository updater.
const NATIONAL_WARNING_URL='https://raw.githubusercontent.com/Snowblind54/weather-page/main/data/national-warnings.json';
const NATIONAL_WARNING_MAX_AGE=60*60*1000;
const NATIONAL_WARNING_CACHE_KEY='weatherMapNationalWarningsV8107';
let nationalWarningSnapshotPromise=null;
let nationalWarningSnapshot=null;
let nationalWarningSnapshotFetchedAt=0;

function validNationalWarningPolygon(polygon){
  if(!Array.isArray(polygon) || !polygon.length) return false;
  // Polygons may have interior holes: [outer ring, inner ring, ...].
  const rings=Array.isArray(polygon[0]?.[0])?polygon:[polygon];
  return rings.every(ring=>Array.isArray(ring) && ring.length>=3 && ring.every(point=>
    Array.isArray(point) && point.length===2 && point.every(Number.isFinite) &&
    Math.abs(point[0])<=90 && Math.abs(point[1])<=180));
}

function validateNationalWarningCountry(data,code){
  const name=({PL:'Poland',DK:'Denmark',GL:'Greenland',CA:'Canada'})[code];
  const country=data?.countries?.[code];
  const updated=Date.parse(country?.updatedAt);
  if(data?.version!==1 || country?.country!==name || !Array.isArray(country.records) ||
     !Number.isFinite(updated) || updated>Date.now()+5*60*1000){
    throw new Error(name+' official warning data invalid');
  }
  for(const record of country.records){
    if(record.country!==name || !['Moderate','Severe','Extreme',...(code==='CA'?['Information']:[])].includes(record.level) ||
       !Number.isFinite(Date.parse(record.expires)) || !Number.isFinite(Date.parse(record.effective)) ||
       (code==='CA' && !Number.isFinite(Date.parse(record.messageExpires))) ||
       !record.polygons?.length || !record.polygons.every(validNationalWarningPolygon)){
      throw new Error(name+' official warning data invalid');
    }
  }
  return country.records.filter(record=>Date.parse(record.expires)>Date.now() &&
    (!record.messageExpires || Date.parse(record.messageExpires)>Date.now()))
    .map(record=>({...record,sourceUpdatedAt:country.updatedAt}));
}

async function fetchNationalWarningSnapshot(){
  // All supported countries share a single snapshot request.
  if(nationalWarningSnapshot && Date.now()-nationalWarningSnapshotFetchedAt<30000) return nationalWarningSnapshot;
  if(nationalWarningSnapshotPromise) return nationalWarningSnapshotPromise;
  nationalWarningSnapshotPromise=(async()=>{
    let lastError;
    for(const url of [NATIONAL_WARNING_URL,'data/national-warnings.json']){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),10000);
      try{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok) throw new Error('National warning snapshot HTTP '+response.status);
        const data=await response.json();
        if(data?.version!==1 || !data.countries) throw new Error('Invalid national warning snapshot');
        nationalWarningSnapshot=data;
        nationalWarningSnapshotFetchedAt=Date.now();
        try{localStorage.setItem(NATIONAL_WARNING_CACHE_KEY,JSON.stringify(data));}catch(_){}
        return data;
      }catch(error){lastError=error;}finally{clearTimeout(timer);}
    }
    try{
      const cached=JSON.parse(localStorage.getItem(NATIONAL_WARNING_CACHE_KEY));
      if(cached?.version===1) return cached;
    }catch(_){}
    throw lastError||new Error('National warning feeds unavailable');
  })();
  try{return await nationalWarningSnapshotPromise;}finally{nationalWarningSnapshotPromise=null;}
}

async function loadNationalWarningCountry(code){
  const data=await fetchNationalWarningSnapshot();
  return {records:validateNationalWarningCountry(data,code),official:true,updatedAt:data.countries[code].updatedAt};
}
