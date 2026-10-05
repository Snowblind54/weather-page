from pathlib import Path

p=Path('js/wind.js')
s=p.read_text()
marker='const WindHeatmapLayer=L.Layer.extend({'
if marker not in s: raise SystemExit('wind heatmap marker missing')
helpers="""function windHeatmapCorrections(unix,slice,mode){
  const blend=globalThis.WindObservationBlend;
  if(!blend||typeof officialWindData==='undefined'||!officialWindData||typeof officialWindReading!=='function')return [];
  const target=Math.min(unix,Date.now()/1000),corrections=[];
  for(const station of officialWindData.stations){
    const reading=officialWindReading(station,unix);if(!reading)continue;
    const observed=mode==='gust'?reading[2]:reading[1];if(!Number.isFinite(observed))continue;
    const vector=windAt(station.lat,station.lon,slice);
    const model=mode==='gust'?windGustAt(station.lat,station.lon,slice):(vector?Math.hypot(vector[0],vector[1]):null);
    const correction=blend.makeCorrection(station.lat,station.lon,observed,model,Math.max(0,target-reading[0]));
    if(correction)corrections.push(correction);
  }
  return corrections;
}
function windHeatmapCorrectionIndex(corrections){
  const cell=2,bins=new Map();
  for(const correction of corrections){
    const lon=((correction.lon+180)%360+360)%360-180;
    const key=Math.floor(correction.lat/cell)+','+Math.floor(lon/cell);
    if(!bins.has(key))bins.set(key,[]);bins.get(key).push(correction);
  }
  return {cell,bins,count:corrections.length};
}
function windHeatmapNearbyCorrections(index,lat,lon){
  if(!index?.count)return [];
  lon=((lon+180)%360+360)%360-180;
  const cy=Math.floor(lat/index.cell),cx=Math.floor(lon/index.cell),out=[];
  for(let dy=-1;dy<=1;dy++)for(let dx=-2;dx<=2;dx++){
    const rows=index.bins.get((cy+dy)+','+(cx+dx));if(rows)out.push(...rows);
  }
  return out;
}

"""
s=s.replace(marker,helpers+marker,1)

old="""  setTime(unix){
    const mode=currentWindMode();
    if(this.unix===unix&&this.data===windData&&this.mode===mode)return;
    this.unix=unix;this.data=windData;this.mode=mode;
    if(this._map)this.scheduleReset();
  },"""
new="""  setTime(unix){
    const mode=currentWindMode();
    const observations=typeof officialWindData!=='undefined'&&officialWindData?officialWindData.generatedAt:0;
    if(this.unix===unix&&this.data===windData&&this.mode===mode&&this.observations===observations)return;
    this.unix=unix;this.data=windData;this.mode=mode;this.observations=observations;
    if(this._map)this.scheduleReset();
  },"""
if old not in s: raise SystemExit('heatmap setTime anchor missing')
s=s.replace(old,new,1)

old="""    const lowCtx=low.getContext('2d'),img=lowCtx.createImageData(cols,rows),palette=WIND_COLOUR_PALETTES[this.mode];
    const rgb=palette.map(hex=>[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]);
    let shown=0;
"""
new="""    const lowCtx=low.getContext('2d'),img=lowCtx.createImageData(cols,rows),palette=WIND_COLOUR_PALETTES[this.mode];
    const rgb=palette.map(hex=>[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]);
    const corrections=windHeatmapCorrections(this.unix,slice,this.mode);
    const correctionIndex=windHeatmapCorrectionIndex(corrections);
    let shown=0;
"""
if old not in s: raise SystemExit('heatmap palette anchor missing')
s=s.replace(old,new,1)

old="""      if(vector) speed=this.mode==='gust'?windGustAt(ll.lat,ll.lng,slice):Math.hypot(vector[0],vector[1]);
      if(!Number.isFinite(speed))continue;
      const c=rgb[windColourIndex(speed)],i=(row*cols+col)*4;
"""
new="""      if(vector) speed=this.mode==='gust'?windGustAt(ll.lat,ll.lng,slice):Math.hypot(vector[0],vector[1]);
      if(!Number.isFinite(speed))continue;
      const nearby=windHeatmapNearbyCorrections(correctionIndex,ll.lat,ll.lng);
      if(nearby.length&&globalThis.WindObservationBlend) speed=globalThis.WindObservationBlend.adjustSpeed(speed,ll.lat,ll.lng,nearby);
      const c=rgb[windColourIndex(speed)],i=(row*cols+col)*4;
"""
if old not in s: raise SystemExit('heatmap speed anchor missing')
s=s.replace(old,new,1)

old="""    $('windHeatmapStatus').textContent=shown?`Model ${this.mode==='gust'?'gust':'sustained wind'} heatmap · ${fmt(this.unix)}`:'Wind heatmap unavailable in this view.';
"""
new="""    const source=corrections.length?`model + ${corrections.length} fresh official readings`:'model field';
    $('windHeatmapStatus').textContent=shown?`${this.mode==='gust'?'Gust':'Sustained wind'} heatmap · ${source} · ${fmt(this.unix)}`:'Wind heatmap unavailable in this view.';
"""
if old not in s: raise SystemExit('heatmap status anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/official-wind.js')
s=p.read_text()
old="function officialWindEnabled(){return $('officialWindSustained').checked||$('officialWindGusts').checked;}"
new=old+"\nfunction officialWindNeeded(){return officialWindEnabled()||!!$('windHeatmapOn')?.checked;}"
if old not in s: raise SystemExit('officialWindEnabled anchor missing')
s=s.replace(old,new,1)
s=s.replace("async function loadOfficialWind(force=false){\n  if(!officialWindEnabled())return;","async function loadOfficialWind(force=false){\n  if(!officialWindNeeded())return;",1)
old="  if(!force&&Date.now()-officialWindLoadedAt<OFFICIAL_WIND_CHECK_MS){renderOfficialWind();return;}\n"
new="  if(!force&&Date.now()-officialWindLoadedAt<OFFICIAL_WIND_CHECK_MS){renderOfficialWind();if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();return;}\n"
if old not in s: raise SystemExit('official wind cache anchor missing')
s=s.replace(old,new,1)
old="      officialWindData=validateOfficialWind(await r.json());officialWindLoadedAt=Date.now();officialWindFailed=false;officialWindRenderKey='';\n"
new=old+"      if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();\n"
if old not in s: raise SystemExit('official wind load anchor missing')
s=s.replace(old,new,1)
s=s.replace("finally{clearTimeout(timer);if(officialWindEnabled())renderOfficialWind();}","finally{clearTimeout(timer);renderOfficialWind();if($('windHeatmapOn')?.checked)windHeatmapLayer?.scheduleReset();}",1)
s=s.replace("setInterval(()=>{if(officialWindEnabled()&&!document.hidden)loadOfficialWind();},OFFICIAL_WIND_CHECK_MS);","setInterval(()=>{if(officialWindNeeded()&&!document.hidden)loadOfficialWind();},OFFICIAL_WIND_CHECK_MS);",1)
s=s.replace("document.addEventListener('visibilitychange',()=>{if(!document.hidden&&officialWindEnabled()){renderOfficialWind();loadOfficialWind();}});","document.addEventListener('visibilitychange',()=>{if(!document.hidden&&officialWindNeeded()){renderOfficialWind();loadOfficialWind();}});",1)
p.write_text(s)

p=Path('js/app.js')
s=p.read_text()
old="""$('windHeatmapOn').addEventListener('change',()=>{
  if($('windHeatmapOn').checked) loadWind().catch(reportWindError);
  else hideWindHeatmap();
  updateAccumulationPopup();
});"""
new="""$('windHeatmapOn').addEventListener('change',()=>{
  if($('windHeatmapOn').checked){
    loadWind().catch(reportWindError);
    if(typeof loadOfficialWind==='function')loadOfficialWind();
  }else hideWindHeatmap();
  updateAccumulationPopup();
});"""
if old not in s: raise SystemExit('heatmap toggle anchor missing')
s=s.replace(old,new,1)
s=s.replace("if(typeof officialWindEnabled==='function'&&officialWindEnabled())await loadOfficialWind(true);","if(typeof officialWindNeeded==='function'&&officialWindNeeded())await loadOfficialWind(true);",1)
p.write_text(s)

p=Path('index.html')
s=p.read_text()
s=s.replace('<title>Northern Weather Map v8.64</title>','<title>Northern Weather Map v8.65</title>',1)
s=s.replace('Station numbers are measured, and remain separate from the model animation.','Station numbers are measured. The particle animation remains model-only; the wind heatmap starts from the model field and is locally adjusted toward fresh official station observations, fading smoothly with distance and observation age.',1)
status='<div id="windHeatmapStatus" class="small" role="status">Wind heatmap is off.</div>'
detail=status+'<div class="small">Heatmap only: fresh official station differences correct the nearby model field. Influence fades smoothly to zero by about 70 km and by 3 hours of observation age. Where no usable station is nearby, the heatmap remains pure model.</div>'
if status not in s: raise SystemExit('heatmap status element missing')
s=s.replace(status,detail,1)
s=s.replace('<script src="js/wind.js?v=8.64"></script>','<script src="js/wind-observation-blend.js?v=8.65"></script>\n<script src="js/wind.js?v=8.65"></script>',1)
s=s.replace('js/official-wind.js?v=8.57','js/official-wind.js?v=8.65',1)
s=s.replace('js/app.js?v=8.63','js/app.js?v=8.65',1)
p.write_text(s)
