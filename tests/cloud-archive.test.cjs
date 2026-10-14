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

function multiBrowser(){
 const tiles={},paths=[],originals=[];let offset=0;
 for(let i=0;i<8;i++){const key=(i+1).toString(16).padStart(16,'0')+'-256.webp',bytes=Buffer.alloc(45000,i+10);bytes.write('RIFF');bytes.write('WEBP',8);tiles[key]=[offset,bytes.length];offset+=bytes.length;paths.push('data/cloud-tiles/'+key);originals.push(bytes);}
 const index=Buffer.from(JSON.stringify({payloadBytes:offset,tiles})),header=Buffer.alloc(12);header.write('NWCLOUD1');header.writeUInt32LE(index.length,8);const body=Buffer.concat([header,index,...originals]);
 const record={paths,archive:{version:1,path:'data/cloud-tiles/pack-aaaaaaaaaaaaaaaa.bin',bytes:body.length,index_bytes:12+index.length}},calls=[];
 const c={Map,Set,Uint8Array,DataView,TextDecoder,Blob,Date,Number,Object,Array,String,Math,AbortController,setTimeout,clearTimeout,record,paths,cloudControllers:new Set(),navigator:{connection:{downlink:10}},matchMedia:()=>({matches:true}),fetch:async(url,options)=>{
  const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/);calls.push(range?[+range[1],+range[2]]:null);const b=range?body.subarray(+range[1],+range[2]+1):body;
  return {ok:true,status:range?206:200,arrayBuffer:async()=>Uint8Array.from(b).buffer,headers:{get:()=>range?'bytes '+range[1]+'-'+range[2]+'/'+body.length:null}};
 }};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/cloud-archive.js','utf8'),c);
 return {c,body,calls,originals,run:s=>vm.runInContext(s,c)};
}
test('nearby visible cloud blocks share ranges and retain their exact original bytes',async()=>{
 const h=multiBrowser();const result=await h.run('Promise.all(paths.slice(0,4).map(p=>cloudArchiveBlob(record,p)))');
 assert.equal(h.calls.length,2,'one index request plus one batch replaces four block requests');
 for(let i=0;i<4;i++)assert.deepEqual(Buffer.from(await result[i].arrayBuffer()),h.originals[i]);
 await h.run('Promise.all(paths.slice(0,4).map(p=>cloudArchiveBlob(record,p)))');assert.equal(h.calls.length,2);
 assert.equal(h.c.cloudControllers.size,0);assert.equal(h.run('cloudArchiveCache.get(record.archive.path).pending.size'),0);
});
test('batching respects phone and slow-connection byte limits without downloading distant blocks',async()=>{
 const h=multiBrowser();await h.run('Promise.all(paths.map(p=>cloudArchiveBlob(record,p)))');
 assert.equal(h.calls.length,3);assert(h.calls.slice(1).every(([a,b])=>b-a+1<=256*1024));
 const slow=multiBrowser();slow.c.navigator.connection.downlink=.5;await slow.run('Promise.all(paths.map(p=>cloudArchiveBlob(record,p)))');assert.equal(slow.calls.length,9);assert(slow.calls.slice(1).every(([a,b])=>b-a+1<=64*1024));
 const separated=multiBrowser();await separated.run('Promise.all([paths[0],paths[7]].map(p=>cloudArchiveBlob(record,p)))');assert.equal(separated.calls.length,3);
});
test('failed batches reject all waiting blocks, release pending requests, and can retry',async()=>{
 const h=multiBrowser(),fetch=h.c.fetch;let failed=true;h.c.fetch=async(url,options)=>{const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/);if(failed&&range&&+range[1]>0)throw Error('offline');return fetch(url,options);};
 const result=await h.run('Promise.allSettled(paths.slice(0,4).map(p=>cloudArchiveBlob(record,p)))');assert(result.every(r=>r.status==='rejected'));
 assert.equal(h.run('cloudArchiveCache.get(record.archive.path).pending.size'),0);failed=false;
 const blobs=await h.run('Promise.all(paths.slice(0,4).map(p=>cloudArchiveBlob(record,p)))');assert.equal(blobs.length,4);assert.equal(h.c.cloudControllers.size,0);
});
test('late requests contained in a running batch share its bytes',async()=>{
 const h=multiBrowser(),fetch=h.c.fetch;let resolveStarted,finish;const started=new Promise(r=>resolveStarted=r),gate=new Promise(r=>finish=r);
 h.c.fetch=async(url,options)=>{const range=options.headers?.Range?.match(/bytes=(\d+)-(\d+)/);if(range&&+range[1]>0){resolveStarted();await gate;}return fetch(url,options);};
 // Artificial small intervening block falls within the bounded merged gap.
 const entry=await h.run('openCloudArchive(record)');const key=h.c.paths[2].split('/').at(-1);entry.index[key]=[45000+100,10];
 const first=h.run('Promise.all([paths[0],paths[1]].map(p=>cloudArchiveBlob(record,p)))');await started;
 const late=h.run('cloudArchiveBlob(record,paths[2])');finish();await first;const blob=await late;
 assert.equal(h.calls.length,2);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),h.body.subarray(h.c.record.archive.index_bytes+45100,h.c.record.archive.index_bytes+45110));
});

test('new archives group same-resolution neighboring blocks without changing image bytes',()=>{
 const f=fixture(),records=[];
 try{
  for(const [x,digest] of [[9,'0000000000000001'],[8,'ffffffffffffffff']]){
   const paths=[];
   for(const resolution of [256,512,1024]){const name=`data/cloud-tiles/${digest}-${resolution}.webp`;fs.writeFileSync(path.join(f.root,name),f.bytes);paths.push(name);}
   records.push({key:`4/${x}/4`,time:100,paths,bytes:f.bytes.length*3});
  }
  packRecords(f.root,f.dir,records);
  const body=fs.readFileSync(path.join(f.root,records[0].archive.path)),index=JSON.parse(body.subarray(12,records[0].archive.index_bytes));
  const keys=Object.keys(index.tiles);
  assert.deepEqual(keys.map(k=>Number(k.match(/-(\d+)\.webp$/)[1])),[256,256,512,512,1024,1024]);
  assert.ok(keys[0].startsWith('ffffffffffffffff'),'geographic order instead of random digest order');
  for(const key of keys){const [at,len]=index.tiles[key];assert.ok(body.subarray(records[0].archive.index_bytes+at,records[0].archive.index_bytes+at+len).equals(f.bytes));}
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
