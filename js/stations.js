// Official national weather-station temperature observations.
// Loaded only when the temperature layer is enabled. The heatmap remains the
// terrain-aware model field; these observations take priority for numeric map
// labels when their timestamp is close to the selected timeline frame.

const OFFICIAL_TEMP_REFRESH_MS=10*60*1000;
const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV812';
const OFFICIAL_TEMP_CACHE_MAX_AGE=45*60*1000;
const OFFICIAL_TEMP_LABEL_MAX_OFFSET=95*60;

let officialTemperatureStations=[];
let officialTemperatureLoadedAt=0;
let officialTemperatureLoadPromise=null;
let officialTemperatureSourceState={};
const officialTempFetches=new Map();

function officialTempProxyUrl(url){
  return 'https://proxy.cors.dev/'+url;
}

async function officialTempFetch(url,{json=false,timeout=14000}={}){
  const key=(json?'json|':'text|')+url;
  if(officialTempFetches.has(key))return officialTempFetches.get(key);
  const promise=fetchOfficialTempResponse(url,{json,timeout});
  officialTempFetches.set(key,promise);
  try{return await promise;}
  finally{if(officialTempFetches.get(key)===promise)officialTempFetches.delete(key);}
}

async function fetchOfficialTempResponse(url,{json=false,timeout=14000}={}){
  const attempt=async target=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetch(target,{
        // Revalidate cached responses with the provider; never serve an
        // unchecked cached observation, but permit a lightweight HTTP 304.
        cache:'no-cache',
        signal:controller.signal,
        headers:{'Accept':json?'application/json,text/plain,*/*':'application/xml,text/xml,text/html,text/plain,*/*'}
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      if(json) return await response.json();
      const text=await response.text();
      if(!text.trim()) throw new Error('empty response');
      return text;
    }finally{
      clearTimeout(timer);
    }
  };

  try{
    return await attempt(url);
  }catch(directError){
    try{
      return await attempt(officialTempProxyUrl(url));
    }catch(proxyError){
      throw new Error(proxyError?.message||directError?.message||'network error');
    }
  }
}

function officialTempArray(payload,keys=[]){
  if(Array.isArray(payload)) return payload;
  if(payload && typeof payload==='object'){
    for(const key of [...keys,'stations','observations','results','data','items']){
      if(Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

function officialTempNumber(...values){
  for(const value of values){
    if(value==null || (typeof value==='string' && !value.trim())) continue;
    const n=Number(value);
    if(Number.isFinite(n)) return n;
  }
  return NaN;
}

function officialTempTime(value){
  if(value==null || value==='') return NaN;
  const n=Number(value);
  if(Number.isFinite(n)){
    // SMHI uses milliseconds since epoch; tolerate seconds as well.
    return n>1e11 ? Math.floor(n/1000) : Math.floor(n);
  }
  const text=String(value).trim().replace(/^(\d{4}-\d{2}-\d{2}) /,'$1T');
  const ms=Date.parse(text.match(/[zZ]|[+-]\d\d:?\d\d$/)?text:text+'Z');
  return Number.isFinite(ms)?Math.floor(ms/1000):NaN;
}

function officialTempCoord(record){
  const c=record?.coordinates || record?.coordinate || record?.location || record || {};
  let lat=officialTempNumber(c.latitude,c.lat,record?.latitude,record?.lat);
  let lon=officialTempNumber(c.longitude,c.lon,c.lng,record?.longitude,record?.lon,record?.lng);

  if((!Number.isFinite(lat) || !Number.isFinite(lon)) && Array.isArray(c) && c.length>=2){
    // Meteo APIs generally expose GeoJSON-like [lon,lat] arrays when an array
    // is used. Reject impossible order and swap only when needed.
    let a=Number(c[0]),b=Number(c[1]);
    if(Number.isFinite(a) && Number.isFinite(b)){
      if(Math.abs(a)<=90 && Math.abs(b)<=180){
        lon=a; lat=b;
      }
    }
  }

  return {lat,lon};
}

function officialTempValid(lat,lon,temp){
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat>=48.5 && lat<=72.5 && lon>=-26 && lon<=33 &&
    Number.isFinite(temp) && temp>-70 && temp<55;
}

function officialTempRecord({country,code,name,lat,lon,temp,time,source}){
  lat=officialTempNumber(lat); lon=officialTempNumber(lon); temp=officialTempNumber(temp);
  if(!officialTempValid(lat,lon,temp)) return null;
  return {
    country,code:String(code||''),name:String(name||'Weather station'),
    lat,lon,temp,time:Number.isFinite(Number(time))?Number(time):NaN,
    source:String(source||'Official weather service')
  };
}

function officialTempDedup(records){
  const byKey=new Map();
  for(const record of records.filter(Boolean)){
    const key=record.country+'|'+(record.code||record.lat.toFixed(3)+','+record.lon.toFixed(3));
    const current=byKey.get(key);
    if(!current || (!Number.isFinite(current.time) && Number.isFinite(record.time)) ||
       (Number.isFinite(record.time) && record.time>current.time)){
      byKey.set(key,record);
    }
  }
  return [...byKey.values()];
}

function saveOfficialTemperatureCache(){
  try{
    localStorage.setItem(OFFICIAL_TEMP_CACHE_KEY,JSON.stringify({
      savedAt:Date.now(),
      stations:officialTemperatureStations,
      sources:officialTemperatureSourceState
    }));
  }catch(_){}
}

function restoreOfficialTemperatureCache(){
  try{
    const raw=localStorage.getItem(OFFICIAL_TEMP_CACHE_KEY);
    if(!raw) return false;
    const cached=JSON.parse(raw);
    if(!cached?.savedAt || Date.now()-cached.savedAt>OFFICIAL_TEMP_CACHE_MAX_AGE || !Array.isArray(cached.stations)) return false;
    officialTemperatureStations=cached.stations;
    officialTemperatureSourceState=cached.sources||{};
    officialTemperatureLoadedAt=cached.savedAt;
    return officialTemperatureStations.length>0;
  }catch(_){
    return false;
  }
}

function xmlDirectText(root,name){
  const lower=name.toLowerCase();
  const nodes=[...root.getElementsByTagName('*')];
  const el=nodes.find(node=>(node.localName||node.tagName||'').toLowerCase()===lower);
  return (el?.textContent||'').trim();
}

async function loadEstoniaOfficialTemperature(){
  const url='https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php';
  const text=await officialTempFetch(url);
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('XML parse failed');

  const root=doc.documentElement;
  const rootTimestamp=officialTempTime(root?.getAttribute?.('timestamp'));
  const out=[];

  for(const station of [...doc.getElementsByTagName('station')]){
    const lat=officialTempNumber(xmlDirectText(station,'latitude'));
    const lon=officialTempNumber(xmlDirectText(station,'longitude'));
    const temp=officialTempNumber(xmlDirectText(station,'airtemperature'));
    const name=xmlDirectText(station,'name')||'Estonian station';
    const code=xmlDirectText(station,'wmocode')||xmlDirectText(station,'stationcode')||name;
    out.push(officialTempRecord({
      country:'EE',code,name,lat,lon,temp,time:rootTimestamp,
      source:'Estonian Environment Agency'
    }));
  }
  return officialTempDedup(out);
}

async function mapPool(items,limit,worker){
  const out=[];
  let next=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){
      const index=next++;
      if(index>=items.length) return;
      try{
        const value=await worker(items[index],index);
        if(Array.isArray(value)) out.push(...value.filter(Boolean));
        else if(value) out.push(value);
      }catch(e){
        console.warn('Official temperature station request skipped',e);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadLithuaniaOfficialTemperature(){
  const base='https://api.meteo.lt/v1';
  const payload=await officialTempFetch(base+'/stations',{json:true});
  const stations=officialTempArray(payload,['stations']).slice(0,45);

  return officialTempDedup(await mapPool(stations,6,async station=>{
    const code=station.code||station.stationCode||station.id;
    if(!code) return null;
    const data=await officialTempFetch(base+'/stations/'+encodeURIComponent(code)+'/observations/latest',{json:true,timeout:12000});
    const observations=officialTempArray(data,['observations']);
    let best=null;
    for(const observation of observations){
      const temp=officialTempNumber(observation.airTemperature,observation.temperature,observation.t);
      const time=officialTempTime(observation.observationTimeUtc||observation.time||observation.date);
      if(!Number.isFinite(temp)) continue;
      if(!best || (Number.isFinite(time) && time>best.time)) best={temp,time};
    }
    if(!best) return null;
    const details=data.station||station;
    const {lat,lon}=officialTempCoord(details);
    return officialTempRecord({
      country:'LT',code,name:details.name||station.name||String(code),
      lat,lon,temp:best.temp,time:best.time,
      source:'Lithuanian Hydrometeorological Service / Meteo.lt'
    });
  }));
}

function localXmlElements(root,name){
  return [...root.getElementsByTagName('*')].filter(el=>el.localName===name);
}

function localXmlText(root,name){
  return (localXmlElements(root,name)[0]?.textContent||'').trim();
}

async function loadFinlandOfficialTemperature(){
  const end=new Date();
  const start=new Date(end.getTime()-100*60*1000);
  const params=new URLSearchParams({
    service:'WFS',version:'2.0.0',request:'getFeature',
    storedquery_id:'fmi::observations::weather::simple',
    bbox:'19,59,32,71.7',
    starttime:start.toISOString(),endtime:end.toISOString(),
    timestep:'10',parameters:'t2m'
  });
  const url='https://opendata.fmi.fi/wfs?'+params.toString();
  const text=await officialTempFetch(url,{timeout:18000});
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('WFS XML parse failed');

  const out=[];
  for(const element of localXmlElements(doc,'BsWfsElement')){
    const parameter=localXmlText(element,'ParameterName').toLowerCase();
    if(parameter && parameter!=='t2m' && !parameter.includes('temperature')) continue;
    const temp=officialTempNumber(localXmlText(element,'ParameterValue'));
    const time=officialTempTime(localXmlText(element,'Time'));
    const pos=localXmlText(element,'pos').split(/\s+/).map(Number);
    if(pos.length<2) continue;
    const lat=pos[0],lon=pos[1];
    const name=localXmlText(element,'LocationName')||localXmlText(element,'StationName')||'FMI station';
    const code=localXmlText(element,'fmisid')||lat.toFixed(4)+','+lon.toFixed(4);
    out.push(officialTempRecord({
      country:'FI',code,name,lat,lon,temp,time,
      source:'Finnish Meteorological Institute (FMI)'
    }));
  }
  return officialTempDedup(out);
}

async function loadSwedenOfficialTemperature(){
  const url='https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/1/station-set/all/period/latest-hour/data.json';
  const data=await officialTempFetch(url,{json:true,timeout:16000});
  const stations=officialTempArray(data,['station']);
  const out=[];

  for(const station of stations){
    const values=Array.isArray(station.value)?station.value:(station.value?[station.value]:[]);
    let best=null;
    for(const value of values){
      const temp=officialTempNumber(value?.value,value?.temperature);
      const time=officialTempTime(value?.date||value?.time);
      if(!Number.isFinite(temp)) continue;
      if(!best || (Number.isFinite(time) && time>best.time)) best={temp,time};
    }
    if(!best) continue;
    const lat=officialTempNumber(station.latitude,station.lat);
    const lon=officialTempNumber(station.longitude,station.lon);
    out.push(officialTempRecord({
      country:'SE',code:station.key||station.id||station.name,
      name:station.name||('SMHI '+(station.key||'station')),
      lat,lon,temp:best.temp,time:best.time,
      source:'Swedish Meteorological and Hydrological Institute (SMHI)'
    }));
  }
  return officialTempDedup(out);
}

async function loadIcelandOfficialTemperature(){
  const stationUrl='https://api.vedur.is/weather/stations?active=true&station_type=sj';
  const obsUrl='https://api.vedur.is/weather/observations/aws/hour/latest?parameters=basic';
  const [stationPayload,obsPayload]=await Promise.all([
    officialTempFetch(stationUrl,{json:true,timeout:16000}),
    officialTempFetch(obsUrl,{json:true,timeout:16000})
  ]);

  const stationRows=officialTempArray(stationPayload,['stations']);
  const obsRows=officialTempArray(obsPayload,['observations']);
  const stationMap=new Map();
  for(const station of stationRows){
    const id=String(station.station??station.id??station.station_id??station.number??'');
    if(id) stationMap.set(id,station);
  }

  const out=[];
  for(const observation of obsRows){
    const id=String(observation.station??observation.id??observation.station_id??'');
    const station=stationMap.get(id)||observation;
    const {lat,lon}=officialTempCoord(station);
    const temp=officialTempNumber(observation.t,observation.T,observation.temperature,observation.temperature_c);
    const time=officialTempTime(observation.time||observation.observed_at||observation.date);
    out.push(officialTempRecord({
      country:'IS',code:id||station.name,
      name:observation.name||station.name||('IMO '+id),
      lat,lon,temp,time,
      source:'Icelandic Meteorological Office (IMO)'
    }));
  }
  return officialTempDedup(out);
}

// IMGW publishes coordinates and UTC observation times in its METEO feed.
async function loadPolandOfficialTemperature(){
  const payload=await officialTempFetch('https://danepubliczne.imgw.pl/api/data/meteo',{json:true});
  const records=officialTempArray(payload).map(station=>officialTempRecord({
    country:'PL',code:station.kod_stacji,name:station.nazwa_stacji,
    lat:station.lat,lon:station.lon,
    temp:officialTempNumber(station.temperatura_powietrza),
    time:officialTempTime(station.temperatura_powietrza_data),
    source:'IMGW – Państwowy Instytut Badawczy'
  })).filter(record=>record && Number.isFinite(record.time));
  if(!records.length) throw new Error('IMGW returned no air-temperature observations');
  return officialTempDedup(records);
}

let denmarkTemperatureStationMetadataPromise=null;
function loadDenmarkTemperatureStationMetadata(){
  if(!denmarkTemperatureStationMetadataPromise){
    denmarkTemperatureStationMetadataPromise=officialTempFetch(
      'https://opendataapi.dmi.dk/v2/metObs/collections/station/items?bbox=7.5,54.4,15.6,58&limit=1000',
      {json:true}
    ).then(payload=>{
      const stations=new Map();
      for(const feature of (payload.features||[])){
        const station=feature.properties||{};
        if(station.country!=='DNK' || station.status!=='Active') continue;
        const validFrom=Date.parse(station.validFrom);
        const validTo=Date.parse(station.validTo);
        if(validFrom>Date.now() || validTo<=Date.now()) continue;
        const current=stations.get(station.stationId);
        if(!current || Date.parse(current.validFrom)<validFrom){
          stations.set(station.stationId,station);
        }
      }
      return stations;
    }).catch(error=>{
      denmarkTemperatureStationMetadataPromise=null;
      console.warn('DMI station names unavailable',error);
      return new Map();
    });
  }
  return denmarkTemperatureStationMetadataPromise;
}

async function loadDenmarkOfficialTemperature(){
  const now=new Date();
  const start=new Date(now.getTime()-2*60*60*1000);
  // A bounded time window is essential: an unbounded query can return years
  // of observations from the first station instead of Denmark's latest data.
  const url='https://opendataapi.dmi.dk/v2/metObs/collections/observation/items?'+
    new URLSearchParams({parameterId:'temp_dry',bbox:'7.5,54.4,15.6,58',
      datetime:start.toISOString()+'/'+now.toISOString(),limit:'10000'});
  const [payload,stations]=await Promise.all([
    officialTempFetch(url,{json:true}),
    loadDenmarkTemperatureStationMetadata()
  ]);
  const records=[];
  for(const feature of (payload.features||[])){
    const observation=feature.properties||{};
    if(observation.parameterId!=='temp_dry') continue;
    const station=stations.get(observation.stationId);
    const [lon,lat]=feature.geometry?.coordinates||[];
    const record=officialTempRecord({
      country:'DK',code:observation.stationId,
      name:station?.name||('DMI '+observation.stationId),lat,lon,
      temp:officialTempNumber(observation.value),time:officialTempTime(observation.observed),
      source:'Danish Meteorological Institute (DMI)'
    });
    if(record && Number.isFinite(record.time)) records.push(record);
  }
  if(!records.length) throw new Error('DMI returned no air-temperature observations');
  return officialTempDedup(records);
}

const OFFICIAL_TEMP_LOADERS=[
  ['EE',loadEstoniaOfficialTemperature],
  ['LT',loadLithuaniaOfficialTemperature],
  ['FI',loadFinlandOfficialTemperature],
  ['SE',loadSwedenOfficialTemperature],
  ['IS',loadIcelandOfficialTemperature],
  ['PL',loadPolandOfficialTemperature],
  ['DK',loadDenmarkOfficialTemperature]
];

async function loadOfficialTemperatureStations(force=false){
  if(!force && officialTemperatureStations.length && Date.now()-officialTemperatureLoadedAt<OFFICIAL_TEMP_REFRESH_MS){
    return officialTemperatureStations;
  }
  // Refresh joins an already fresh in-flight load rather than starting another
  // entire country's requests. Completed loads retain the same refresh rules.
  if(officialTemperatureLoadPromise) return officialTemperatureLoadPromise;

  officialTemperatureLoadPromise=(async()=>{
    const settled=await Promise.allSettled(OFFICIAL_TEMP_LOADERS.map(([,loader])=>loader()));
    const records=[];
    const state={};

    settled.forEach((result,index)=>{
      const code=OFFICIAL_TEMP_LOADERS[index][0];
      if(result.status==='fulfilled'){
        const rows=result.value||[];
        records.push(...rows);
        state[code]={ok:true,count:rows.length};
      }else{
        console.warn(code+' official temperature feed unavailable',result.reason);
        state[code]={ok:false,count:0,error:String(result.reason?.message||result.reason||'unavailable')};
      }
    });

    if(records.length){
      officialTemperatureStations=officialTempDedup(records);
      officialTemperatureSourceState=state;
      officialTemperatureLoadedAt=Date.now();
      saveOfficialTemperatureCache();
      return officialTemperatureStations;
    }

    if(restoreOfficialTemperatureCache()) return officialTemperatureStations;
    officialTemperatureSourceState=state;
    officialTemperatureLoadedAt=Date.now();
    return [];
  })();

  try{
    return await officialTemperatureLoadPromise;
  }finally{
    officialTemperatureLoadPromise=null;
  }
}

function officialStationsNearTime(unix){
  return officialTemperatureStations.filter(station=>{
    if(Number.isFinite(station.time)) return Math.abs(station.time-unix)<=OFFICIAL_TEMP_LABEL_MAX_OFFSET;
    const latest=frames.at(-1);
    return !!latest && unix===latest.time;
  });
}

function officialStationSourceSummary(){
  const good=[];
  const bad=[];
  for(const [code] of OFFICIAL_TEMP_LOADERS){
    const state=officialTemperatureSourceState[code];
    if(state?.ok && state.count) good.push(code);
    else if(state && !state.ok) bad.push(code);
  }
  return {good,bad};
}

// Replace the model-only label renderer. Official observations are laid down
// first, so nearby model labels yield to the measured station value.
renderTemperatureLabels=function(unix){
  if(map.hasLayer(temperatureLabels)) map.removeLayer(temperatureLabels);
  temperatureLabels.clearLayers();

  if(!$('tempOn').checked || !temperatureSeries.length) return;

  const majorPoints=[
    [59.44,24.75],[56.95,24.11],[54.69,25.28],[60.17,24.94],
    [59.33,18.07],[59.91,10.75],[64.15,-21.94],[65.01,25.47],[69.65,18.96],
    [52.23,21.01],[55.68,12.57]
  ];
  const zoom=map.getZoom();
  const modelPoints=zoom<=5 ? majorPoints :
    zoom<=6 ? [...majorPoints,...TEMP_CITY_POINTS] :
    [...majorPoints,...TEMP_CITY_POINTS,...EXTRA_TEMP_POINTS];

  const seen=new Set();
  const occupied=[];
  const bounds=map.getBounds();
  const gapX=zoom>=9?48:58;
  const gapY=27;

  function freeAt(lat,lon){
    const pixel=map.latLngToContainerPoint([lat,lon]);
    if(occupied.some(p=>Math.abs(p.x-pixel.x)<gapX && Math.abs(p.y-pixel.y)<gapY)) return null;
    occupied.push(pixel);
    return pixel;
  }

  for(const station of officialStationsNearTime(unix)){
    if(!bounds.contains([station.lat,station.lon])) continue;
    const key=temperatureCoordKey(station.lat,station.lon);
    if(seen.has(key) || !freeAt(station.lat,station.lon)) continue;
    seen.add(key);

    L.marker([station.lat,station.lon],{
      interactive:false,
      title:`${station.name} · ${station.source}`,
      icon:L.divIcon({
        className:'',
        html:`<div class="temp-label temp-label-observed"><span class="temp-observed-dot">●</span>${Math.round(station.temp)}°C</div>`,
        iconSize:[54,22],
        iconAnchor:[27,11]
      })
    }).addTo(temperatureLabels);
  }

  for(const [lat,lon] of modelPoints){
    const key=temperatureCoordKey(lat,lon);
    if(seen.has(key) || !bounds.contains([lat,lon]) || !freeAt(lat,lon)) continue;
    const t=interpolateTemp(lat,lon,unix);
    if(!Number.isFinite(t)){
      occupied.pop();
      continue;
    }
    seen.add(key);

    L.marker([lat,lon],{
      interactive:false,
      icon:L.divIcon({
        className:'',
        html:`<div class="temp-label">${Math.round(t)}°C</div>`,
        iconSize:[46,22],
        iconAnchor:[23,11]
      })
    }).addTo(temperatureLabels);
  }

  temperatureLabels.addTo(map);
};

// Fetch model and official observations together when the temperature layer is
// enabled. The model remains independent, so a failed national station feed can
// never blank the temperature layer.
const loadTemperaturesModelOnly=loadTemperatures;
loadTemperatures=async function(force=false){
  const results=await Promise.allSettled([
    loadTemperaturesModelOnly(force),
    $('tempOn').checked?loadOfficialTemperatureStations(force):Promise.resolve()
  ]);

  if(results[0].status==='rejected') throw results[0].reason;

  const frame=frames[Number($('timeline').value)];
  if(frame && temperatureEnabled()) queueTemperatureRender(frame.time,0);
};

const buildTemperatureOverlayModelOnly=buildTemperatureOverlay;
buildTemperatureOverlay=async function(unix,options={}){
  const result=await buildTemperatureOverlayModelOnly(unix,options);
  if(options.precache || !$('tempOn').checked) return result;

  const visibleOfficial=officialStationsNearTime(unix);
  const summary=officialStationSourceSummary();
  if(visibleOfficial.length && $('tempStatus').classList.contains('ok')){
    $('tempStatus').textContent+=` · ${visibleOfficial.length} official station readings (${summary.good.join('/')})`;
  }else if(summary.bad.length && $('tempStatus').classList.contains('ok')){
    $('tempStatus').textContent+=` · station feeds partial`;
  }
  return result;
};
