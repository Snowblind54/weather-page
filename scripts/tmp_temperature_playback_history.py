from pathlib import Path

p=Path('js/stations.js')
text=p.read_text()

text=text.replace("// terrain-aware model field; these observations take priority for numeric map\n// labels when their timestamp is close to the selected timeline frame.",
                  "// terrain-aware model field; recent station history is retained so numeric\n// labels and heatmap corrections follow the selected playback frame.")
text=text.replace("const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV812';",
                  "const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV813';")
text=text.replace("const OFFICIAL_TEMP_LABEL_MAX_OFFSET=95*60;",
                  "const OFFICIAL_TEMP_LABEL_MAX_OFFSET=95*60;\nconst OFFICIAL_TEMP_HISTORY_SEC=3*60*60;\nconst OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC=10*60;")

old="""function officialTempDedup(records){
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
"""
new="""function officialTempStationKey(record){
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
"""
if old not in text: raise SystemExit('dedup block missing')
text=text.replace(old,new,1)

old="""  return officialTempDedup(await mapPool(stations,6,async station=>{
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
"""
new="""  return officialTempDedup(await mapPool(stations,6,async station=>{
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
"""
if old not in text: raise SystemExit('Lithuania block missing')
text=text.replace(old,new,1)

text=text.replace("const start=new Date(end.getTime()-100*60*1000);",
                  "const start=new Date(end.getTime()-190*60*1000);")
text=text.replace("period/latest-hour/data.json';",
                  "period/latest-day/data.json';")

old="""  for(const station of stations){
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
"""
new="""  for(const station of stations){
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
"""
if old not in text: raise SystemExit('Sweden block missing')
text=text.replace(old,new,1)

old="""    const payload=await officialTempFetch(base+'observations?'+params,{json:true,timeout:18000});
    const latest=new Map();
    for(const row of (payload.data||[])){
      const source=String(row.sourceId||'').split(':');
      const code=source[0];
      if(!byCode.has(code) || (source.length>1 && source[1]!=='0'))continue;
      const time=officialTempTime(row.referenceTime);
      if(!Number.isFinite(time))continue;
      for(const observation of (row.observations||[])){
        if(observation.elementId!=='air_temperature' || observation.timeSeriesId!==0)continue;
        if(![0,2,4].includes(observation.qualityCode))continue;
        const temp=officialTempNumber(observation.value);
        if(!Number.isFinite(temp))continue;
        const current=latest.get(code);
        if(!current || time>current.time)latest.set(code,{temp,time});
      }
    }
    const result=[];
    for(const [code,value] of latest){
      const station=byCode.get(code),coords=station.geometry?.coordinates||[];
      const lon=officialTempNumber(coords[0]),lat=officialTempNumber(coords[1]);
      result.push(officialTempRecord({
        country:'NO',code,name:station.shortName||station.name||code,
        lat,lon,temp:value.temp,time:value.time,source:'MET Norway / Seklima'
      }));
    }
    return result;
"""
new="""    const payload=await officialTempFetch(base+'observations?'+params,{json:true,timeout:18000});
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
"""
if old not in text: raise SystemExit('Norway block missing')
text=text.replace(old,new,1)

text=text.replace("const start=new Date(now.getTime()-2*60*60*1000);",
                  "const start=new Date(now.getTime()-3*60*60*1000);")

old="""    if(records.length){
      officialTemperatureStations=officialTempDedup(records);
"""
new="""    if(records.length){
      const nowSec=Math.floor(Date.now()/1000);
      const cutoff=nowSec-OFFICIAL_TEMP_HISTORY_SEC;
      const recentRecords=records.filter(record=>
        !Number.isFinite(record.time) ||
        (record.time>=cutoff && record.time<=nowSec+OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC)
      );
      officialTemperatureStations=officialTempDedup(recentRecords);
"""
if old not in text: raise SystemExit('global records block missing')
text=text.replace(old,new,1)

old="""function officialStationsNearTime(unix){
  return officialTemperatureStations.filter(station=>{
    if(Number.isFinite(station.time)) return Math.abs(station.time-unix)<=OFFICIAL_TEMP_LABEL_MAX_OFFSET;
    const latest=frames.at(-1);
    return !!latest && unix===latest.time;
  });
}
"""
new="""function officialStationsNearTime(unix){
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
    if(age>OFFICIAL_TEMP_LABEL_MAX_OFFSET || age<-OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC) continue;

    const key=officialTempStationKey(station);
    const current=selected.get(key);
    const score=age>=0 ? age : OFFICIAL_TEMP_LABEL_MAX_OFFSET+Math.abs(age);
    if(!current){
      selected.set(key,{...station,_playbackScore:score});
      continue;
    }
    const currentAge=unix-current.time;
    const currentScore=Number.isFinite(current._playbackScore)
      ? current._playbackScore
      : (currentAge>=0?currentAge:OFFICIAL_TEMP_LABEL_MAX_OFFSET+Math.abs(currentAge));
    if(score<currentScore) selected.set(key,{...station,_playbackScore:score});
  }

  return [...selected.values()].map(({_playbackScore,...station})=>station);
}
"""
if old not in text: raise SystemExit('time selector block missing')
text=text.replace(old,new,1)

p.write_text(text)

p=Path('index.html')
html=p.read_text()
for old,new in [
  ('<title>Northern Weather Map v8.69</title>','<title>Northern Weather Map v8.70</title>'),
  ('js/stations.js?v=8.68','js/stations.js?v=8.70')
]:
    if old not in html: raise SystemExit('index marker missing: '+old)
    html=html.replace(old,new,1)
p.write_text(html)
