// Immutable indexed WebP archives. Whole downloads for small frames; byte ranges
// for larger frames/slow connections. Decode only the currently visible tiles.
const cloudArchiveCache=new Map(),cloudArchiveReaders=new Map();
function validCloudArchive(record){
  const a=record.archive;
  return a?.version===1&&/^data\/cloud-tiles\/pack-[a-f0-9]{16}\.bin$/.test(a.path)&&
    Number.isSafeInteger(a.bytes)&&a.bytes>=12&&a.bytes<=5*1024*1024&&
    Number.isSafeInteger(a.index_bytes)&&a.index_bytes>=12&&a.index_bytes<=65548&&a.index_bytes<=a.bytes;
}
function cloudArchiveMobile(){return typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches;}
function trimCloudArchives(){
  const limit=(typeof cloudArchiveMobile==='function'&&cloudArchiveMobile()?4:12)*1024*1024;
  const bytes=entry=>(entry.whole?.byteLength||entry.prefix?.byteLength||0)+[...entry.parts.values()].reduce((n,b)=>n+b.byteLength,0);
  let size=[...cloudArchiveCache.values()].reduce((n,e)=>n+bytes(e),0);
  while(cloudArchiveCache.size>40||size>limit){const key=cloudArchiveCache.keys().next().value,e=cloudArchiveCache.get(key);size-=bytes(e);cloudArchiveCache.delete(key);}
}
function touchCloudArchive(path,entry){cloudArchiveCache.delete(path);cloudArchiveCache.set(path,entry);trimCloudArchives();}
function wholeCloudArchivePreferred(record){
  const connection=typeof navigator==='undefined'?null:navigator.connection;
  const slow=connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType)||connection?.downlink<1.5;
  return record.archive.bytes<=(slow?64:256)*1024;
}
async function fetchCloudArchiveBytes(record,start,end){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  if(typeof cloudControllers!=='undefined')cloudControllers.add(controller);
  try{
    const options={signal:controller.signal};
    if(start!==undefined)options.headers={Range:'bytes='+start+'-'+end};
    const response=await fetch(record.archive.path,options);
    if(!response.ok||![200,206].includes(response.status))throw new Error('Cloud archive HTTP '+response.status);
    const data=new Uint8Array(await response.arrayBuffer());
    if(response.status===200){if(data.byteLength!==record.archive.bytes)throw new Error('Incomplete cloud archive');return {whole:data};}
    const expected=end-start+1;
    if(start===undefined||data.byteLength!==expected)throw new Error('Incomplete cloud archive range');
    const contentRange=response.headers?.get('Content-Range');
    if(contentRange&&contentRange!=='bytes '+start+'-'+end+'/'+record.archive.bytes)throw new Error('Unexpected cloud archive range');
    return {data};
  }finally{clearTimeout(timer);if(typeof cloudControllers!=='undefined')cloudControllers.delete(controller);}
}
function parseCloudArchiveIndex(record,prefix){
  if(prefix.byteLength<record.archive.index_bytes||String.fromCharCode(...prefix.slice(0,8))!=='NWCLOUD1')throw new Error('Invalid cloud archive header');
  const length=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength).getUint32(8,true);
  if(length+12!==record.archive.index_bytes)throw new Error('Invalid cloud archive index length');
  const index=JSON.parse(new TextDecoder().decode(prefix.slice(12,12+length)));
  if(index.payloadBytes!==record.archive.bytes-record.archive.index_bytes||!index.tiles||typeof index.tiles!=='object')throw new Error('Invalid cloud archive payload');
  const expected=Object.keys(index.tiles);
  if(expected.length>4096||!record.paths.every(p=>expected.includes(p.split('/').at(-1))))throw new Error('Incomplete cloud archive index');

  for(const key of expected){if(!/^[a-f0-9]{16}-(256|512|1024)\.webp$/.test(key))throw new Error('Invalid cloud block key');const row=index.tiles[key];if(!Array.isArray(row)||row.length!==2||!row.every(Number.isSafeInteger)||row[0]<0||row[1]<8||row[0]+row[1]>index.payloadBytes)throw new Error('Invalid cloud block offset');}
  return index.tiles;
}
async function openCloudArchive(record){
  const path=record.archive.path,cached=cloudArchiveCache.get(path);
  if(cached){touchCloudArchive(path,cached);return cached;}
  if(cloudArchiveReaders.has(path))return cloudArchiveReaders.get(path);
  const promise=(async()=>{
    if(!validCloudArchive(record))throw new Error('Invalid cloud archive descriptor');
    let response=wholeCloudArchivePreferred(record)?await fetchCloudArchiveBytes(record):await fetchCloudArchiveBytes(record,0,Math.min(record.archive.bytes,Math.max(16384,record.archive.index_bytes))-1);
    const entry={whole:response.whole,prefix:response.data,parts:new Map(),pending:new Map(),queued:new Map(),active:new Set(),flushTimer:null};
    entry.index=parseCloudArchiveIndex(record,entry.whole||entry.prefix);
    touchCloudArchive(path,entry);return entry;
  })().finally(()=>cloudArchiveReaders.delete(path));
  cloudArchiveReaders.set(path,promise);return promise;
}
function cloudArchiveBatchGroups(jobs){
  const connection=typeof navigator==='undefined'?null:navigator.connection;
  const slow=connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType)||connection?.downlink<1.5;
  const limit=(slow?64:cloudArchiveMobile()?256:512)*1024,groups=[];
  for(const job of [...jobs].sort((a,b)=>a.start-b.start)){
    let group=groups.at(-1);
    const gap=group?Math.max(0,job.start-group.end):0,bytes=group?(group.requested+job.end-job.start):0;
    if(!group||gap>4096||job.end-group.start>limit||group.extra+gap>Math.min(16384,bytes*.2)){
      group={start:job.start,end:job.end,requested:job.end-job.start,extra:0,jobs:[job]};groups.push(group);
    }else{group.end=Math.max(group.end,job.end);group.requested=bytes;group.extra+=gap;group.jobs.push(job);}
  }
  return groups;
}
function cacheCloudArchivePart(entry,key,start,end,result,rangeStart){
  if(result.whole){entry.whole=result.whole;entry.prefix=null;entry.parts.clear();}
  const bytes=entry.whole?entry.whole.slice(start,end):result.data.slice(start-rangeStart,end-rangeStart);
  if(!entry.whole)entry.parts.set(key,bytes);
  return bytes;
}
function flushCloudArchiveRequests(entry,record){
  entry.flushTimer=null;
  const groups=cloudArchiveBatchGroups(entry.queued.values());entry.queued.clear();
  for(const group of groups){
    // A server may have returned the entire archive for an earlier range.
    if(entry.whole){for(const job of group.jobs)job.resolve(entry.whole.slice(job.start,job.end));continue;}
    const batch={start:group.start,end:group.end,promise:fetchCloudArchiveBytes(record,group.start,group.end-1)};
    entry.active.add(batch);
    batch.promise.then(result=>{
      for(const job of group.jobs)job.resolve(cacheCloudArchivePart(entry,job.key,job.start,job.end,result,group.start));
    },error=>{for(const job of group.jobs)job.reject(error);}).finally(()=>{entry.active.delete(batch);touchCloudArchive(record.archive.path,entry);});
  }
}
async function cloudArchiveTileBytes(record,path){
  const entry=await openCloudArchive(record),key=path.split('/').at(-1),row=entry.index[key];
  if(!row)throw new Error('Unpublished cloud block');
  const start=record.archive.index_bytes+row[0],end=start+row[1];
  if(entry.whole)return entry.whole.slice(start,end);
  if(end<=entry.prefix.byteLength)return entry.prefix.slice(start,end);
  if(entry.parts.has(key))return entry.parts.get(key);
  if(entry.pending.has(key))return entry.pending.get(key);
  const batch=[...entry.active].find(b=>start>=b.start&&end<=b.end);
  const task=batch?batch.promise.then(result=>cacheCloudArchivePart(entry,key,start,end,result,batch.start)):new Promise((resolve,reject)=>{
    entry.queued.set(key,{key,start,end,resolve,reject});
    if(entry.flushTimer===null)entry.flushTimer=setTimeout(()=>flushCloudArchiveRequests(entry,record),8);
  });
  const promise=task.finally(()=>{entry.pending.delete(key);touchCloudArchive(record.archive.path,entry);});
  entry.pending.set(key,promise);return promise;
}
async function cloudArchiveBlob(record,path){
  if(!record.paths.includes(path))throw new Error('Unpublished cloud block');
  return new Blob([await cloudArchiveTileBytes(record,path)],{type:'image/webp'});
}
