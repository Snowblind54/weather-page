const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const producer=require('../scripts/update_cloud_tiles.cjs');
test('Coverage includes Europe, Canada, Greenland and the full USA cloud envelope',()=>{
 const c=producer.runtime(),rows=producer.coordinates(c);
 assert.ok(rows.length<=105,'bounded central block count');
 for(const [lat,lon] of [[59,25],[65,-19],[52,-110],[70,-45],[24.6,-81.5],[34,-118],[40.7,-74],[21.3,-157.8]]){
  const z=4,x=Math.floor((lon+180)/360*16),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*16);
  assert.ok(rows.some(r=>r.z===z&&r.x===x&&r.y===y),`missing prepared coverage near ${lat},${lon}`);
 }
});
test('CONUS uses the fast mosaic while Canada, Alaska and Hawaii use full-disk GOES',()=>{
 const c=producer.runtime();
 const weights=(lat,lon)=>{c.lat=lat;c.lon=lon;return vm.runInContext('cloudSourceWeights(lat,lon)',c);};
 const conus={
  california:weights(39,-120),
  centralUs:weights(39,-101.5),
  newYork:weights(40.7,-74),
  florida:weights(24.6,-81.5)
 };
 for(const [name,w] of Object.entries(conus)){
  assert.ok(w.noaa>.95,`${name} should use the fresh NOAA CONUS GOES mosaic`);
 }
 const fullDisk={
  hawaii:weights(21.3,-157.8),
  anchorage:weights(61.2,-149.9),
  vancouver:weights(49.3,-123.1),
  calgary:weights(51.05,-114.1),
  winnipeg:weights(49.9,-97.1),
  toronto:weights(43.65,-79.38),
  montreal:weights(45.5,-73.6),
  stJohns:weights(47.56,-52.71),
  yellowknife:weights(62.45,-114.37)
 };
 for(const [name,w] of Object.entries(fullDisk)){
  assert.ok(w.noaa<.05,`${name} should not use the CONUS-limited nowCOAST mosaic`);
  assert.ok(w.gibs+w.west>.85,`${name} should use full-disk GOES imagery`);
 }
 const transition=weights(74,-107);
 assert.equal(transition.noaa,0,'central Canadian Arctic should stay off the CONUS mosaic');
 assert.ok(transition.metop>0,'central Canadian Arctic should blend with polar coverage');
 assert.ok(transition.gibs+transition.west>0,'full-disk GOES should remain in the Arctic handoff');
 const arctic=weights(80,-107);
 assert.equal(arctic.noaa,0);
 assert.ok(arctic.metop>.9,'far northern Canada should hand off to polar coverage');
});
test('Prepared producer accepts NOAA nowCOAST for CONUS plus full-disk GIBS and keeps source timestamps',()=>{
 const source=fs.readFileSync('scripts/update_cloud_tiles.cjs','utf8');
 const clouds=fs.readFileSync('js/clouds.js','utf8');
 assert.match(source,/nowcoast\.noaa\.gov/);
 assert.match(source,/gibs\.earthdata\.nasa\.gov/);
 assert.match(clouds,/goes_visible_imagery/);
 assert.match(clouds,/GOES-East_ABI_GeoColor/);
 assert.match(clouds,/GOES-West_ABI_GeoColor/);
 assert.match(source,/records:kept,products,errors:/);
});
test('Overview blocks process at higher resolution without increasing their delivered size',()=>{
 assert.equal(producer.processingSize({z:2}),512);
 assert.equal(producer.processingSize({z:3}),512);
 assert.equal(producer.processingSize({z:4}),1024);
 const source=fs.readFileSync('scripts/update_cloud_tiles.cjs','utf8');
 assert.match(source,/t\.coords\.z===4\?\[256,512,1024\]:\[256\]/);
});
test('A stale fast CONUS GOES feed is rejected without affecting full-disk sources',()=>{
 const now=10_000;
 assert.equal(producer.sourceFreshEnough('noaa',{latest:{day:now-600,night:now-300}},now),true);
 assert.equal(producer.sourceFreshEnough('noaa',{latest:{day:now-3600,night:now-3500}},now),false);
 assert.equal(producer.sourceFreshEnough('gibs',{latest:{day:0}},now),true);
});
test('Failed updates retain the last successful tile independently of other regions',()=>{
 const old={key:'4/8/4',time:10},newer={key:'4/8/4',time:100},polar={key:'4/1/0',time:5};
 assert.deepEqual(producer.retain([old,newer,polar],80),[newer,polar]);
 assert.equal(producer.selectRecord([old,newer],50),old);
 assert.equal(producer.selectRecord([newer],50),undefined,'never borrow a future observation');
});
function browser(failed=false,archived=false){
 const draws=[],calls=[],cache=new Map(),promises=new Map();
 const record={key:'4/8/4',time:100,paths:['data/cloud-tiles/abcdef-256.webp','data/cloud-tiles/abcdef-512.webp','data/cloud-tiles/abcdef-1024.webp'],times:[{id:'eumet',night:100,day:null}]};
 if(archived)record.archive={version:1,path:'data/cloud-tiles/pack-0123456789abcdef.bin'};
 const ctx={console,Date:{now:()=>130000},Map,Set,Promise,URL,AbortController,setTimeout,clearTimeout,frames:[{time:100}],cloudSession:1,cloudControllers:new Set(),cloudProducts:{},cloudRequestedTime:100,
  cloudEnsureMetadata:async()=>{},cloudGetTile:async()=>({processor:'native'}),cloudTileKey:()=> 'native',cloudVisibleTiles:()=>[],cloudTileResolution:()=>256,
  cloudTileCache:cache,cloudTilePromises:promises,CLOUD_TILE_CACHE_LIMIT:768,CLOUD_CACHE_BYTES:48*1024*1024,cloudCacheBytes:()=>cache.size*256*256*4,
  map:{on:()=>{}},$:()=>({addEventListener:()=>{},checked:true}),createImageBitmap:async()=>({width:1024,height:1024,close(){}}),
  document:{title:'Northern Weather Map v8.134',createElement:()=>({width:0,height:0,getContext:()=>({drawImage:(...a)=>draws.push(a)})})},
  validCloudArchive:()=>true,cloudArchiveBlob:async()=>{if(failed)throw Error('archive unavailable');calls.push('archive-block');return {};},
  fetch:async url=>{calls.push(url);return url.split('?')[0].endsWith('.json')?{ok:true,json:async()=>({version:1,records:[record]})}:{ok:!failed,blob:async()=>({})};}
 };
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('js/cloud-prepared.js','utf8'),ctx);return {ctx,calls,draws,cache,promises};
}
test('CDN images are cropped at zoom 6, reuse one download and preserve exact observation times',async()=>{
 const {ctx,calls,draws}=browser();await ctx.cloudEnsureMetadata();
 const a=await ctx.cloudGetTile({z:6,x:33,y:18},110);const b=await ctx.cloudGetTile({z:6,x:34,y:18},110);
 assert.equal(a.processor,'cdn');assert.equal(a.times[0].night,100);assert.equal(b.processor,'cdn');
 assert.equal(calls.filter(c=>c.endsWith('.webp')).length,1);
 assert.ok(draws.some(a=>a.length===9&&a[1]===256&&a[2]===512&&a[3]===256));
 const before=await ctx.cloudGetTile({z:6,x:33,y:18},90);assert.equal(before.processor,'native');
});
test('Latest uses the newest satellite block even when it is newer than the radar timeline time',async()=>{
 const {ctx}=browser();
 ctx.frames=[{time:80},{time:90}];
 await ctx.cloudEnsureMetadata();
 const latest=await ctx.cloudGetTile({z:6,x:33,y:18},90);
 assert.equal(latest.processor,'cdn');
 assert.equal(latest.times[0].night,100,'Latest should accept the newer satellite observation');
 ctx.frames=[{time:80},{time:90},{time:110}];
 const historical=await ctx.cloudGetTile({z:6,x:33,y:18},90);
 assert.equal(historical.processor,'native','historical positions must never borrow a future satellite observation');
});
test('A missing CDN tile falls back without a self-referencing pending promise',async()=>{
 const {ctx,promises}=browser(true);await ctx.cloudEnsureMetadata();
 const result=await ctx.cloudGetTile({z:6,x:33,y:18},110);assert.equal(result.processor,'native');assert.equal(promises.size,0);
});
test('Freshness checks share a minute URL and advance despite a long browser TTL',async()=>{
 const {ctx,calls}=browser();let now=120000;ctx.Date={now:()=>now};
 await ctx.cloudEnsureMetadata(true);await ctx.cloudEnsureMetadata(true);
 assert.equal(calls[0],calls[1]);now+=60000;await ctx.cloudEnsureMetadata();
 assert.notEqual(calls[1],calls[2]);assert.match(calls[2],/cloud-tiles\.json\?minute=3$/);
});

test('archived cloud blocks preserve crops and times, with native recovery on archive failure',async()=>{
 const {ctx,calls,draws}=browser(false,true);await ctx.cloudEnsureMetadata();
 const tile=await ctx.cloudGetTile({z:6,x:33,y:18},110);assert.equal(tile.processor,'cdn');assert.equal(tile.times[0].night,100);assert(calls.includes('archive-block'));assert(!calls.some(c=>c.endsWith('.webp')));
 assert(draws.some(a=>a.length===9&&a[1]===256&&a[2]===512&&a[3]===256));
 const bad=browser(true,true);await bad.ctx.cloudEnsureMetadata();assert.equal((await bad.ctx.cloudGetTile({z:6,x:33,y:18},110)).processor,'native');assert.equal(bad.promises.size,0);
});

test('Newest frames publish separately; history keeps source times and the shared block budget',()=>{
 const latest=producer.phasePlan('latest',{},12345);
 assert.deepEqual(latest.times,[12345]);
 const snapshot={generated_at:12345,products:{eumet:{}},metrics:{phase:'latest',prepared_blocks:80}};
 const history=producer.phasePlan('history',snapshot,14500);
 assert.equal(history.now,12345,'do not switch model timestamps during history processing');
 assert.equal(history.times.length,12);
 assert.equal(history.times[0],11400);
 assert(history.times.every(t=>t<latest.now));
 assert.equal(history.limit,latest.limit-80,'two passes share the original operation budget');
 assert.throws(()=>producer.phasePlan('history',{},14500),/completed newest-frame/);
 assert.equal(producer.phasePlan('history',{...snapshot,metrics:{phase:'latest',prepared_blocks:180}},14500).limit,0);
});
test('The workflow publishes latest archives first and prevents history from building a queue',()=>{
 const workflow=fs.readFileSync('.github/workflows/update-cloud-tiles.yml','utf8');
 const latest=workflow.indexOf('update_cloud_tiles.cjs --latest'),history=workflow.indexOf('update_cloud_tiles.cjs --history');
 const firstPublish=workflow.indexOf('bash scripts/publish_generated_data.sh',latest);
 const secondPublish=workflow.indexOf('bash scripts/publish_generated_data.sh',history);
 assert(latest<firstPublish&&firstPublish<history&&history<secondPublish);
 assert.match(workflow,/cron: '9,29,49 \* \* \* \*'/);
 assert.match(workflow,/cron: '19,39,59 \* \* \* \*'/);
 assert.match(workflow,/github\.event\.schedule == '19,39,59 \* \* \* \*'/);
});

test('Latest and historical views prefer prepared blocks while the provider is ahead',async()=>{
 const {ctx}=browser(false,true);
 ctx.cloudProducts.eumet={day:'visible',night:'ir',metadataAt:1,latest:{visible:120,ir:120},times:{visible:[100,120],ir:[100,120]}};
 ctx.cloudAvailableTime=(p,name,time)=>Math.max(...p.times[name].filter(t=>t<=time));
 await ctx.cloudEnsureMetadata();
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},110)).processor,'cdn','archive matches the selected historical observation');
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},130)).processor,'cdn','a newer provider scan must not start expensive direct processing');
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},90)).processor,'native','never use an archive from the future');
});
test('Automatic refresh checks prepared delivery without provider discovery when coverage is complete',async()=>{
 const {ctx}=browser(false,true);let discoveries=0;
 ctx.cloudEnsureMetadata=async force=>{if(force)discoveries++;};
 ctx.cloudVisibleTiles=()=>[{coords:{z:6,x:33,y:18}}];
 vm.runInContext(fs.readFileSync('js/cloud-prepared.js','utf8'),ctx);
 await ctx.cloudEnsureMetadata(true);
 assert.equal(discoveries,0);
 await ctx.cloudEnsureMetadata(false);
 assert.equal(discoveries,0,'ordinary archive loading does not add provider discovery calls');
});

test('A refreshed manifest advances prepared imagery and preserves the earlier history',async()=>{
 const {ctx}=browser(false,true);
 await ctx.cloudEnsureMetadata(true);
 const first=await ctx.cloudGetTile({z:6,x:33,y:18},130);
 const fetch=ctx.fetch;
 ctx.fetch=async url=>{
  const response=await fetch(url);
  if(url.includes('.json')){
   const old=await response.json();
   return {ok:true,json:async()=>({...old,records:[...old.records,{...old.records[0],time:120,paths:['data/cloud-tiles/123456-256.webp','data/cloud-tiles/123456-512.webp','data/cloud-tiles/123456-1024.webp'],times:[{id:'eumet',night:120,day:null}]}]})};
  }
  return response;
 };
 await ctx.cloudEnsureMetadata(true);
 const latest=await ctx.cloudGetTile({z:6,x:33,y:18},130);
 assert.equal(first.times[0].night,100);
 assert.equal(latest.processor,'cdn');assert.equal(latest.times[0].night,120);
 assert.notEqual(latest.canvas,first.canvas);
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},110)).times[0].night,100);
});

test('Yesterday’s prepared clouds cannot freeze Latest or suppress fresh provider metadata',async()=>{
 const {ctx}=browser(false,true);
 ctx.frames=[{time:4500}];ctx.cloudRequestedTime=4500;ctx.Date={now:()=>4500000};
 ctx.cloudProducts.eumet={day:'visible',night:'ir',metadataAt:0};
 const original=ctx.fetch;
 ctx.fetch=async url=>{
  const response=await original(url);if(!url.includes('.json'))return response;
  const manifest=await response.json();
  return {ok:true,json:async()=>({...manifest,products:{eumet:{latest:{visible:100,ir:100},times:{visible:[100],ir:[100]}}}})};
 };
 await ctx.cloudEnsureMetadata();
 assert.equal(ctx.cloudProducts.eumet.metadataAt,0,'old archive metadata must not be marked freshly discovered');
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},4500)).processor,'native','use official sources during a stuck updater');
 assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},110)).processor,'cdn','matching historical archives remain usable');
});
test('Slow polar composites stay usable while expired full-disk GOES archives recover through providers',async()=>{
 for(const id of ['metop','gibs']){
  const {ctx}=browser(false,true);ctx.frames=[{time:20000}];ctx.Date={now:()=>20000000};
  const original=ctx.fetch;ctx.fetch=async url=>{
   const response=await original(url);if(!url.includes('.json'))return response;
   const manifest=await response.json();manifest.records[0].times=[{id,day:null,night:100}];
   return {ok:true,json:async()=>manifest};
  };
  await ctx.cloudEnsureMetadata();
  assert.equal((await ctx.cloudGetTile({z:6,x:33,y:18},20000)).processor,id==='metop'?'cdn':'native');
 }
});
