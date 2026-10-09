const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../js/radar-archive.js','utf8');
function harness(size=100){
 const tile=new Uint8Array(size).fill(19);tile.set([137,80,78,71,13,10,26,10]);
 const index=new TextEncoder().encode(JSON.stringify({tiles:{'3/4/3':[0,size]},payloadBytes:size}));
 const bytes=new Uint8Array(12+index.length+size);bytes.set(new TextEncoder().encode('NWRAD001'));new DataView(bytes.buffer).setUint32(8,index.length,true);bytes.set(index,12);bytes.set(tile,12+index.length);
 const record={path:'data/radar-tiles/fi-1000-0123456789ab',tiles:{3:['4/3']},archive:{version:1,path:'data/radar-tiles/fi-1000-0123456789ab.bin',bytes:bytes.length,index_bytes:12+index.length}};
 const calls=[];const c={Map,Set,Uint8Array,DataView,TextDecoder,Date,Number,Object,Array,String,Math,AbortController,setTimeout,clearTimeout,Blob,record,navigator:{connection:{downlink:10}},radarLightMode:()=>true,
 fetch:async(url,options)=>{calls.push(options.headers?.Range||'whole');const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/);const body=range?bytes.slice(+range[1],+range[2]+1):bytes;return {ok:true,status:range?206:200,arrayBuffer:async()=>body.buffer,headers:{get:()=>range?'bytes '+range[1]+'-'+range[2]+'/'+bytes.length:null}};}};
 vm.createContext(c);vm.runInContext(source,c);return {c,record,bytes,calls,tile,run:s=>vm.runInContext(s,c)};
}
test('small frames use one deduplicated whole download and return unchanged PNG bytes',async()=>{
 const h=harness();const tiles=await Promise.all([h.run('radarArchiveTileBytes(record,3,4,3)'),h.run('radarArchiveTileBytes(record,3,4,3)')]);
 assert.deepEqual(Buffer.from(tiles[0]),Buffer.from(h.tile));assert.equal(h.calls.length,1);assert.equal(h.calls[0],'whole');
});
test('large frames and slow connections use bounded range reads, cached after first read',async()=>{
 const h=harness(300000);await h.run('radarArchiveTileBytes(record,3,4,3)');assert.equal(h.calls.length,2);assert.match(h.calls[0],/bytes=0-16383/);await h.run('radarArchiveTileBytes(record,3,4,3)');assert.equal(h.calls.length,2);
 const s=harness(70000);s.c.navigator.connection.saveData=true;await s.run('openRadarArchive(record)');assert.match(s.calls[0],/^bytes=/);
});
test('servers ignoring Range can return a full frame without downloading it again',async()=>{
 const h=harness(300000);h.c.fetch=async()=>({ok:true,status:200,arrayBuffer:async()=>h.bytes.buffer});await h.run('radarArchiveTileBytes(record,3,4,3)');assert.equal(h.run('radarArchiveCache.size'),1);
});
test('unsafe paths, malformed indexes and truncated reads are rejected without cached success',async()=>{
 const h=harness();h.record.archive.path='https://bad.example/file';await assert.rejects(h.run('openRadarArchive(record)'),/descriptor/);
 const a=harness();a.bytes[0]=0;await assert.rejects(a.run('openRadarArchive(record)'),/header/);assert.equal(a.run('radarArchiveCache.size'),0);
 const b=harness();b.c.fetch=async()=>({ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(10)});await assert.rejects(b.run('openRadarArchive(record)'),/Incomplete/);
});
test('compressed mobile cache is bounded separately from decoded mosaic memory',async()=>{
 const h=harness();h.c.entry={whole:new Uint8Array(1024*1024),parts:new Map()};
 for(let i=0;i<10;i++)h.run('touchRadarArchive("frame'+i+'",entry)');assert(h.run('radarArchiveCache.size')<=4);
});
