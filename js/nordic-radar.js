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
let nordicRadarWorker=null,nordicRadarJobId=0,nordicRadarDownloads=0,nordicRadarGeneration=0,nordicRadarRefreshTimer=null;
const nordicRadarLayers=new Map();
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
async function nordicRadarFetch(url,type='text'){
  if(!trustedNordicRadarUrl(url))throw new Error('Unexpected national radar URL');
  const get=async target=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
    try{
      const response=await fetch(target,{signal:controller.signal,cache:'default'});
      if(!response.ok)throw new Error('Radar HTTP '+response.status);
      return type==='binary'?await response.arrayBuffer():await response.text();
    }finally{clearTimeout(timer);}
  };
  try{return await get(url);}catch(error){
    // Same existing public relay as the Baltic feeds, only for CORS/network failure.
    return get(directRadarProxyUrl(url));
  }
}
async function nordicRadarJson(url){return JSON.parse(await nordicRadarFetch(url));}
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
async function listNordicRadar(source,force=false){
  const cached=nordicRadarLists.get(source.id);
  if(!force&&cached&&Date.now()-cached.at<120000)return cached.promise;
  const promise=(async()=>{
    const last=Math.floor(Date.now()/1000),first=last-3*3600;
    let records=[];
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
    }else if(source.id==='dk'){
      const params=new URLSearchParams({limit:'100',sortorder:'datetime,DESC',datetime:new Date(first*1000).toISOString()+'/'+new Date(last*1000).toISOString()});
      const data=await nordicRadarJson('https://opendataapi.dmi.dk/v1/radardata/collections/composite/items?'+params);
      for(const file of data.features||[]){
        const url=file.asset?.data?.href||file.assets?.data?.href;
        if(url)records.push({time:Date.parse(file.properties.datetime)/1000,url,format:'h5',station:'dk'});
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
  try{return await promise;}catch(error){nordicRadarLists.delete(source.id);throw error;}
}
function ensureNordicRadarWorker(){
  if(nordicRadarWorker)return nordicRadarWorker;
  if(!window.Worker||!window.OffscreenCanvas)throw new Error('This browser needs Web Workers and OffscreenCanvas for Nordic radar');
  const worker=new Worker('js/nordic-radar-worker.js?v=8.32',{type:'module'});nordicRadarWorker=worker;
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
    const job=nordicRadarQueue.shift();nordicRadarDownloads++;
    job.run().then(job.resolve,job.reject).finally(()=>{nordicRadarDownloads--;runNordicRadarQueue();});
  }
}
function nordicRadarFrame(record,edge){
  const key=record.url+'|'+edge;
  if(nordicRadarFrames.has(key)){
    const entry=nordicRadarFrames.get(key);nordicRadarFrames.delete(key);nordicRadarFrames.set(key,entry);return Promise.resolve(entry);
  }
  if(nordicRadarPending.has(key))return nordicRadarPending.get(key);
  const promise=new Promise((resolve,reject)=>{
    nordicRadarQueue.push({resolve,reject,run:async()=>{
      if(!$('radarOn').checked)throw new Error('Radar disabled');
      const buffer=await nordicRadarFetch(record.url,'binary');
      if(!$('radarOn').checked)throw new Error('Radar disabled');
      const result=await projectNordicRadar(buffer,record,edge);
      if(!$('radarOn').checked)throw new Error('Radar disabled');
      const entry={...result,url:URL.createObjectURL(result.blob),time:record.time};
      nordicRadarFrames.set(key,entry);
      while(nordicRadarFrames.size>180 || [...nordicRadarFrames.values()].reduce((bytes,frame)=>bytes+frame.blob.size,0)>24*1024*1024){const oldKey=nordicRadarFrames.keys().next().value;URL.revokeObjectURL(nordicRadarFrames.get(oldKey).url);nordicRadarFrames.delete(oldKey);}
      return entry;
    }});runNordicRadarQueue();
  }).finally(()=>nordicRadarPending.delete(key));
  nordicRadarPending.set(key,promise);return promise;
}
function clearNordicRadars(){
  nordicRadarGeneration++;
  for(const layer of nordicRadarLayers.values())map.removeLayer(layer);nordicRadarLayers.clear();
  for(const job of nordicRadarQueue.splice(0))job.reject(new Error('Radar disabled'));
  for(const job of nordicRadarJobs.values()){clearTimeout(job.timer);job.reject(new Error('Radar disabled'));}nordicRadarJobs.clear();
  nordicRadarWorker?.terminate();nordicRadarWorker=null;
  for(const entry of nordicRadarFrames.values())URL.revokeObjectURL(entry.url);nordicRadarFrames.clear();
  clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=null;
  nordicRadarStatus('Nordic radar is off.');
}
function nordicRadarEdge(){const zoom=map.getZoom();return zoom>=7?2000:zoom<=4?900:1400;}
async function drawNordicRadars(unix,{force=false}={}){
  if(!$('radarOn').checked){clearNordicRadars();return;}
  const generation=++nordicRadarGeneration,edge=nordicRadarEdge(),visible=NORDIC_RADAR_SOURCES.filter(nordicRadarVisible);
  const wanted=new Set(visible.map(source=>source.id));
  for(const [id,layer] of nordicRadarLayers)if(!wanted.has(id.split(':')[0])){map.removeLayer(layer);nordicRadarLayers.delete(id);}
  if(!visible.length){nordicRadarStatus('Nordic radar: outside this view.');return;}
  nordicRadarStatus('Loading Nordic radar…');
  const results=await Promise.allSettled(visible.map(async source=>{
    const records=await listNordicRadar(source,force);
    if(generation!==nordicRadarGeneration||!$('radarOn').checked)throw new Error('Radar selection changed');
    const stations=[...new Set(records.map(record=>record.station))];
    const selected=stations.map(station=>radarObservationAt(records.filter(record=>record.station===station),unix)).filter(Boolean);
    if(!selected.length)throw new Error(source.name+' unavailable at '+fmt(unix));
    const rendered=await Promise.allSettled(selected.map(async record=>({record,frame:await nordicRadarFrame(record,edge)})));
    return {source,rendered};
  }));
  if(generation!==nordicRadarGeneration||!$('radarOn').checked)return;
  const labels=[],keep=new Set();let failed=0;
  for(let index=0;index<results.length;index++){
    const result=results[index],source=visible[index];
    if(result.status!=='fulfilled'){labels.push(source.name+' unavailable');failed++;continue;}
    const times=[];let missing=0;
    for(const frameResult of result.value.rendered){
      if(frameResult.status!=='fulfilled'){missing++;continue;}
      const {record,frame}=frameResult.value,id=source.id+':'+record.station;
      const previous=nordicRadarLayers.get(id);
      if(previous?.radarUrl!==frame.url){
        const layer=L.imageOverlay(frame.url,frame.bounds,{opacity:.84,interactive:false}).addTo(map);layer.radarUrl=frame.url;
        nordicRadarLayers.set(id,layer);if(previous)map.removeLayer(previous);
      }
      keep.add(id);times.push(record.time);
    }
    if(!times.length){labels.push(source.name+' unavailable');failed++;}
    else {labels.push(source.name+' '+fmt(Math.min(...times))+(missing?' · partial coverage':''));if(missing)failed++;}
  }
  // An unavailable selected observation must not leave a different time on the map.
  for(const [id,layer] of nordicRadarLayers)if(!keep.has(id)){map.removeLayer(layer);nordicRadarLayers.delete(id);}
  for(const layer of nordicRadarLayers.values())layer.bringToFront();weatherFront();
  nordicRadarStatus(labels.join(' · '),failed?'status warn':'status ok');
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
    },120000);
  }
}
map.on('moveend',()=>{
  if(!$('radarOn').checked)return;
  clearTimeout(nordicRadarRefreshTimer);nordicRadarRefreshTimer=setTimeout(()=>{
    const time=frames[Number($('timeline').value)]?.time;if(time)drawNordicRadars(time).catch(console.error);
  },180);
});
