const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),Cache=require('../js/decoded-image-cache.js');
test('Prepared cloud crops draw directly from one retained bitmap across a changed map session',async()=>{
 let decodes=0,canvases=0,closeCount=0,toggle;
 const record={key:'4/1/2',time:1000,paths:['data/cloud-tiles/abcdef-256.webp','data/cloud-tiles/abcdef-512.webp','data/cloud-tiles/abcdef-1024.webp'],times:[{id:'east',day:1000}]};
 const cache=new Map();const checkbox={checked:true,addEventListener:(n,fn)=>toggle=fn};
 const c={window:{NorthernDecodedImageCache:Cache},Date:{now:()=>1000000},Map,Set,Number,Math,Object,Array,Promise,AbortController,setTimeout,clearTimeout,URL,cloudSession:1,cloudControllers:new Set(),cloudProducts:{},cloudRequestedTime:1000,cloudTileCache:cache,cloudTilePromises:new Map(),CLOUD_CACHE_BYTES:48*1024*1024,CLOUD_TILE_CACHE_LIMIT:768,frames:[{time:1000}],matchMedia:()=>({matches:true}),$:()=>checkbox,map:{on(){}},cloudEnsureMetadata:async()=>{},cloudGetTile:()=>{throw Error('Native fallback unexpected');},cloudTileKey:()=>'',cloudVisibleTiles:()=>[],cloudTimelineEnd:()=>1000,cloudTileResolution:()=>256,cloudCacheBytes:()=>[...cache.values()].reduce((n,e)=>n+e.canvas.width*e.canvas.height*4,0),
 document:{title:'',createElement:()=>{canvases++;return {width:0,height:0,getContext:()=>({drawImage:(source)=>{assert.equal(source.width,512)}})};}},
 fetch:async u=>u.startsWith('data/cloud-tiles.json')?{ok:true,json:async()=>({version:1,records:[record]})}:{ok:true,blob:async()=>({})},
 createImageBitmap:async()=>{decodes++;return {width:512,height:512,close(){closeCount++}};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/cloud-prepared.js','utf8'),c);
 await c.cloudEnsureMetadata();await Promise.all([c.cloudGetTile({z:5,x:2,y:4},1000),c.cloudGetTile({z:5,x:3,y:4},1000)]);
 assert.equal(decodes,1);assert.equal(canvases,2);assert.equal(closeCount,0);
 c.cloudSession++;cache.clear();await c.cloudGetTile({z:5,x:2,y:4},1000);assert.equal(decodes,1);assert.equal(canvases,3);
 checkbox.checked=false;toggle();assert.equal(closeCount,1);
});
