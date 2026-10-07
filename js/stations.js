// Official national weather-station temperature observations.
// Loaded from one shared GitHub snapshot when the temperature layer is enabled.
// The snapshot retains recent official history so labels and heatmap corrections
// follow the selected playback frame without every visitor hitting national APIs.

const OFFICIAL_TEMP_REFRESH_MS=10*60*1000;
const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV814';
const OFFICIAL_TEMP_SNAPSHOT_URL='data/official-temperature.json';
const OFFICIAL_TEMP_CACHE_MAX_AGE=45*60*1000;
const OFFICIAL_TEMP_LABEL_MAX_OFFSET=95*60;
const OFFICIAL_TEMP_LABEL_MAX_OFFSET_BY_COUNTRY=Object.freeze({NO:3*60*60});
const OFFICIAL_TEMP_HISTORY_SEC=24*60*60;
const OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC=10*60;

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

function officialTempStationKey(record){
  return record.country+'|'+(record.code||record.lat.toFixed(3)+','+record.lon.toFixed(3));
}

function officialTempDedup(records){
  // Keep one value per station *and timestamp*. Earlier versions collapsed each
  // station to its newest reading, which made the 2-hour playback labels freeze.
  const byKey=new Map();
  for(const record of records.filter(Boolean)){
    const timeKey=Number.isFinite(record.time)?Math.floor(record.time):'na';
    byKey.set(officialTempStationKey(record)+'|'+timeKey,record);
  }
  return [...byKey.values()].sort((a,b)=>(a.time||0)-(b.time||0));
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
    const details=data.station||station;
    const {lat,lon}=officialTempCoord(details);
    const rows=[];
    for(const observation of observations){
      const temp=officialTempNumber(observation.airTemperature,observation.temperature,observation.t);
      const time=officialTempTime(observation.observationTimeUtc||observation.time||observation.date);
      if(!Number.isFinite(temp)) continue;
      rows.push(officialTempRecord({
        country:'LT',code,name:details.name||station.name||String(code),
        lat,lon,temp,time,
        source:'Lithuanian Hydrometeorological Service / Meteo.lt'
      }));
    }
    return rows.filter(Boolean);
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
  const start=new Date(end.getTime()-190*60*1000);
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
    const lat=officialTempNumber(station.latitude,station.lat);
    const lon=officialTempNumber(station.longitude,station.lon);
    for(const value of values){
      const temp=officialTempNumber(value?.value,value?.temperature);
      const time=officialTempTime(value?.date||value?.time);
      if(!Number.isFinite(temp)) continue;
      out.push(officialTempRecord({
        country:'SE',code:station.key||station.id||station.name,
        name:station.name||('SMHI '+(station.key||'station')),
        lat,lon,temp,time,
        source:'Swedish Meteorological and Hydrological Institute (SMHI)'
      }));
    }
  }
  return officialTempDedup(out);
}

async function loadNorwayOfficialTemperature(){
  const base='https://rim.k8s.met.no/api/v1/';
  const now=new Date();
  const start=new Date(now.getTime()-2*24*60*60*1000).toISOString().slice(0,10);
  const end=new Date(now.getTime()+24*60*60*1000).toISOString().slice(0,10);
  const stationParams=new URLSearchParams({
    sourceName:'',weatherElements:'air_temperature',timeResolution:'hours',
    from:start,to:end,includeRegions:'false'
  });
  const stationPayload=await officialTempFetch(base+'stations?'+stationParams,{json:true,timeout:18000});
  const metadata=(stationPayload.data||[]).filter(station=>
    Array.isArray(station.stationHolders) && station.stationHolders.includes('MET.NO') &&
    (station.geometry?.coordinates||[]).length>=2
  );
  const byCode=new Map(metadata.map(station=>[String(station.id),station]));
  const batches=[];
  for(let i=0;i<metadata.length;i+=40)batches.push(metadata.slice(i,i+40));

  const rows=await mapPool(batches,3,async batch=>{
    const params=new URLSearchParams({
      sources:batch.map(station=>station.id).join(','),
      referenceTime:start+'/'+end,elements:'air_temperature',timeResolution:'hours'
    });
    const payload=await officialTempFetch(base+'observations?'+params,{json:true,timeout:18000});
    const result=[];
    for(const row of (payload.data||[])){
      const source=String(row.sourceId||'').split(':');
      const code=source[0];
      if(!byCode.has(code) || (source.length>1 && source[1]!=='0'))continue;
      const time=officialTempTime(row.referenceTime);
      if(!Number.isFinite(time))continue;
      const station=byCode.get(code),coords=station.geometry?.coordinates||[];
      const lon=officialTempNumber(coords[0]),lat=officialTempNumber(coords[1]);
      for(const observation of (row.observations||[])){
        if(observation.elementId!=='air_temperature' || observation.timeSeriesId!==0)continue;
        if(![0,2,4].includes(observation.qualityCode))continue;
        const temp=officialTempNumber(observation.value);
        if(!Number.isFinite(temp))continue;
        result.push(officialTempRecord({
          country:'NO',code,name:station.shortName||station.name||code,
          lat,lon,temp,time,source:'MET Norway / Seklima'
        }));
      }
    }
    return result.filter(Boolean);
  });
  if(!rows.length)throw new Error('MET Norway returned no air-temperature observations');
  return officialTempDedup(rows);
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
  const start=new Date(now.getTime()-3*60*60*1000);
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
  ['NO',loadNorwayOfficialTemperature],
  ['IS',loadIcelandOfficialTemperature],
  ['PL',loadPolandOfficialTemperature],
  ['DK',loadDenmarkOfficialTemperature]
];

async function loadOfficialTemperatureStations(force=false){
  if(!force && officialTemperatureStations.length && Date.now()-officialTemperatureLoadedAt<OFFICIAL_TEMP_REFRESH_MS){
    return officialTemperatureStations;
  }
  if(officialTemperatureLoadPromise) return officialTemperatureLoadPromise;

  officialTemperatureLoadPromise=(async()=>{
    try{
      const cacheBust=Math.floor(Date.now()/OFFICIAL_TEMP_REFRESH_MS);
      const response=await fetch(OFFICIAL_TEMP_SNAPSHOT_URL+'?v='+cacheBust,{cache:'no-store'});
      if(!response.ok) throw new Error('temperature snapshot HTTP '+response.status);
      const snapshot=await response.json();
      if(snapshot?.version!==1 || !Array.isArray(snapshot?.stations)) throw new Error('invalid temperature snapshot');

      const records=[];
      for(const station of snapshot.stations){
        for(const row of (station.rows||[])){
          const record=officialTempRecord({
            country:station.country,code:station.code,name:station.name,
            lat:station.lat,lon:station.lon,time:row?.[0],temp:row?.[1],source:station.source
          });
          if(record) records.push(record);
        }
      }
      if(!records.length) throw new Error('temperature snapshot has no observations');

      officialTemperatureStations=officialTempDedup(records);
      officialTemperatureSourceState=snapshot.sources||{};
      window.__officialTemperatureGeneratedAt=snapshot.generatedAt;
      officialTemperatureLoadedAt=Date.now();
      saveOfficialTemperatureCache();
      if(typeof invalidateTemperatureHeatmapCache==='function') invalidateTemperatureHeatmapCache();
      return officialTemperatureStations;
    }catch(error){
      console.warn('Official temperature snapshot unavailable',error);
      if(restoreOfficialTemperatureCache()) return officialTemperatureStations;
      officialTemperatureSourceState={};
      officialTemperatureLoadedAt=Date.now();
      return [];
    }
  })();

  try{
    return await officialTemperatureLoadPromise;
  }finally{
    officialTemperatureLoadPromise=null;
  }
}

function officialStationsNearTime(unix){
  // Choose one observation per station for the selected playback frame.
  // Prefer the newest reading at/before the frame. A small future tolerance
  // covers provider timestamp rounding, but never reuses the newest reading
  // throughout the full 2-hour playback window.
  const selected=new Map();
  const latestFrame=frames.at(-1);

  for(const station of officialTemperatureStations){
    if(!Number.isFinite(station.time)){
      if(latestFrame && unix===latestFrame.time && !selected.has(officialTempStationKey(station))){
        selected.set(officialTempStationKey(station),station);
      }
      continue;
    }

    const age=unix-station.time;
    const maxOffset=OFFICIAL_TEMP_LABEL_MAX_OFFSET_BY_COUNTRY[station.country]||OFFICIAL_TEMP_LABEL_MAX_OFFSET;
    // The weather timeline is anchored to radar observations, whose newest
    // frame can trail station feeds. On the Latest frame, prefer the freshest
    // real station reading rather than hiding it merely because it is newer
    // than the radar image. Historical frames keep the strict 10-minute rule.
    const latestSelection=!!latestFrame && unix===latestFrame.time;
    const futureTolerance=latestSelection?maxOffset:OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC;
    if(age>maxOffset || age<-futureTolerance) continue;

    const key=officialTempStationKey(station);
    const current=selected.get(key);
    const score=age>=0 ? age : maxOffset+Math.abs(age);
    if(!current){
      selected.set(key,{...station,_playbackScore:score});
      continue;
    }
    const currentAge=unix-current.time;
    const currentMaxOffset=OFFICIAL_TEMP_LABEL_MAX_OFFSET_BY_COUNTRY[current.country]||OFFICIAL_TEMP_LABEL_MAX_OFFSET;
    const currentScore=Number.isFinite(current._playbackScore)
      ? current._playbackScore
      : (currentAge>=0?currentAge:currentMaxOffset+Math.abs(currentAge));
    if(score<currentScore) selected.set(key,{...station,_playbackScore:score});
  }

  return [...selected.values()].map(({_playbackScore,...station})=>station);
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

function officialTemperaturePopup(station){
  const observed=Number.isFinite(station.time)?fmt(station.time):'Observation time unavailable';
  return `<div class="temp-station-popup">
    <b>${htmlEscape(station.name)}</b>
    <div style="font-size:24px;font-weight:800;margin:5px 0">${station.temp.toFixed(1)}°C</div>
    <div>Official measured air temperature</div>
    <div class="wind-popup-meta">Observed ${htmlEscape(observed)}</div>
    <div class="wind-popup-meta">Station ${htmlEscape(station.code||'—')} · ${htmlEscape(station.country)}</div>
    <div class="wind-popup-meta">${station.lat.toFixed(4)}°, ${station.lon.toFixed(4)}°</div>
    <div class="wind-popup-meta">Source: ${htmlEscape(station.source)}</div>
  </div>`;
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

    const marker=L.marker([station.lat,station.lon],{
      interactive:true,
      keyboard:true,
      title:`${station.name} · ${station.source}`,
      icon:L.divIcon({
        className:'',
        html:`<div class="temp-label temp-label-observed"><span class="temp-observed-dot">●</span>${Math.round(station.temp)}°C</div>`,
        iconSize:[54,22],
        iconAnchor:[27,11]
      })
    });
    marker.bindPopup(officialTemperaturePopup(station),{maxWidth:340,className:'wind-popup-container',autoPan:false});
    marker.addTo(temperatureLabels);
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
    temperatureEnabled()?loadOfficialTemperatureStations(force):Promise.resolve()
  ]);

  if(results[0].status==='rejected') throw results[0].reason;

  const frame=frames[Number($('timeline').value)];
  if(frame && temperatureEnabled()) queueTemperatureRender(frame.time,0);
};

const buildTemperatureOverlayModelOnly=buildTemperatureOverlay;
buildTemperatureOverlay=async function(unix,options={}){
  const result=await buildTemperatureOverlayModelOnly(unix,options);
  if(options.precache) return result;

  const visibleOfficial=officialStationsNearTime(unix);
  const summary=officialStationSourceSummary();
  if(visibleOfficial.length && $('tempStatus').classList.contains('ok')){
    const label=$('tempOn').checked?'official station readings':'official stations used for heatmap';
    $('tempStatus').textContent+=` · ${visibleOfficial.length} ${label} (${summary.good.join('/')})`;
  }else if(summary.bad.length && $('tempStatus').classList.contains('ok')){
    $('tempStatus').textContent+=` · station feeds partial`;
  }
  return result;
};
