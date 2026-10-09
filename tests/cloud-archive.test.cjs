const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {packRecords,available,archiveBytes}=require('../scripts/cloud_archive.cjs');
function fixture(size=100){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-archive-')),dir=path.join(root,'data/cloud-tiles');fs.mkdirSync(dir,{recursive:true});
 const file='data/cloud-tiles/0123456789abcdef-256.webp',bytes=Buffer.alloc(size,19);bytes.write('RIFF');bytes.write('WEBP',8);fs.writeFileSync(path.join(root,file),bytes);
 const record={key:'4/8/4',time:100,paths:[file],bytes:size};return {root,dir,file,bytes,record};
}
test('packing verifies exact WebP bytes, shares a regional/time archive, and does not repack old frames',()=>{
 const f=fixture(),r2={...f.record,key:'4/9/4',paths:[...f.record.paths]};
 try{assert.equal(packRecords(f.root,f.dir,[f.record,r2]),1);assert.deepEqual(f.record.archive,r2.archive);
 const body=fs.readFileSync(path.join(f.root,f.record.archive.path));assert.equal(body.toString('ascii',0,8),'NWCLOUD1');
 const index=JSON.parse(body.subarray(12,12+body.readUInt32LE(8)));const [at,len]=index.tiles[path.basename(f.file)];assert(body.subarray(f.record.archive.index_bytes+at,f.record.archive.index_bytes+at+len).equals(f.bytes));
 assert.equal(archiveBytes([f.record,r2]),body.length);assert(available(f.root,f.record));assert.equal(packRecords(f.root,f.dir,[f.record,r2]),0);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('archive payloads split at the four MiB limit',()=>{
 const f=fixture(3*1024*1024);const p2='data/cloud-tiles/fedcba9876543210-256.webp';fs.writeFileSync(path.join(f.root,p2),f.bytes);
 try{const r2={...f.record,paths:[p2]};assert.equal(packRecords(f.root,f.dir,[f.record,r2]),2);assert.notEqual(f.record.archive.path,r2.archive.path);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
function browser(size=100){
 const f=fixture(size);packRecords(f.root,f.dir,[f.record]);const body=fs.readFileSync(path.join(f.root,f.record.archive.path));fs.rmSync(f.root,{recursive:true,force:true});let calls=0;
 const c={Map,Set,Uint8Array,DataView,TextDecoder,Blob,Date,Number,Object,Array,String,Math,AbortController,setTimeout,clearTimeout,record:f.record,file:f.file,cloudControllers:new Set(),navigator:{connection:{downlink:10}},matchMedia:()=>({matches:true}),fetch:async(url,options)=>{
 calls++;const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/),b=range?body.subarray(+range[1],+range[2]+1):body;
 return {ok:true,status:range?206:200,arrayBuffer:async()=>Uint8Array.from(b).buffer,headers:{get:()=>range?'bytes '+range[1]+'-'+range[2]+'/'+body.length:null}};
 }};vm.createContext(c);vm.runInContext(fs.readFileSync('js/cloud-archive.js','utf8'),c);return {c,body,calls:()=>calls,run:s=>vm.runInContext(s,c)};
}
test('small archives share a whole download and reproduce the original cloud block',async()=>{
 const h=browser();const [a,b]=await Promise.all([h.run('cloudArchiveBlob(record,file)'),h.run('cloudArchiveBlob(record,file)')]);assert.equal(a.type,'image/webp');assert.deepEqual(Buffer.from(await a.arrayBuffer()),Buffer.from(await b.arrayBuffer()));assert.equal(h.calls(),1);assert.equal(h.c.cloudControllers.size,0);
});
test('large archives use ranges and reuse downloaded block bytes',async()=>{
 const h=browser(300000);await h.run('cloudArchiveBlob(record,file)');assert.equal(h.calls(),2);await h.run('cloudArchiveBlob(record,file)');assert.equal(h.calls(),2);
});
test('invalid archive URLs, truncated reads and mismatched indexes fail safely',async()=>{
 const h=browser();h.c.record.archive.path='https://unapproved/file';await assert.rejects(h.run('openCloudArchive(record)'),/descriptor/);
 const a=browser();a.c.fetch=async()=>({ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(12)});await assert.rejects(a.run('openCloudArchive(record)'),/Incomplete/);assert.equal(a.run('cloudArchiveCache.size'),0);
 const b=browser();b.c.record.paths=['data/cloud-tiles/aaaaaaaaaaaaaaaa-256.webp'];await assert.rejects(b.run('openCloudArchive(record)'),/Incomplete/);
});
test('compressed mobile satellite cache stays within its independent four MiB budget',()=>{
 const h=browser();h.c.entry={whole:new Uint8Array(1024*1024),parts:new Map()};
 for(let i=0;i<10;i++)h.run('touchCloudArchive("frame'+i+'",entry)');assert(h.run('cloudArchiveCache.size')<=4);
});
test('ignored byte ranges retain one whole archive instead of downloading it repeatedly',async()=>{
 const h=browser(300000);let calls=0;h.c.fetch=async()=>{calls++;return {ok:true,status:200,arrayBuffer:async()=>Uint8Array.from(h.body).buffer};};
 await h.run('cloudArchiveBlob(record,file)');await h.run('cloudArchiveBlob(record,file)');assert.equal(calls,1);
});
