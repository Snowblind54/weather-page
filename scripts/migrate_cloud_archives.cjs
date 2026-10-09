// First publication packs existing verified imagery without waiting for providers.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {available,archiveBytes,packRecords}=require('./cloud_archive.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'data/cloud-tiles.json'),dir=path.join(root,'data/cloud-tiles');
if(!fs.existsSync(out)){execFileSync(process.execPath,[path.join(__dirname,'update_cloud_tiles.cjs')],{stdio:'inherit'});}
else{
 const data=JSON.parse(fs.readFileSync(out));
 if(data.version!==1||!Array.isArray(data.records)||!data.records.length||!data.records.every(r=>available(root,r)))throw Error('Incomplete restored cloud snapshot; migration withheld');
 const archives=packRecords(root,dir,data.records),bytes=archiveBytes(data.records);
 if(bytes>600*1024*1024)throw Error('Cloud storage budget exceeded');
 data.generated_at=Math.floor(Date.now()/1000);
 data.metrics={...data.metrics,prepared_blocks:0,archive_bytes:bytes,uploaded_archives:archives};
 fs.writeFileSync(out+'.tmp',JSON.stringify(data));fs.renameSync(out+'.tmp',out);
 const protectedFiles=new Set(data.records.map(r=>path.basename(r.archive.path)));
 for(const name of fs.readdirSync(dir))if(!protectedFiles.has(name))fs.unlinkSync(path.join(dir,name));
 console.log(JSON.stringify({records:data.records.length,archives,bytes,sourceTimesPreserved:true}));
}
