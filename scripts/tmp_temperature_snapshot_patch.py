from pathlib import Path

p=Path('js/stations.js')
text=p.read_text()
text=text.replace("// Loaded only when the temperature layer is enabled. The heatmap remains the\n// terrain-aware model field; recent station history is retained so numeric\n// labels and heatmap corrections follow the selected playback frame.",
                  "// Loaded from one shared GitHub snapshot when the temperature layer is enabled.\n// The snapshot retains recent official history so labels and heatmap corrections\n// follow the selected playback frame without every visitor hitting national APIs.")
text=text.replace("const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV813';",
                  "const OFFICIAL_TEMP_CACHE_KEY='balticWeatherOfficialStationsV814';\nconst OFFICIAL_TEMP_SNAPSHOT_URL='data/official-temperature.json';")
start=text.index('async function loadOfficialTemperatureStations(force=false){')
end=text.index('\nfunction officialStationsNearTime(unix){',start)
new="""async function loadOfficialTemperatureStations(force=false){
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
"""
text=text[:start]+new+text[end:]
p.write_text(text)

p=Path('index.html')
html=p.read_text()
html=html.replace('<title>Northern Weather Map v8.70</title>','<title>Northern Weather Map v8.71</title>',1)
html=html.replace('js/stations.js?v=8.70','js/stations.js?v=8.71',1)
needle='The heatmap starts from the terrain-aware hourly model field and is locally corrected toward fresh official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Norway, Iceland, Poland and Denmark.'
replacement='Official station observations are collected server-side into one shared snapshot every 10 minutes, so visitors do not query each national API directly. The heatmap starts from the terrain-aware hourly model field and is locally corrected toward fresh official weather-station measurements from Estonia, Lithuania, Finland, Sweden, Norway, Iceland, Poland and Denmark.'
if needle not in html: raise SystemExit('temperature source text not found')
html=html.replace(needle,replacement,1)
p.write_text(html)
