// Official Nordic radar observations, independent of the Estonian frame list.
const NORDIC_RADAR_SOURCES=[
  {id:'fi',name:'FI · FMI',bounds:[[56,16],[73,38]],format:'tif'},
  {id:'se',name:'SE · SMHI',bounds:[[53,4],[71,31]],format:'h5'},
  {id:'no',name:'NO · MET Norway',bounds:[[54,-1],[76,40]],format:'tif'},
  {id:'dk',name:'DK · DMI',bounds:[[52,2],[61,22]],format:'h5'},
  {id:'is',name:'IS · IMO',bounds:[[61,-29],[69,-10]],format:'h5'}
];
const nordicRadarLists=new Map(),nordicRadarFrames=new Map(),nordicRadarPending=new Map();
const nordicRadarJobs=new Map(),nordicRadarQueue=[];
const ICELAND_RADAR_SERVICE='https://northern-weather-radar.franz-sammel54.chatgpt.site';
let nordicRadarWorker=null,nordicRadarJobId=0,nordicRadarDownloads=0,nordicRadarGeneration=0,nordicRadarRefreshTimer=null;
const nordicRadarLayers=new Map();
let nordicRadarArchive=null;
function nordicRadarStatus(text,kind='status'){
  $('nordicRadarStatus').textContent=text;$('nordicRadarStatus').className=kind;
}
function nordicRadarVisible(source){return map.getBounds().intersects(L.latLngBounds(source.bounds));}
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
async function listNordicRadar(source,force=false){
  const cached=nordicRadarLists.get(source.id);
  if(!force&&cached&&Date.now()-cached.at<(source.id==='is'?45000:120000))return cached.promise;
  const promise=(async()=>{
    const last=Math.floor(Date.now()/1000),first=last-3*3600;
    let records=[];
    if(source.id==='is'){
      try{return await liveIcelandRadar();}catch(error){console.warn('Iceland live service unavailable; trying official archive',error);}
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
        records.push({time:Date.parse(file.properties.datetime)/1000,url:file.assets.data.href,format:'tif',quantity:'DBZH',projection:file.properties['proj:wkt2'],station:'no'});
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
  const worker=new Worker('js/nordic-radar-worker.js?v=8.34',{type:'module'});nordicRadarWorker=worker;
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
function nordicRadarFrame(record,edge,{background=false,canPrepare=()=>false}={}){
  const key=record.url+'|'+edge;
  if(nordicRadarFrames.has(key)){
    const entry=nordicRadarFrames.get(key);nordicRadarFrames.delete(key);nordicRadarFrames.set(key,entry);return Promise.resolve(entry);
  }
  if(nordicRadarPending.has(key)){
    if(!background){
      const index=nordicRadarQueue.findIndex(job=>job.key===key);
      if(index>=0){const [job]=nordicRadarQueue.splice(index,1);job.background=false;nordicRadarQueue.unshift(job);runNordicRadarQueue();}
    }
    return nordicRadarPending.get(key);
  }
  const allowed=()=>$('radarOn').checked||(background&&canPrepare());
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
      if(record.format==='dmi-wms')result=await prepareDmiRadarImage(record,edge,allowed);
      else if(record.format==='png'){
        const response=await fetch(record.url);if(!response.ok)throw new Error('Radar image HTTP '+response.status);
        buffer=await response.arrayBuffer();
      }else buffer=await nordicRadarFetch(descriptor.url,'binary');
      if(!allowed())throw new Error('Radar preparation paused');
      if(!result)result=record.format==='png'?{blob:new Blob([buffer],{type:'image/png'}),bounds:record.bounds}:await projectNordicRadar(buffer,descriptor,edge);
      if(!allowed())throw new Error('Radar preparation paused');
      const entry={...result,url:result.canvas?'dmi:'+key:URL.createObjectURL(result.blob),time:record.time};
      nordicRadarFrames.set(key,entry);
      while(nordicRadarFrames.size>180 || [...nordicRadarFrames.values()].reduce((bytes,frame)=>bytes+(frame.blob?.size??frame.canvas.width*frame.canvas.height*4),0)>24*1024*1024){const oldKey=nordicRadarFrames.keys().next().value,old=nordicRadarFrames.get(oldKey);if(old.blob)URL.revokeObjectURL(old.url);nordicRadarFrames.delete(oldKey);}
      return entry;
    }};
    if(background)nordicRadarQueue.push(job);
    else{const index=nordicRadarQueue.findIndex(queued=>queued.background);nordicRadarQueue.splice(index<0?nordicRadarQueue.length:index,0,job);}
    runNordicRadarQueue();
  }).finally(()=>{if(nordicRadarPending.get(key)===promise)nordicRadarPending.delete(key);});
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
function nordicRadarEdge(){const zoom=map.getZoom();return zoom>=7?2000:zoom<=4?900:1400;}
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
        const layer=(frame.canvas?dmiRadarCanvasLayer(frame):L.imageOverlay(frame.url,frame.bounds,{opacity:.84,interactive:false})).addTo(map);layer.radarUrl=frame.url;
        nordicRadarLayers.set(id,layer);if(previous)map.removeLayer(previous);
      }
      keep.add(id);times.push(record.time);
    }
    for(const [id,layer] of nordicRadarLayers)if(id.startsWith(source.id+':')&&!keep.has(id)){map.removeLayer(layer);nordicRadarLayers.delete(id);}
    labels[index]=times.length?source.name+' '+fmt(Math.min(...times))+(missing?' · partial coverage':''):source.name+' unavailable';
    if(missing||!times.length)failed++;
    pending--;
    for(const layer of nordicRadarLayers.values())layer.bringToFront();weatherFront();
    nordicRadarStatus((pending?'Loading Nordic radar · ':'')+labels.join(' · '),failed?'status warn':pending?'status':'status ok');
  }
  await Promise.allSettled(visible.map(async(source,index)=>{
    try{
      const records=await listNordicRadar(source,force);
      if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
    const stations=source.id==='is'?['iskef','isska','isx2']:[...new Set(records.map(record=>record.station))];
      const selected=stations.map(station=>radarObservationAt(records.filter(record=>record.station===station),unix)).filter(Boolean);
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
    const next=frames[Number($('timeline').value)+1];
    if(next)for(const source of visible){
      listNordicRadar(source).then(records=>{
        if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
        for(const station of new Set(records.map(record=>record.station))){
          const record=radarObservationAt(records.filter(record=>record.station===station),next.time);
          if(record)nordicRadarFrame(record,edge).catch(()=>{});
        }
      }).catch(()=>{});
    }
  }else{
    clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=setTimeout(()=>{
      const time=frames[Number($('timeline').value)]?.time;if(time)drawNordicRadars(time).catch(console.error);
    },visible.some(source=>source.id==='is')?60000:120000);
  }
}
map.on('moveend',()=>{
  if(!$('radarOn').checked)return;
  clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=setTimeout(()=>{
    const time=frames[Number($('timeline').value)]?.time;if(time)drawNordicRadars(time).catch(console.error);
  },180);
});
