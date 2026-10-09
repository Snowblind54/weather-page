const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const producer=require('../scripts/update_cloud_tiles.cjs');
test('Coverage includes Europe, Iceland, Canada and Greenland at original native detail',()=>{
 const c=producer.runtime(),rows=producer.coordinates(c);
 assert.ok(rows.length<100,'bounded central block count');
 for(const [lat,lon] of [[59,25],[65,-19],[52,-110],[70,-45]]){
  const z=4,x=Math.floor((lon+180)/360*16),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*16);
  assert.ok(rows.some(r=>r.z===z&&r.x===x&&r.y===y));
 }
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
 const ctx={console,Date,Map,Set,Promise,URL,AbortController,setTimeout,clearTimeout,cloudSession:1,cloudControllers:new Set(),cloudProducts:{},cloudRequestedTime:100,
  cloudEnsureMetadata:async()=>{},cloudGetTile:async()=>({processor:'native'}),cloudTileKey:()=> 'native',cloudVisibleTiles:()=>[],cloudTileResolution:()=>256,
  cloudTileCache:cache,cloudTilePromises:promises,CLOUD_TILE_CACHE_LIMIT:768,CLOUD_CACHE_BYTES:48*1024*1024,cloudCacheBytes:()=>cache.size*256*256*4,
  map:{on:()=>{}},$:()=>({addEventListener:()=>{},checked:true}),createImageBitmap:async()=>({width:1024,height:1024,close(){}}),
  document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage:(...a)=>draws.push(a)})})},
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
