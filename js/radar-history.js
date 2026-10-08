// Current official Baltic image feeds. Timestamped images work without CORS
// pixel access, GIF decoding, public proxies or browser-created radar history.
const LV_RADAR_INDEX='https://videscentrs.lvgmc.lv/data/static_maps?name=Latvija%2FLatvija_satelits';
const LV_RADAR_FILES='https://videscentrs.lvgmc.lv/kartes-images/Latvija/Latvija_satelits.files.json';
const balticRadarPending=new Map(),directRadarLayers=new Map();
let lvRadarList=null;
function localTimeToUnix(y,m,d,h,min,zone){
  let guess=Date.UTC(y,m-1,d,h,min);
  for(let k=0;k<2;k++){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)),p={};
    for(const part of parts)if(part.type!=='literal')p[part.type]=Number(part.value);
    guess=Date.UTC(y,m-1,d,h,min)-(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second||0)-guess);
  }
  return Math.floor(guess/1000);
}
function ltRadarUrl(time){
  const stamp=new Date(time*1000).toISOString().slice(0,16).replace(/[-:T]/g,'');
  return 'https://new.meteo.lt/meteo_jobs/radaru_informacija/Header_Radar-composite-'+stamp+'.png';
}
async function ltHistory(source,target){
  const slot=Math.floor(Math.min(target,Date.now()/1000)/300)*300;
  for(let time=slot;time>=target-900;time-=300){
    try{
      const url=ltRadarUrl(time);await loadRadarNativeImage(url);
      return {dataUrl:url,time,bounds:source.bounds,mode:'official history'};
    }catch(_){/* Publication can lag; try only earlier observations. */}
  }
  throw new Error('LHMT has no image within 15 minutes of '+fmt(target));
}
function parseLvRadarRecords(payload,now=Date.now()/1000){
  const entries=Array.isArray(payload)?payload:payload?.files;
  if(!Array.isArray(entries))throw new Error('Invalid LVĢMC radar index');
  return entries.flatMap(entry=>{
    const name=typeof entry==='string'?entry:entry?.name;
    if(typeof name!=='string'||!/^Latvija\/Latvija_satelits\/(?:png\/)?[A-Za-z0-9_.-]+\.png$/.test(name))return [];
    const match=name.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:_|\.)/);if(!match)return [];
    const date=new Date(Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5]));
    if(date.getUTCFullYear()!==+match[1]||date.getUTCMonth()+1!==+match[2]||date.getUTCDate()!==+match[3]||+match[4]>23||+match[5]>59)return [];
    const time=localTimeToUnix(+match[1],+match[2],+match[3],+match[4],+match[5],'Europe/Riga');
    if(!Number.isFinite(time)||time>now||time<now-10800)return [];
    return [{time,url:'https://videscentrs.lvgmc.lv/kartes-images/'+name}];
  }).sort((a,b)=>a.time-b.time);
}
async function listLvRadar(force=false){
  if(!force&&lvRadarList&&Date.now()-lvRadarList.at<60000)return lvRadarList.promise;
  const promise=(async()=>{
    for(const url of [LV_RADAR_INDEX,LV_RADAR_FILES]){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
      try{
        const response=await fetch(url,{signal:controller.signal,cache:'no-cache'});
        if(!response.ok)throw new Error('LVĢMC radar HTTP '+response.status);
        const records=parseLvRadarRecords(await response.json());if(records.length)return records;
      }catch(error){console.warn('LVĢMC radar index unavailable',error);}finally{clearTimeout(timer);}
    }
    throw new Error('LVĢMC is not publishing recent radar images');
  })();lvRadarList={at:Date.now(),promise};return promise;
}
async function lvHistory(source,target,latest,force=false){
  const records=await listLvRadar(force),record=radarObservationAt(records,target);
  if(!record)throw new Error('LVĢMC has no observation within 15 minutes of '+fmt(target));
  await loadRadarNativeImage(record.url);
  return {dataUrl:record.url,time:record.time,bounds:source.bounds,mode:'official history'};
}
function prepareBalticRadarFrame(source,unix,latest,force=false){
  const view=typeof preparedRadarFrame==='function'?map.getBounds():null;
  const key=source.id+'|'+unix+(view?'|'+map.getZoom()+'|'+[view.getSouth(),view.getWest(),view.getNorth(),view.getEast()].map(v=>v.toFixed(2)).join(','):''),cached=directRadarImageCache.get(key);
  if(!force&&cached){directRadarImageCache.delete(key);directRadarImageCache.set(key,cached);return Promise.resolve(cached.frame);}
  const pendingKey=key+'|'+force;
  if(balticRadarPending.has(pendingKey))return balticRadarPending.get(pendingKey);
  const promise=(async()=>{
    const prepared=typeof preparedRadarFrame==='function'?await preparedRadarFrame(source.id,unix):null;
    return prepared?{...prepared,dataUrl:prepared.url}:source.id==='lt'?ltHistory(source,unix):lvHistory(source,unix,latest,force);
  })()
    .then(frame=>{directRadarImageCache.set(key,{at:Date.now(),frame});const light=typeof radarLightMode==='function'&&radarLightMode(),bytes=()=>[...directRadarImageCache.values()].reduce((n,e)=>n+(e.frame.canvas?e.frame.canvas.width*e.frame.canvas.height*4:0),0);while(directRadarImageCache.size>(light?12:60)||(light&&bytes()>8*1024*1024))directRadarImageCache.delete(directRadarImageCache.keys().next().value);return frame;})
    .finally(()=>{if(balticRadarPending.get(pendingKey)===promise)balticRadarPending.delete(pendingKey);});
  balticRadarPending.set(pendingKey,promise);return promise;
}
function visibleBalticRadarSources(){return DIRECT_RADAR_SOURCES.filter(source=>map.getBounds().intersects(L.latLngBounds(source.bounds)));}
async function drawDirectNationalRadars(unix,{force=false}={}){
  if(!$('radarOn').checked){clearDirectNationalRadars();return;}
  const generation=++directRadarGeneration,latest=frames.at(-1)?.time||unix,visible=visibleBalticRadarSources();
  if(!balticRadarLayer)balticRadarLayer=L.layerGroup().addTo(map);
  const wanted=new Set(visible.map(source=>source.id)),labels=visible.map(source=>source.id.toUpperCase()+' loading…');let pending=visible.length,failed=0;
  for(const [id,layer] of directRadarLayers)if(!wanted.has(id)){balticRadarLayer.removeLayer(layer);directRadarLayers.delete(id);}
  await Promise.allSettled(visible.map(async(source,index)=>{
    try{
      const frame=await prepareBalticRadarFrame(source,unix,latest,force);
      if(generation!==directRadarGeneration||!$('radarOn').checked)return;
      const previous=directRadarLayers.get(source.id);
      if(previous?.radarUrl!==frame.dataUrl){
        const layer=frame.prepared?preparedRadarCanvasLayer(frame,source.opacity):(typeof radarImageOverlay==='function'?radarImageOverlay:L.imageOverlay)(frame.dataUrl,frame.bounds,{opacity:source.opacity,interactive:false});layer.radarUrl=frame.dataUrl;layer.radarTime=frame.time;
        if(source.id==='lt'&&!frame.prepared)ensureRadarColourFilter();
        balticRadarLayer.addLayer(layer);if(source.id==='lt'&&!frame.prepared)layer.getElement().style.filter='url(#radar-echo-colours)';if(previous)balticRadarLayer.removeLayer(previous);directRadarLayers.set(source.id,layer);
      }
      labels[index]=source.id.toUpperCase()+' official '+fmt(frame.time)+(frame.prepared?' · prepared tiles':'');
    }catch(error){
      if(generation!==directRadarGeneration||!$('radarOn').checked)return;
      const previous=directRadarLayers.get(source.id);
      labels[index]=source.id.toUpperCase()+': '+error.message+(previous?' · keeping '+fmt(previous.radarTime):'');failed++;
    }
    if(generation!==directRadarGeneration||!$('radarOn').checked)return;
    pending--;balticRadarLayer.eachLayer(layer=>layer.bringToFront?.());radarLayer?.bringToFront?.();weatherFront();
    $('radarStatus').textContent=['Radar: EE official KAIA · '+fmt(radarLayer?.radarTime??unix)+(radarLayer?.radarPrepared?' · prepared tiles':''),...labels].join(' · ');
    $('radarStatus').className=failed?'status warn':pending?'status':'status ok';
  }));
}

