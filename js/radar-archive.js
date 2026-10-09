// Immutable indexed PNG archives. Whole downloads for small frames; byte ranges
// for larger frames/slow connections. Decode only the currently visible tiles.
const radarArchiveCache=new Map(),radarArchiveReaders=new Map();
function validRadarArchive(record){
  const a=record.archive;
  return a?.version===1&&a.path===record.path+'.bin'&&
    /^data\/radar-tiles\/(ee|fi|se|no|dk|iskef|isska|isx2|lt|lv)-\d+-[a-f0-9]{12}\.bin$/.test(a.path)&&
    Number.isSafeInteger(a.bytes)&&a.bytes>=12&&a.bytes<=8*1024*1024&&
    Number.isSafeInteger(a.index_bytes)&&a.index_bytes>=12&&a.index_bytes<=65548&&a.index_bytes<=a.bytes;
}
function trimRadarArchives(){
  const limit=(typeof radarLightMode==='function'&&radarLightMode()?4:12)*1024*1024;
  const bytes=entry=>(entry.whole?.byteLength||entry.prefix?.byteLength||0)+[...entry.parts.values()].reduce((n,b)=>n+b.byteLength,0);
  let size=[...radarArchiveCache.values()].reduce((n,e)=>n+bytes(e),0);
  while(radarArchiveCache.size>40||size>limit){const key=radarArchiveCache.keys().next().value,e=radarArchiveCache.get(key);size-=bytes(e);radarArchiveCache.delete(key);}
}
function touchRadarArchive(path,entry){radarArchiveCache.delete(path);radarArchiveCache.set(path,entry);trimRadarArchives();}
function wholeRadarArchivePreferred(record){
  const connection=typeof navigator==='undefined'?null:navigator.connection;
  const slow=connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType)||connection?.downlink<1.5;
  return record.archive.bytes<=(slow?64:256)*1024;
}
async function fetchRadarArchiveBytes(record,start,end){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const options={signal:controller.signal};
    if(start!==undefined)options.headers={Range:'bytes='+start+'-'+end};
    const response=await fetch(record.archive.path,options);
    if(!response.ok||![200,206].includes(response.status))throw new Error('Radar archive HTTP '+response.status);
    const data=new Uint8Array(await response.arrayBuffer());
    if(response.status===200){if(data.byteLength!==record.archive.bytes)throw new Error('Incomplete radar archive');return {whole:data};}
    const expected=end-start+1;
    if(start===undefined||data.byteLength!==expected)throw new Error('Incomplete radar archive range');
    const contentRange=response.headers?.get('Content-Range');
    if(contentRange&&contentRange!=='bytes '+start+'-'+end+'/'+record.archive.bytes)throw new Error('Unexpected radar archive range');
    return {data};
  }finally{clearTimeout(timer);}
}
function parseRadarArchiveIndex(record,prefix){
  if(prefix.byteLength<record.archive.index_bytes||String.fromCharCode(...prefix.slice(0,8))!=='NWRAD001')throw new Error('Invalid radar archive header');
  const length=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength).getUint32(8,true);
  if(length+12!==record.archive.index_bytes)throw new Error('Invalid radar archive index length');
  const index=JSON.parse(new TextDecoder().decode(prefix.slice(12,12+length)));
  if(index.payloadBytes!==record.archive.bytes-record.archive.index_bytes||!index.tiles||typeof index.tiles!=='object')throw new Error('Invalid radar archive payload');
  const expected=Object.entries(record.tiles).flatMap(([z,rows])=>rows.map(xy=>z+'/'+xy));
  if(Object.keys(index.tiles).length!==expected.length)throw new Error('Incomplete radar archive index');
  for(const key of expected){const row=index.tiles[key];if(!Array.isArray(row)||row.length!==2||!row.every(Number.isSafeInteger)||row[0]<0||row[1]<8||row[0]+row[1]>index.payloadBytes)throw new Error('Invalid radar tile offset');}
  return index.tiles;
}
async function openRadarArchive(record){
  const path=record.archive.path,cached=radarArchiveCache.get(path);
  if(cached){touchRadarArchive(path,cached);return cached;}
  if(radarArchiveReaders.has(path))return radarArchiveReaders.get(path);
  const promise=(async()=>{
    if(!validRadarArchive(record))throw new Error('Invalid radar archive descriptor');
    let response=wholeRadarArchivePreferred(record)?await fetchRadarArchiveBytes(record):await fetchRadarArchiveBytes(record,0,Math.min(record.archive.bytes,Math.max(16384,record.archive.index_bytes))-1);
    const entry={whole:response.whole,prefix:response.data,parts:new Map(),pending:new Map()};
    entry.index=parseRadarArchiveIndex(record,entry.whole||entry.prefix);
    touchRadarArchive(path,entry);return entry;
  })().finally(()=>radarArchiveReaders.delete(path));
  radarArchiveReaders.set(path,promise);return promise;
}
async function radarArchiveTileBytes(record,z,x,y){
  const entry=await openRadarArchive(record),key=z+'/'+x+'/'+y,row=entry.index[key];
  if(!row)throw new Error('Unpublished radar tile');
  const start=record.archive.index_bytes+row[0],end=start+row[1];
  if(entry.whole)return entry.whole.slice(start,end);
  if(end<=entry.prefix.byteLength)return entry.prefix.slice(start,end);
  if(entry.parts.has(key))return entry.parts.get(key);
  if(entry.pending.has(key))return entry.pending.get(key);
  const promise=fetchRadarArchiveBytes(record,start,end-1).then(result=>{
    if(result.whole){entry.whole=result.whole;entry.prefix=null;entry.parts.clear();return entry.whole.slice(start,end);}
    entry.parts.set(key,result.data);return result.data;
  }).finally(()=>{entry.pending.delete(key);touchRadarArchive(record.archive.path,entry);});
  entry.pending.set(key,promise);return promise;
}
async function decodeRadarArchiveTile(record,tile,z,allowed){
  const bytes=await radarArchiveTileBytes(record,z,tile.x,tile.y);
  if(!allowed())throw new Error('Obsolete radar buffering');
  const blob=new Blob([bytes],{type:'image/png'});
  const image=typeof createImageBitmap==='function'?await createImageBitmap(blob):await new Promise((resolve,reject)=>{
    const image=new Image(),url=URL.createObjectURL(blob);
    image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
    image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Invalid archive PNG'));};image.src=url;
  });
  if(image.width!==256||image.height!==256||!allowed()){image.close?.();throw new Error('Invalid or obsolete archive tile');}
  return image;
}
