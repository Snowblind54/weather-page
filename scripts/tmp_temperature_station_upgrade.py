from pathlib import Path

stations_path=Path('js/stations.js')
text=stations_path.read_text()

anchor="""async function loadIcelandOfficialTemperature(){
"""
if anchor not in text:
    raise SystemExit('Iceland loader anchor missing')

norway="""async function loadNorwayOfficialTemperature(){
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
  });
  if(!rows.length)throw new Error('MET Norway returned no air-temperature observations');
  return officialTempDedup(rows);
}

"""
text=text.replace(anchor,norway+anchor,1)

old="""  ['SE',loadSwedenOfficialTemperature],
  ['IS',loadIcelandOfficialTemperature],
"""
new="""  ['SE',loadSwedenOfficialTemperature],
  ['NO',loadNorwayOfficialTemperature],
  ['IS',loadIcelandOfficialTemperature],
"""
if old not in text:
    raise SystemExit('loader list anchor missing')
text=text.replace(old,new,1)

popup_anchor="""// Replace the model-only label renderer. Official observations are laid down
// first, so nearby model labels yield to the measured station value.
renderTemperatureLabels=function(unix){
"""
if popup_anchor not in text:
    raise SystemExit('label renderer anchor missing')
popup="""function officialTemperaturePopup(station){
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

"""
text=text.replace(popup_anchor,popup+popup_anchor,1)

old_marker="""    L.marker([station.lat,station.lon],{
      interactive:false,
      title:`${station.name} · ${station.source}`,
      icon:L.divIcon({
        className:'',
        html:`<div class=\"temp-label temp-label-observed\"><span class=\"temp-observed-dot\">●</span>${Math.round(station.temp)}°C</div>`,
        iconSize:[54,22],
        iconAnchor:[27,11]
      })
    }).addTo(temperatureLabels);
"""
new_marker="""    const marker=L.marker([station.lat,station.lon],{
      interactive:true,
      keyboard:true,
      title:`${station.name} · ${station.source}`,
      icon:L.divIcon({
        className:'',
        html:`<div class=\"temp-label temp-label-observed\"><span class=\"temp-observed-dot\">●</span>${Math.round(station.temp)}°C</div>`,
        iconSize:[54,22],
        iconAnchor:[27,11]
      })
    });
    marker.bindPopup(officialTemperaturePopup(station),{maxWidth:280,className:'wind-popup-container',autoPan:false});
    marker.addTo(temperatureLabels);
"""
if old_marker not in text:
    raise SystemExit('official marker block missing')
text=text.replace(old_marker,new_marker,1)
stations_path.write_text(text)

index_path=Path('index.html')
index=index_path.read_text()
replacements=[
 ('<title>Northern Weather Map v8.66</title>','<title>Northern Weather Map v8.67</title>'),
 ('js/stations.js?v=8.39','js/stations.js?v=8.67'),
 ('official observations from the Estonian Environment Agency, LHMT / Meteo.lt, FMI, SMHI, Icelandic Meteorological Office, IMGW–PIB and DMI. Latvia and Norway use model labels where official feeds are unavailable.',
  'official observations from the Estonian Environment Agency, LHMT / Meteo.lt, FMI, SMHI, MET Norway / Seklima, Icelandic Meteorological Office, IMGW–PIB and DMI. Latvia uses model labels where an official feed is unavailable.'),
 ('<a href="https://opendata.smhi.se/" target="_blank" rel="noopener">SMHI ↗</a><a href="https://en.vedur.is/"',
  '<a href="https://opendata.smhi.se/" target="_blank" rel="noopener">SMHI ↗</a><a href="https://seklima.met.no/" target="_blank" rel="noopener">MET Norway ↗</a><a href="https://en.vedur.is/"'),
 ('Numeric labels prefer recent official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Iceland, Poland and Denmark. Latvia and Norway currently keep model-based labels where a browser-safe official observation feed is not available.',
  'Numeric labels prefer recent official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Norway, Iceland, Poland and Denmark. Click an official reading for station name, exact measured temperature, observation time, station ID, coordinates and source. Latvia currently keeps model-based labels where an official observation feed is not available.')
]
for old,new in replacements:
    if old not in index:
        raise SystemExit('index marker missing: '+old[:80])
    index=index.replace(old,new,1)
index_path.write_text(index)
