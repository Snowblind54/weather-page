// Prepare the existing transparent satellite view once, using its shared pixel rules.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {available,archiveBytes,packRecords}=require('./cloud_archive.cjs');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
let sharp;try{sharp=require('./cloud-tiles/node_modules/sharp');}catch{sharp=require('sharp');}
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'data/cloud-tiles.json');
const DIR=path.join(ROOT,'data/cloud-tiles'),KEEP=3*3600,MAX_BYTES=600*1024*1024;
const STYLE=2;
const MAX_NEW=Math.max(1,Math.min(180,Number(process.env.CLOUD_TILE_MAX_NEW)||180));
function runtime(){
 const c=vm.createContext({console,URLSearchParams,URL,Date,Map,Set,Uint8ClampedArray,Float32Array,Promise,Math,document:{querySelector:()=>null}});
 // Millions of per-pixel Math calls should not traverse the VM's global proxy.
 // Bind the same built-ins lexically; the numerical rules remain identical.
 vm.runInContext('const Math=globalThis.Math;',c);
 for(const name of ['cloud-pixels.js','clouds.js','cloud-arctic-source.js','cloud-eumet-cleanup.js','cloud-nordic-coverage.js']){
  let code=fs.readFileSync(path.join(ROOT,'js',name),'utf8');
  if(name==='clouds.js')code=code.split('let cloudWorker=null')[0];
  vm.runInContext(code,c);
 }
 vm.runInContext('installArcticCloudSource();installEumetCleanClouds();installNordicCloudCoverage();',c);
 return c;
}
async function download(url){
 const u=new URL(url);
 if(u.protocol!=='https:'||!['view.eumetsat.int','gibs.earthdata.nasa.gov','nowcoast.noaa.gov'].includes(u.hostname))throw Error('Unapproved satellite host');
 // Do not follow redirects to unapproved hosts. WMS errors are rejected by image decoding.
 const {stdout}=await run('curl',['--fail','--silent','--show-error','--max-time','30',url],{encoding:'buffer',maxBuffer:64*1024*1024});
 return stdout;
}
async function metadata(c,previous,now){
 const products=vm.runInContext('cloudProducts',c),errors=[];
 for(const endpoint of [...new Set(['eumet','noaa','gibs','west','metop'].map(id=>products[id].endpoint))]){
  try{
   const xml=await download(endpoint+'?service=WMS&request=GetCapabilities&version=1.3.0&freshness='+Math.floor(now/120));
   const parser=`import sys,json,xml.etree.ElementTree as E\nt=E.fromstring(sys.stdin.read());out={}\nfor l in t.iter():\n if l.tag.split('}')[-1]!='Layer':continue\n name=next((n.text for n in l if n.tag.split('}')[-1]=='Name'),None)\n d=next((n for n in l if n.tag.split('}')[-1] in ['Dimension','Extent'] and n.get('name')=='time'),None)\n if name and d is not None:out[name]={'default':d.get('default'),'text':d.text or ''}\nprint(json.dumps(out))`;
   const child=require('node:child_process').spawn('python3',['-c',parser]);let text='',err='';
   child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>err+=b);
   const finished=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',n=>n?reject(Error(err)):resolve());});
   child.stdin.end(xml);await finished;const layers=JSON.parse(text);
   for(const [id,p] of Object.entries(products)){
    if(p.endpoint!==endpoint)continue;p.latest={};p.times={};
    for(const name of new Set([p.day,p.night])){
     const d=layers[name];if(!d)throw Error('Missing '+name);
     const latest=Date.parse(d.default)/1000;
     c.dimensionText=d.text;
     const times=p.polarComposite?[...(previous.products?.[id]?.times?.[name]||[]),latest]:vm.runInContext('cloudTimeEntries(dimensionText)',c);
     p.times[name]=[...new Set(times)].filter(t=>Number.isFinite(t)&&t>=now-24*3600).sort((a,b)=>a-b);
     p.latest[name]=Number.isFinite(latest)?latest:p.times[name].at(-1);
    }
   }
  }catch(e){errors.push(endpoint+': '+e.message);}
 }
 return {products,errors};
}
function coordinates(c){
 const rows=[];
 for(const z of [2,3,4])for(let y=0;y<2**z;y++)for(let x=0;x<2**z;x++){
  c.coords={z,x,y};
  if(vm.runInContext('cloudTileSources(coords).length',c))rows.push({z,x,y});
 }
 return rows;
}
function selectRecord(records,time){return records.filter(r=>r.time<=time).sort((a,b)=>b.time-a.time)[0];}
function retain(records,first){
 const latest=new Map();for(const r of records)if(!latest.has(r.key)||r.time>latest.get(r.key).time)latest.set(r.key,r);
 return records.filter(r=>{
  const last=latest.get(r.key);
  const delayed=r.times?.some(s=>s.id==='gibs'||s.id==='west');
  // Keep three hours of real GOES observations, rather than pruning the
  // two-hour playback history just because the upstream feed arrives late.
  const cutoff=delayed&&last.time>=first-KEEP?Math.min(first,last.time-KEEP):first;
  return r.time>=cutoff||r===last;
 });
}
function observations(sources){return sources.map(s=>({id:s.id,day:s.day?s.dayTime:null,night:s.night?s.nightTime:null}));}
function processingSize(coords){return coords.z===4?1024:512;}
function sourceFreshEnough(id,product,now){
 if(id!=='noaa')return true;
 const latest=Math.max(...Object.values(product?.latest||{}).filter(Number.isFinite));
 return Number.isFinite(latest)&&now-latest<=45*60;
}
function phasePlan(phase,previous,wallTime){
 if(!['all','latest','history'].includes(phase))throw Error('Unknown satellite phase: '+phase);
 const history=phase==='history';
 if(history&&(!Number.isFinite(previous.generated_at)||previous.metrics?.phase!=='latest'||!previous.products))throw Error('History requires a completed newest-frame snapshot');
 const now=history?previous.generated_at:wallTime;
 const times=Array.from({length:12},(_,i)=>Math.floor(now/600)*600-(i+1)*600);
 return {now,times:phase==='latest'?[now]:history?times:[now,...times],limit:history?Math.max(0,MAX_NEW-previous.metrics.prepared_blocks):MAX_NEW};
}
function historyTimes(ids,products,plan){
 const latest=ids.filter(id=>id!=='metop').map(id=>
   Math.max(...Object.values(products[id]?.latest||{}).filter(Number.isFinite))).filter(Number.isFinite);
 const end=latest.length?Math.min(plan.now,...latest):plan.now;
 // Match satellite-only browser playback and retain its actual two-hour history.
 return plan.times.map(time=>time-(Math.floor(plan.now/600)*600-Math.floor(end/600)*600));
}
async function main(phase='all'){
 const started=Date.now();fs.mkdirSync(DIR,{recursive:true});
 const previous=fs.existsSync(OUT)?JSON.parse(fs.readFileSync(OUT)):{};
 const plan=phasePlan(phase,previous,Math.floor(Date.now()/1000)),now=plan.now;
 const c=runtime();
 // Prepared z2-z4 overview blocks use a single continuous full-disk GOES
 // mosaic across North America. Close browser fallback may still use the fast
 // CONUS mosaic, but it must never split one large prepared Canada/US block.
 c.cloudPreparedFullDisk=true;
 // History uses the same source timestamps as the already published latest pass.
 const {products,errors}=phase==='history'?{products:previous.products,errors:[...(previous.errors||[])]}:await metadata(c,previous,now);
 Object.assign(vm.runInContext('cloudProducts',c),products);
 c.cloudImagePixels=async(url,size)=>new Uint8ClampedArray(await sharp(await download(url)).resize(size,size).ensureAlpha().raw().toBuffer());
 const old=(previous.records||[]).filter(r=>r.style===STYLE&&available(ROOT,r));
 const records=retain(old,now-KEEP),tasks=[];
 for(const coords of coordinates(c)){
  c.coords=coords;const ids=vm.runInContext('cloudTileSources(coords)',c);
  if(ids.some(id=>!products[id]?.latest?.[products[id].day]))continue;
  if(phase!=='history'){
   const stale=ids.find(id=>!sourceFreshEnough(id,products[id],now));
   if(stale){errors.push(`${coords.z}/${coords.x}/${coords.y}: ${stale} latest imagery is stale; retaining previous tile`);continue;}
  }
  // Newest real observation first; backfill the two-hour timeline gradually.
  for(const time of (phase==='history'?historyTimes(ids,products,plan):plan.times)){
   c.requested=time;let identity;
   try{identity=vm.runInContext("cloudTileSources(coords).map(id=>{const p=cloudProducts[id];return id+':'+cloudAvailableTime(p,p.day,requested)+':'+cloudAvailableTime(p,p.night,requested)}).join('|')",c);}catch{continue;}
   if(identity.includes('unavailable'))continue;
   const key=`${coords.z}/${coords.x}/${coords.y}`;
   if(records.some(r=>r.key===key&&r.identity===identity)||tasks.some(r=>r.key===key&&r.identity===identity))continue;
   tasks.push({coords,time,key,identity});
  }
 }
 tasks.sort((a,b)=>b.time-a.time);
 let cursor=0,prepared=0,bytes=archiveBytes(records);
 async function worker(){
  while(cursor<tasks.length&&cursor<plan.limit&&Date.now()-started<12*60000){
   const t=tasks[cursor++];const local=runtime();
   local.cloudPreparedFullDisk=true;
   Object.assign(vm.runInContext('cloudProducts',local),products);
   local.cloudImagePixels=c.cloudImagePixels;local.coords=t.coords;local.requested=t.time;
   const size=processingSize(t.coords);
   vm.runInContext(`cloudTileResolution=()=>${size};`,local);
   try{
    const ids=vm.runInContext('cloudTileSources(coords)',local);
    const settled=await Promise.allSettled(ids.map(id=>{local.sourceId=id;return vm.runInContext('cloudLoadSource(sourceId,coords,requested)',local);}));
    const sources=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
    const failedIds=settled.flatMap((r,i)=>r.status==='rejected'?[ids[i]]:[]);
    if(!sources.length)throw Error('All satellite sources failed: '+failedIds.join(','));
    if(failedIds.length){
      // One intermittent provider must not erase a whole 22.5-degree block.
      // Renormalize the surviving overlapping satellites for this block only.
      local.availableCloudSourceIds=new Set(sources.map(s=>s.id));
      vm.runInContext(`
        const cloudWeightsBeforePreparedFallback=cloudSourceWeights;
        cloudSourceWeights=(lat,lon)=>{
          const weights=cloudWeightsBeforePreparedFallback(lat,lon);let total=0;
          for(const id of Object.keys(weights)){
            if(!availableCloudSourceIds.has(id))weights[id]=0;
            total+=weights[id]||0;
          }
          if(total>0)for(const id of Object.keys(weights))weights[id]=(weights[id]||0)/total;
          return weights;
        };
      `,local);
      errors.push(t.key+': recovered without '+failedIds.join(','));
    }
    // Keep the smoothing neighbourhood tied to native browser pixels. z2/z3
    // process at 512px internally and are then downsampled to 256px, removing
    // coarse rectangular seams without increasing client download size.
    sources.forEach(s=>{s.blockScale=size/256;});local.sources=sources;
    const pixels=vm.runInContext(`cloudProcessPixels(coords,sources,${size})`,local);
    const digest=require('node:crypto').createHash('sha256').update(t.identity).update(pixels).digest('hex').slice(0,16);
    const names=[],buffers=[];
    for(const resolution of (t.coords.z===4?[256,512,1024]:[256])){
     const name=`data/cloud-tiles/${digest}-${resolution}.webp`;
     buffers.push(await sharp(Buffer.from(pixels),{raw:{width:size,height:size,channels:4}}).resize(resolution,resolution).webp({quality:92,alphaQuality:100}).toBuffer());names.push(name);
    }
    const amount=buffers.reduce((n,b)=>n+b.length,0);
    if(bytes+amount>MAX_BYTES)throw Error('Satellite archive budget reached');
    // No manifest references an incomplete block.
    names.forEach((n,i)=>{const file=path.join(ROOT,n);fs.writeFileSync(file+'.tmp',buffers[i]);fs.renameSync(file+'.tmp',file);});
    const times=observations(sources);const actual=Math.max(...times.flatMap(s=>[s.day,s.night].filter(Number.isFinite)));
    records.push({...t,coords:undefined,time:actual,paths:names,times,bytes:amount,style:STYLE});bytes+=amount;prepared++;
    console.log('Prepared satellite block',t.key,new Date(actual*1000).toISOString(),amount);
   }catch(e){const message=t.key+': '+e.message;errors.push(message);console.warn('Satellite block failed',message);}
  }
 }
 await Promise.all(Array.from({length:3},worker));
 const kept=retain(records,now-KEEP);
 if(!kept.length)throw Error('No successful satellite tiles; published data unchanged: '+errors.slice(0,5).join('; '));
 const uploadedArchives=packRecords(ROOT,DIR,kept);
 const activeBytes=archiveBytes(kept);if(activeBytes>MAX_BYTES)throw Error('Satellite archive budget reached');
 const result={version:1,generated_at:now,records:kept,products,errors:errors.slice(-100),metrics:{phase,prepared_blocks:prepared,archive_bytes:activeBytes,uploaded_archives:uploadedArchives,processing_seconds:Math.round((Date.now()-started)/1000)},retention_seconds:KEEP};
 fs.writeFileSync(OUT+'.tmp',JSON.stringify(result));fs.renameSync(OUT+'.tmp',OUT);
 const protectedPaths=new Set(kept.flatMap(r=>r.archive?[r.archive.path]:r.paths).map(p=>path.basename(p)));
 for(const name of fs.readdirSync(DIR))if(!protectedPaths.has(name))fs.unlinkSync(path.join(DIR,name));
 console.log(JSON.stringify(result.metrics));
}
module.exports={runtime,coordinates,retain,selectRecord,processingSize,sourceFreshEnough,phasePlan,historyTimes};
if(require.main===module)main(process.argv[2]?.replace(/^--/,'')||'all').catch(e=>{console.error(e.message);process.exitCode=1;});
