// Official Nordic radar observations, independent of the Estonian frame list.
const NORDIC_RADAR_SOURCES=[
  {id:'fi',name:'FI · FMI',bounds:[[56,16],[73,38]],format:'tif'},
  {id:'se',name:'SE · SMHI',bounds:[[53,4],[71,31]],format:'h5'},
  {id:'no',name:'NO · MET Norway',bounds:[[54,-1],[76,40]],format:'tif'},
  {id:'dk',name:'DK · DMI',bounds:[[52,2],[61,22]],format:'h5'},
  {id:'is',name:'IS · IMO',bounds:[[61,-29],[69,-10]],format:'h5'}
];
const nordicRadarLists=new Map(),nordicRadarFrames=new Map(),nordicRadarPending=new Map();
const nordicRadarJobs=new Map(),nordicRadarQueue=[],nordicRadarPromote=new Map();
const ICELAND_RADAR_SERVICE='https://northern-weather-radar.franz-sammel54.chatgpt.site';
let nordicRadarWorker=null,nordicRadarJobId=0,nordicRadarDownloads=0,nordicRadarGeneration=0,nordicRadarRefreshTimer=null;
const nordicRadarLayers=new Map();
let nordicRadarArchive=null;
function nordicRadarStatus(text,kind='status'){
  $('nordicRadarStatus').textContent=text;$('nordicRadarStatus').className=kind;
}
const radarFootprints=new Map();
function radarLightMode(){
  return typeof navigator!=='undefined'&&!!navigator.connection?.saveData ||
    typeof window!=='undefined'&&!!window.matchMedia?.('(pointer: coarse)').matches;
}
function radarFootprintVisible(footprint){
  const view=map.getBounds(),bounds=L.latLngBounds(footprint.bounds);
  if(!view.intersects(bounds))return false;
  if(!footprint.cells)return true;
  // Cells describe the native scan geometry, including dry observations.
  // They never use rain intensity to decide whether a source is needed.
  const [[south,west],[north,east]]=footprint.bounds;
  const top=radarMercatorY(north),bottom=radarMercatorY(south),cols=footprint.cols,rows=footprint.rows;
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++)if(footprint.cells[y*cols+x]){
    const cell=[[radarLatitudeAtY(top-(y+1)/rows*(top-bottom)),west+x/cols*(east-west)],
                [radarLatitudeAtY(top-y/rows*(top-bottom)),west+(x+1)/cols*(east-west)]];
    if(view.intersects(L.latLngBounds(cell)))return true;
  }
  return false;
}
function radarRecordVisible(record){
  if(map.getZoom()<6&&!radarLightMode())return true;
  const known=radarFootprints.get(record.station);
  if(record.bounds&&!radarFootprintVisible({bounds:record.bounds}))return false;
  return !known||Date.now()-known.at>10*60*1000||radarFootprintVisible(known);
}
function nordicRadarVisible(source){
  if(!map.getBounds().intersects(L.latLngBounds(source.bounds)))return false;
  if(map.getZoom()<6&&!radarLightMode())return true;
  const stations=source.id==='is'?['iskef','isska','isx2']:[source.id];
  return stations.some(station=>{const known=radarFootprints.get(station);return !known||Date.now()-known.at>10*60*1000||radarFootprintVisible(known);});
}
function radarObservationAt(records,time,maxDelay=900){
  let best=null;
  for(const frame of records||[])if(frame.time<=time && time-frame.time<=maxDelay && (!best||frame.time>best.time))best=frame;
  return best;
}
function radarUtcDay(unix){return new Date(unix*1000).toISOString().slice(0,10);}
function radarUtcDays(first,last){return [...new Set([radarUtcDay(first),radarUtcDay(last)])];}
function trustedNordicRadarUrl(url){
  try{
    const u=new URL(url);return u.protocol==='https:'&&['opendata.fmi.fi','openwms.fmi.fi','opendata-download-radar.smhi.se','radar-stacapi.met.no','rgw.met.no','opendataapi.dmi.dk','brunnur.vedur.is'].includes(u.hostname);
  }catch(_){return false;}
}
function trustedIcelandRadarRelay(url){
  try{const u=new URL(url);return u.origin===ICELAND_RADAR_SERVICE&&!u.search&&!u.hash&&/^\/api\/iceland\/file\/\d{4}-\d{2}-\d{2}\/(iskef|isska|isx2)\/T_PAGZ\d+_C_BIRK_\d{14}\.h5$/.test(u.pathname);}catch(_){return false;}
}
async function nordicRadarFetch(url,type='text',{proxy=true}={}){
  const relay=trustedIcelandRadarRelay(url);
  if(!trustedNordicRadarUrl(url)&&!relay)throw new Error('Unexpected national radar URL');
  const get=async target=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
    try{
      const response=await fetch(target,{signal:controller.signal,cache:'default'});
      if(!response.ok)throw new Error('Radar HTTP '+response.status);
      return type==='binary'?await response.arrayBuffer():await response.text();
    }finally{clearTimeout(timer);}
  };
  try{return await get(url);}catch(error){
    if(relay||!proxy)throw error;
    // Legacy fallback for raw Nordic files that lack browser CORS support.
    return get(directRadarProxyUrl(url));
  }
}
async function liveIcelandRadar(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
  try{
    const response=await fetch(ICELAND_RADAR_SERVICE+'/api/iceland/radar',{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error('Iceland live radar HTTP '+response.status);
    const data=await response.json(),last=Date.now()/1000,first=last-10800;
    const records=(data.frames||[]).map(frame=>({...frame,url:ICELAND_RADAR_SERVICE+frame.path})).filter(frame=>frame.format==='h5'&&['iskef','isska','isx2'].includes(frame.station)&&Number.isFinite(frame.time)&&frame.time>=first&&frame.time<=last&&trustedIcelandRadarRelay(frame.url)&&trustedNordicRadarUrl(frame.source_url));
    if(!records.length)throw new Error('No recent official Iceland radar scans');
    return records.sort((a,b)=>a.time-b.time);
  }finally{clearTimeout(timer);}
}
async function nordicRadarJson(url,options){return JSON.parse(await nordicRadarFetch(url,'text',options));}
function xmlRadarText(element,name){return element.getElementsByTagNameNS('*',name)[0]?.textContent?.trim()||'';}
function fmiRadarRecords(xml){
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror'))throw new Error('Invalid FMI radar metadata');
  const records=[];
  for(const observation of doc.getElementsByTagNameNS('*','GridSeriesObservation')){
    const url=xmlRadarText(observation,'fileReference'),time=Date.parse(xmlRadarText(observation,'timePosition'))/1000;
    if(!trustedNordicRadarUrl(url)||!Number.isFinite(time)||!url.includes('geotiff'))continue;
    let gain=.01,offset=0;
    for(const parameter of observation.getElementsByTagNameNS('*','NamedValue')){
      const name=parameter.getElementsByTagNameNS('*','name')[0];
      const reference=name?.getAttributeNS('http://www.w3.org/1999/xlink','href')||name?.textContent||'';
      const value=Number(xmlRadarText(parameter,'value'));
      if(reference.includes('linearTransformationGain')&&Number.isFinite(value))gain=value;
      if(reference.includes('linearTransformationOffset')&&Number.isFinite(value))offset=value;
    }
    records.push({time,url,format:'tif',quantity:'RATE',gain,offset,nodata:65535,undetect:0,station:'fi'});
  }
  return records;
}
function validNordicRadarArchiveFrame(frame,source){
  return frame.source===source.id&&['dk','iskef','isska','isx2'].includes(frame.station)&&
    Number.isFinite(frame.time)&&frame.format==='png'&&
    /^data\/radar-cache\/(dk|iskef|isska|isx2)-\d+-[a-f0-9]{12}\.png$/.test(frame.url)&&
    frame.bounds?.length===2&&frame.bounds.every(point=>point.length===2&&point.every(Number.isFinite))&&
    frame.bounds[0][0]>=-85&&frame.bounds[1][0]<=85&&frame.bounds[0][0]<frame.bounds[1][0]&&
    frame.bounds[0][1]>=-180&&frame.bounds[1][1]<=180&&frame.bounds[0][1]<frame.bounds[1][1]&&
    trustedNordicRadarUrl(frame.source_url);
}
async function cachedNordicRadar(source){
  if(!nordicRadarArchive||Date.now()-nordicRadarArchive.at>120000){
    const promise=fetch('data/nordic-radar-cache.json?v='+Math.floor(Date.now()/120000),{cache:'no-cache'})
      .then(response=>{if(!response.ok)throw new Error('Radar archive HTTP '+response.status);return response.json();});
    nordicRadarArchive={at:Date.now(),promise};
  }
  const data=await nordicRadarArchive.promise;
  return (data.frames||[]).filter(frame=>validNordicRadarArchiveFrame(frame,source)).sort((a,b)=>a.time-b.time);
}
function preparedIcelandRadar(records,prepared){
  const images=new Map(prepared.map(frame=>[frame.station+'|'+frame.time,frame]));
  return records.map(record=>{
    const image=images.get(record.station+'|'+record.time);
    return image&&image.source_url===(record.source_url||record.url)?image:record;
  });
}
async function listNordicRadar(source,force=false){
  const cached=nordicRadarLists.get(source.id);
  if(!force&&cached&&Date.now()-cached.at<(source.id==='is'?45000:120000))return cached.promise;
  const promise=(async()=>{
    const last=Math.floor(Date.now()/1000),first=last-3*3600;
    let records=[];
    if(source.id==='is'){
      // Fetch the prepared archive alongside live metadata. Only exact scans
      // replace raw files; archive age never substitutes an older observation.
      try{ensureNordicRadarWorker().postMessage({warmup:true});}catch(_){}
      const prepared=cachedNordicRadar(source).catch(()=>[]);
      try{
        const live=await liveIcelandRadar();
        let timer;
        const images=await Promise.race([prepared,new Promise(resolve=>{timer=setTimeout(()=>resolve([]),1500);})]);
        clearTimeout(timer);
        return preparedIcelandRadar(live,images);
      }catch(error){console.warn('Iceland live service unavailable; trying official archive',error);}
    }
    if(source.id==='dk'){
      try{
        const params=new URLSearchParams({limit:'100',sortorder:'datetime,DESC',datetime:new Date(first*1000).toISOString()+'/'+new Date(last*1000).toISOString()});
        const data=await nordicRadarJson('https://opendataapi.dmi.dk/v1/radardata/collections/composite/items?'+params,{proxy:false});
        records=(data.features||[]).map(file=>({time:Date.parse(file.properties?.datetime)/1000,url:file.asset?.data?.href||file.assets?.data?.href,format:'dmi-wms',station:'dk'}))
          .filter(record=>Number.isFinite(record.time)&&record.time>=first&&record.time<=last&&trustedNordicRadarUrl(record.url));
        if(!records.length)throw new Error('DMI has no recent observations');
        return records.sort((a,b)=>a.time-b.time);
      }catch(error){console.warn('DMI direct metadata unavailable; trying archive',error);return cachedNordicRadar(source);}
    }
    if(source.id==='is'){
      try{records=await cachedNordicRadar(source);if(records.length)return records;}catch(error){console.warn(source.name+' archive unavailable',error);}
    }
    if(source.id==='fi'){
      const params=new URLSearchParams({service:'WFS',version:'2.0.0',request:'getFeature',storedquery_id:'fmi::radar::composite::rr',starttime:new Date(first*1000).toISOString(),endtime:new Date(last*1000).toISOString()});
      records=fmiRadarRecords(await nordicRadarFetch('https://opendata.fmi.fi/wfs?'+params));
    }else if(source.id==='se'){
      const days=await Promise.all(radarUtcDays(first,last).map(day=>nordicRadarJson('https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp/'+day.replaceAll('-','/'))));
      for(const data of days)for(const file of data.files||[]){
        const format=file.formats?.find(f=>f.key==='h5');
        const time=Date.parse(file.valid.replace(' ','T')+'Z')/1000;
        if(format&&time>=first&&time<=last)records.push({time,url:format.link,format:'h5',station:'se'});
      }
    }else if(source.id==='no'){
      const params=new URLSearchParams({limit:'200',datetime:new Date(first*1000).toISOString()+'/'+new Date(last*1000).toISOString()});
      const data=await nordicRadarJson('https://radar-stacapi.met.no/v1/collections/Mosaic-Norway-v1/items?'+params);
      for(const file of data.features||[]){
        if(file.properties?.dataType!=='dBZ'||!file.assets?.data?.href)continue;
        const box=file.bbox;
        const bounds=box?.length===4&&box.every(Number.isFinite)&&box[0]>=-180&&box[2]<=180&&box[1]>=-85&&box[3]<=85&&box[0]<box[2]&&box[1]<box[3]?[[box[1],box[0]],[box[3],box[2]]]:undefined;
        records.push({time:Date.parse(file.properties.datetime)/1000,url:file.assets.data.href,format:'tif',quantity:'DBZH',projection:file.properties['proj:wkt2'],station:'no',bounds});
      }
    }else{
      const days=radarUtcDays(first,last);
      const results=await Promise.allSettled(days.flatMap(day=>['iskef','isska','isx2'].map(async station=>{
        const base='https://brunnur.vedur.is/radar/data/'+day+'/'+station+'/';
        const html=await nordicRadarFetch(base),out=[];
        for(const match of html.matchAll(/href="(T_PAGZ\d+_C_BIRK_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.h5)"/g)){
          const time=Date.UTC(+match[2],+match[3]-1,+match[4],+match[5],+match[6])/1000;
          if(time>=first&&time<=last)out.push({time,url:base+match[1],format:'h5',station});
        }
        return out;
      })));
      records=results.flatMap(result=>result.status==='fulfilled'?result.value:[]);
    }
    records=records.filter(record=>Number.isFinite(record.time)&&trustedNordicRadarUrl(record.url)).sort((a,b)=>a.time-b.time);
    if(!records.length)throw new Error(source.name+' has no recent observations');
    return records;
  })();
  nordicRadarLists.set(source.id,{at:Date.now(),promise});
  return promise;
}
function ensureNordicRadarWorker(){
  if(nordicRadarWorker)return nordicRadarWorker;
  if(!window.Worker||!window.OffscreenCanvas)throw new Error('This browser needs Web Workers and OffscreenCanvas for Nordic radar');
  const worker=new Worker('js/nordic-radar-worker.js?v=8.80',{type:'module'});nordicRadarWorker=worker;
  worker.onmessage=event=>{
    const job=nordicRadarJobs.get(event.data.id);if(!job)return;
    clearTimeout(job.timer);nordicRadarJobs.delete(event.data.id);
    if(event.data.error)job.reject(new Error(event.data.error));else job.resolve(event.data);
  };
  worker.onerror=()=>{
    for(const job of nordicRadarJobs.values()){clearTimeout(job.timer);job.reject(new Error('Radar background decoder could not start'));}
    nordicRadarJobs.clear();worker.terminate();nordicRadarWorker=null;
  };
  return worker;
}
function projectNordicRadar(buffer,descriptor,edge){
  return new Promise((resolve,reject)=>{
    const worker=ensureNordicRadarWorker(),id=++nordicRadarJobId;
    const timer=setTimeout(()=>{nordicRadarJobs.delete(id);reject(new Error('Radar processing timed out'));},60000);
    nordicRadarJobs.set(id,{resolve,reject,timer});worker.postMessage({id,buffer,descriptor,edge},[buffer]);
  });
}
function runNordicRadarQueue(){
  while(nordicRadarDownloads<2&&nordicRadarQueue.length){
    // Background preparation uses one slot; selected observations take priority.
    if(nordicRadarQueue[0].background&&nordicRadarDownloads)break;
    const job=nordicRadarQueue.shift();nordicRadarDownloads++;
    job.run().then(job.resolve,job.reject).finally(()=>{nordicRadarDownloads--;runNordicRadarQueue();});
  }
}
function decodeNordicRadarImage(url){
  if(typeof weatherDataUrl==='function')url=weatherDataUrl(url);
  // Preload the actual display element, including decoding, rather than only
  // the PNG bytes. Leaflet can reuse this ready image without a second load.
  return new Promise((resolve,reject)=>{
    const image=new Image();if(typeof window!=='undefined'&&((window.WEATHER_R2_BASE&&url.startsWith(window.WEATHER_R2_BASE+'/'))||url.startsWith('https://raw.githubusercontent.com/Snowblind54/weather-page/weather-fallback/')))image.crossOrigin='anonymous';image.decoding='async';
    let settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);image.onload=image.onerror=null;
      if(error){image.src='';reject(error);}else resolve(image);
    };
    const timer=setTimeout(()=>finish(new Error('Radar image decoding timed out')),8000);
    image.onerror=()=>finish(new Error('Radar image could not be displayed'));
    image.onload=async()=>{
      try{
        if(!image.naturalWidth||!image.naturalHeight)throw new Error('Empty radar image');
        if(image.decode)await image.decode();
        finish();
      }catch(error){finish(error);}
    };
    image.src=url;
  });
}
function orderNordicRadarLayers(){
  // Keep cross-border priority independent of network completion order.
  const priority=['no','dk','se','fi','is'];
  const ordered=[...nordicRadarLayers].sort(([a],[b])=>priority.indexOf(a.split(':')[0])-priority.indexOf(b.split(':')[0])||(a<b?-1:a>b?1:0));
  for(const [,layer] of ordered)layer.bringToFront();
  weatherFront();
}
function trimNordicRadarFrames(){
  // Keep compressed prepared images after releasing their decoded pixels.
  // Revisiting Iceland history then needs only PNG decode, not HDF download
  // and radar reprojection again. Canvas-only DMI frames remain fully bounded.
  const total=()=>[...nordicRadarFrames.values()].reduce((n,f)=>n+f.bytes,0);
  const light=radarLightMode(),decodedLimit=(light?20:48)*1024*1024,byteLimit=(light?36:80)*1024*1024;
  for(const [key,entry] of nordicRadarFrames){
    if(total()<=decodedLimit)break;
    if(entry.image){entry.image=null;entry.bytes=entry.blob.size;}
    else if(entry.canvas){nordicRadarFrames.delete(key);}
  }
  while(nordicRadarFrames.size>(light?60:180)||total()>byteLimit){
    const key=nordicRadarFrames.keys().next().value,entry=nordicRadarFrames.get(key);
    if(entry.blob)URL.revokeObjectURL(entry.url);nordicRadarFrames.delete(key);
  }
}
function nordicRadarFrame(record,edge,{background=false,canPrepare=()=>false}={}){
  const viewBounds=record.format==='dmi-wms'&&radarLightMode()?radarDmiViewportBounds():null;
  const key=record.url+'|'+edge+(viewBounds?'|'+JSON.stringify(viewBounds):'');
  if(nordicRadarFrames.has(key)){
    const entry=nordicRadarFrames.get(key);nordicRadarFrames.delete(key);nordicRadarFrames.set(key,entry);
    if(entry.blob&&!entry.image){
      if(nordicRadarPending.has(key))return nordicRadarPending.get(key);
      const promise=decodeNordicRadarImage(entry.url).then(image=>{
        entry.image=image;entry.bytes=entry.blob.size+image.naturalWidth*image.naturalHeight*4;trimNordicRadarFrames();return {...entry,image};
      }).finally(()=>{if(nordicRadarPending.get(key)===promise)nordicRadarPending.delete(key);});
      nordicRadarPending.set(key,promise);return promise;
    }
    return Promise.resolve(entry);
  }
  if(nordicRadarPending.has(key)){
    if(!background){
      nordicRadarPromote.get(key)?.();
      const index=nordicRadarQueue.findIndex(job=>job.key===key);
      if(index>=0){const [job]=nordicRadarQueue.splice(index,1);job.background=false;nordicRadarQueue.unshift(job);runNordicRadarQueue();}
    }
    return nordicRadarPending.get(key);
  }
  let promoted=!background;
  const allowed=()=>promoted?$('radarOn').checked:canPrepare();
  nordicRadarPromote.set(key,()=>{promoted=true;});
  const promise=new Promise((resolve,reject)=>{
    const job={key,background,resolve,reject,run:async()=>{
      if(!allowed())throw new Error('Radar preparation paused');
      const descriptor={...record};
      if(record.station==='fi'){
        const url=new URL(record.url),width=Number(url.searchParams.get('width')),height=Number(url.searchParams.get('height'));
        const scale=Math.min(1,edge/Math.max(width,height));
        if(Number.isFinite(scale)&&scale>0){
          url.searchParams.set('width',String(Math.max(1,Math.round(width*scale))));
          url.searchParams.set('height',String(Math.max(1,Math.round(height*scale))));
          descriptor.url=url.href;
        }
      }
      let buffer,result;
      if(record.format==='dmi-wms')result=await prepareDmiRadarImage({...record,viewBounds},edge,allowed);
      else if(record.format==='png'){
        const response=await fetch(record.url);if(!response.ok)throw new Error('Radar image HTTP '+response.status);
        buffer=await response.arrayBuffer();
      }else buffer=await nordicRadarFetch(descriptor.url,'binary');
      if(!allowed())throw new Error('Radar preparation paused');
      if(!result)result=record.format==='png'?{blob:new Blob([buffer],{type:'image/png'}),bounds:record.bounds}:await projectNordicRadar(buffer,descriptor,edge);
      if(!allowed())throw new Error('Radar preparation paused');
      radarFootprints.set(record.station,{...(result.coverage||{bounds:result.bounds}),at:Date.now()});
      const entry={...result,url:result.canvas?'dmi:'+key:URL.createObjectURL(result.blob),time:record.time};
      if(entry.blob){
        try{
          entry.image=await decodeNordicRadarImage(entry.url);
          if(!allowed())throw new Error('Radar preparation paused');
        }catch(error){URL.revokeObjectURL(entry.url);throw error;}
      }
      // Count decoded pixels as well as compressed bytes. Active layers keep
      // their image element even if its object URL is evicted from this cache.
      entry.bytes=(entry.blob?.size||0)+(entry.image?entry.image.naturalWidth*entry.image.naturalHeight*4:entry.canvas.width*entry.canvas.height*4);
      nordicRadarFrames.set(key,entry);
      trimNordicRadarFrames();
      return entry;
    }};
    if(background)nordicRadarQueue.push(job);
    else{const index=nordicRadarQueue.findIndex(queued=>queued.background);nordicRadarQueue.splice(index<0?nordicRadarQueue.length:index,0,job);}
    runNordicRadarQueue();
  }).finally(()=>{if(nordicRadarPending.get(key)===promise){nordicRadarPending.delete(key);nordicRadarPromote.delete(key);}});
  nordicRadarPending.set(key,promise);return promise;
}
function clearNordicRadars(){
  nordicRadarGeneration++;
  for(const layer of nordicRadarLayers.values())map.removeLayer(layer);nordicRadarLayers.clear();
  // Hiding the layer keeps the bounded image cache and shared preparation alive.
  for(let i=nordicRadarQueue.length-1;i>=0;i--)if(!nordicRadarQueue[i].background){const [job]=nordicRadarQueue.splice(i,1);nordicRadarPending.delete(job.key);job.reject(new Error('Radar disabled'));}
  clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=null;
  nordicRadarStatus('Nordic radar is off.');
}
function nordicRadarEdge(){const zoom=map.getZoom();return zoom>=7?2000:radarLightMode()?(zoom<=4?512:900):zoom<=4?900:1400;}
function followNordicRadarClock(){
  if(playing||typeof radarTimelineFrames==='undefined'||!radarTimelineFrames.length||typeof cloudTimelineMode!=='undefined'&&cloudTimelineMode||Number($('timeline').value)!==Number($('timeline').max))return;
  const end=Math.floor(Date.now()/1000/300)*300-300,last=radarTimelineFrames.at(-1).time;
  if(end<=last)return;
  // The observation clock must remain live even when Estonia publishes late.
  for(let time=Math.max(last+300,end-7200);time<=end;time+=300)radarTimelineFrames.push({id:'clock-'+time,time,url:null});
  radarTimelineFrames=radarTimelineFrames.slice(-25);frames=radarTimelineFrames;
  $('timeline').max=frames.length-1;$('timeline').value=frames.length-1;
  if(typeof renderTimelineTicks==='function')renderTimelineTicks();
  $('timeLabel').textContent=fmt(frames.at(-1).time)+' · latest';
}
async function drawNordicRadars(unix,{force=false}={}){
  if(!$('radarOn').checked){clearNordicRadars();return;}
  const generation=++nordicRadarGeneration,edge=nordicRadarEdge(),visible=NORDIC_RADAR_SOURCES.filter(nordicRadarVisible);
  if(visible.some(source=>source.id==='is')){followNordicRadarClock();if(typeof frames!=='undefined')unix=frames[Number($('timeline').value)]?.time||unix;}
  // A rapid scrub should prepare the selected frame, not a backlog of old selections.
  for(let i=nordicRadarQueue.length-1;i>=0;i--)if(!nordicRadarQueue[i].background){const [job]=nordicRadarQueue.splice(i,1);nordicRadarPending.delete(job.key);job.reject(new Error('Radar selection changed'));}
  const wanted=new Set(visible.map(source=>source.id));
  for(const [id,layer] of nordicRadarLayers)if(!wanted.has(id.split(':')[0])){map.removeLayer(layer);nordicRadarLayers.delete(id);}
  if(!visible.length){nordicRadarStatus('Nordic radar: outside this view.');return;}
  nordicRadarStatus('Loading Nordic radar…');
  const labels=visible.map(source=>source.name+' loading…');let failed=0,pending=visible.length;
  function finishSource(source,index,result){
    if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
    const keep=new Set(),times=[];let missing=0;
    if(result.error){console.warn(source.name+' radar unavailable',result.error);missing++;}
    for(const frameResult of result.rendered||[]){
      if(frameResult.status!=='fulfilled'){console.warn(source.name+' radar frame unavailable',frameResult.reason);missing++;continue;}
      const {record,frame}=frameResult.value,id=source.id+':'+record.station;
      const previous=nordicRadarLayers.get(id);
      if(previous?.radarUrl!==frame.url){
        // The old layer stays visible throughout download and decoding. Add
        // the ready replacement before removing it, in the same paint turn.
        const layer=(frame.prepared?preparedRadarCanvasLayer(frame):frame.canvas?dmiRadarCanvasLayer(frame):(typeof radarImageOverlay==='function'?radarImageOverlay(frame.image,frame.bounds,{opacity:.84,interactive:false}):L.imageOverlay(frame.image,frame.bounds,{opacity:.84,interactive:false}))).addTo(map);layer.radarUrl=frame.url;layer.radarCoverage=frame.coverage;layer.radarTime=record.time;
        nordicRadarLayers.set(id,layer);if(previous)map.removeLayer(previous);
      }
      keep.add(id);times.push(record.time);
    }
    // A failed provider keeps its last successfully displayed observation,
    // with the actual time disclosed instead of presenting it as current.
    const retained=[];
    for(const [id,layer] of nordicRadarLayers)if(id.startsWith(source.id+':')&&!keep.has(id)){
      if(missing&&Number.isFinite(layer.radarTime))retained.push(layer.radarTime);
      else{map.removeLayer(layer);nordicRadarLayers.delete(id);}
    }
    labels[index]=times.length?source.name+' '+fmt(Math.min(...times))+(missing?' · partial coverage':''):source.name+' unavailable';
    if(retained.length)labels[index]+=' · keeping '+fmt(Math.min(...retained));
    if(result.rendered?.some(r=>r.value?.frame.prepared))labels[index]+=' · prepared tiles';
    if(missing||!times.length)failed++;
    pending--;
    orderNordicRadarLayers();
    nordicRadarStatus((pending?'Loading Nordic radar · ':'')+labels.join(' · '),failed?'status warn':pending?'status':'status ok');
  }
  await Promise.allSettled(visible.map(async(source,index)=>{
    try{
      const prepared=typeof preparedRadarFrame==='function'?await preparedRadarFrame(source.id,unix,{canPrepare:()=>generation===nordicRadarGeneration&&$('radarOn').checked}):null;
      if(prepared){finishSource(source,index,{rendered:[{status:'fulfilled',value:{record:{station:prepared.station,time:prepared.time},frame:prepared}}]});return;}
      const records=await listNordicRadar(source,force);
      if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
    const stations=(source.id==='is'?['iskef','isska','isx2']:[...new Set(records.map(record=>record.station))]).filter(station=>radarRecordVisible({station}));
      const observations=stations.map(station=>radarObservationAt(records.filter(record=>record.station===station),unix)).filter(Boolean);
      const selected=observations.filter(radarRecordVisible);
      if(observations.length&&!selected.length){
        for(const [id,layer] of nordicRadarLayers)if(id.startsWith(source.id+':')){map.removeLayer(layer);nordicRadarLayers.delete(id);}
        orderNordicRadarLayers();
        labels[index]=source.name+' outside scan area';pending--;
        nordicRadarStatus((pending?'Loading Nordic radar · ':'')+labels.join(' · '),failed?'status warn':pending?'status':'status ok');
        return;
      }
      if(!selected.length)throw new Error(source.name+' unavailable at '+fmt(unix));
      const rendered=await Promise.allSettled(selected.map(async record=>({record,frame:await nordicRadarFrame(record,edge)})));
      // Missing stations count as partial coverage rather than a dry radar image.
      const missing=stations.length-selected.length;
      for(let i=0;i<missing;i++)rendered.push({status:'rejected',reason:new Error('Station has no matching observation')});
      finishSource(source,index,{rendered});
    }catch(error){finishSource(source,index,{error});}
  }));
  if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
  if(playing){
    scheduleRadarPlaybackPreload();
  }else{
    clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=setTimeout(()=>{
      const frame=frames[Number($('timeline').value)];if(frame){
      refreshSelectedRadarFrame(frame);
    }
    },visible.some(source=>source.id==='is')?60000:120000);
  }
}
function refreshSelectedRadarFrame(frame){
  const selection=beginRadarSelectedFrame(frame.time);
  return Promise.allSettled([drawNordicRadars(frame.time),drawDirectNationalRadars(frame.time),drawRadar(frame)])
    .then(()=>finishRadarSelectedFrame(frame.time,selection));
}
map.on('moveend',()=>{
  if(!$('radarOn').checked)return;
  clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=setTimeout(()=>{
    const frame=frames[Number($('timeline').value)];if(frame){
      refreshSelectedRadarFrame(frame);
    }
  },180);
});
