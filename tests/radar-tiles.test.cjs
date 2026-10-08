const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../js/radar-tiles.js','utf8');
function harness(){
 const record={source:'fi',station:'fi',time:1000,path:'data/radar-tiles/fi-1000-0123456789ab',bounds:[[-20,-20],[20,20]],min_zoom:3,max_zoom:7,tiles:{3:['3/3','3/4','4/3','4/4']}};
 const calls=[],view={getSouth:()=>0,getWest:()=>0,getNorth:()=>10,getEast:()=>10};
 const c={Map,Set,Promise,Date,Math,Number,Object,Array,AbortController,setTimeout,clearTimeout,console:{warn(){}},performance,
 map:{getZoom:()=>3,getBounds:()=>view},document:{createElement:()=>({width:0,height:0,dataset:{},getContext:()=>({drawImage(){}})})},
 fetch:async()=>({ok:true,json:async()=>({version:1,frames:[record]})}),loadRadarNativeImage:async url=>{calls.push(url);return {};}};
 vm.createContext(c);vm.runInContext(source,c);return {c,record,calls,view};
}
test('prepared radar loads only published visible tiles and reuses ready frames',async()=>{
 const {c,calls}=harness();const frame=await vm.runInContext("preparedRadarFrame('fi',1000)",c);
 assert(frame.prepared);assert.equal(frame.time,1000);assert.equal(calls.length,1);assert(calls[0].endsWith('/3/4/3.png'));
 assert.equal(await vm.runInContext("preparedRadarFrame('fi',1000)",c),frame);assert.equal(calls.length,1);
});
test('future, stale, missing and close zoom frames fall back to native radar',async()=>{
 const {c}=harness();assert.equal(await vm.runInContext("preparedRadarFrame('fi',999)",c),null);
 assert.equal(await vm.runInContext("preparedRadarFrame('fi',1901)",c),null);
 c.map.getZoom=()=>8;assert.equal(await vm.runInContext("preparedRadarFrame('fi',1000)",c),null);
 c.map.getZoom=()=>3;c.loadRadarNativeImage=async()=>{throw Error('missing tile')};
 assert.equal(await vm.runInContext("preparedRadarFrame('fi',1000)",c),null);
});
test('dry published scans succeed without requests and unsafe paths are rejected',async()=>{
 const {c,record,calls}=harness();record.tiles={3:[]};const frame=await vm.runInContext("preparedRadarFrame('fi',1000)",c);assert(frame.prepared);assert.equal(calls.length,0);
 c.bad={...record,path:'https://tracking.example/fi-1000-0123456789ab'};assert.equal(vm.runInContext('validPreparedRadarFrame(bad)',c),false);
 c.bad={...record,tiles:{3:['8/3']}};assert.equal(vm.runInContext('validPreparedRadarFrame(bad)',c),false);
});
test('panning prepares a different viewport while keeping cached earlier views',async()=>{
 const {c,view}=harness();const first=await vm.runInContext("preparedRadarFrame('fi',1000)",c);
 view.getWest=()=>-10;view.getEast=()=>0;const second=await vm.runInContext("preparedRadarFrame('fi',1000)",c);
 assert.notEqual(first.url,second.url);assert.equal(first.canvas.width,256);assert.equal(second.canvas.width,256);
});
