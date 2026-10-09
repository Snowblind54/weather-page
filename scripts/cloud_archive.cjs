// Pack exact existing WebP bytes; immutable regional/time batches, max 4 MiB.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAGIC=Buffer.from('NWCLOUD1'),MAX_PAYLOAD=4*1024*1024,MAX_INDEX=65536;
function available(root,r){return r.archive?(/^data\/cloud-tiles\/pack-[a-f0-9]{16}\.bin$/.test(r.archive.path)&&fs.existsSync(path.join(root,r.archive.path))):r.paths.every(p=>fs.existsSync(path.join(root,p)));}
function archiveBytes(records){const archives=new Map();let raw=0;for(const r of records){if(r.archive)archives.set(r.archive.path,r.archive.bytes);else raw+=r.bytes;}return raw+[...archives.values()].reduce((a,b)=>a+b,0);}
function packRecords(root,directory,records){
 const groups=new Map();
 for(const r of records.filter(r=>!r.archive)){
  const [z,x,y]=r.key.split('/').map(Number),region=Math.floor(x/2**z*4)+'/'+Math.floor(y/2**z*4);
  const key=Math.floor(r.time/600)+'/'+region;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
 }
 let written=0;
 function flush(batch){
  const files=new Map();for(const r of batch)for(const p of r.paths)files.set(p,fs.readFileSync(path.join(root,p)));
  const entries={},buffers=[];let offset=0;const hash=crypto.createHash('sha256');
  for(const [p,b] of [...files].sort(([a],[b])=>a.localeCompare(b))){
   if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP')throw Error('Invalid cloud WebP');
   const key=path.basename(p);entries[key]=[offset,b.length];offset+=b.length;buffers.push(b);hash.update(key).update(b);
  }
  const index=Buffer.from(JSON.stringify({tiles:entries,payloadBytes:offset}));
  if(index.length>MAX_INDEX||offset>MAX_PAYLOAD)throw Error('Cloud archive exceeds safety budget');
  const head=Buffer.alloc(12);MAGIC.copy(head);head.writeUInt32LE(index.length,8);
  const body=Buffer.concat([head,index,...buffers]),name='pack-'+hash.digest('hex').slice(0,16)+'.bin',target=path.join(directory,name);
  // Packing never re-encodes pixels; verify byte-exact entries before publication.
  for(const [p,b] of files){const [at,len]=entries[path.basename(p)];if(!body.subarray(12+index.length+at,12+index.length+at+len).equals(b))throw Error('Cloud archive byte mismatch');}
  if(!fs.existsSync(target)){fs.writeFileSync(target+'.tmp',body);fs.renameSync(target+'.tmp',target);written++;}
  for(const r of batch)r.archive={version:1,path:'data/cloud-tiles/'+name,bytes:body.length,index_bytes:12+index.length};
 }
 for(const rows of groups.values()){
  let batch=[],size=0;
  for(const r of rows){if(batch.length&&size+r.bytes>MAX_PAYLOAD){flush(batch);batch=[];size=0;}batch.push(r);size+=r.bytes;}if(batch.length)flush(batch);
 }
 return written;
}
module.exports={available,archiveBytes,packRecords};
