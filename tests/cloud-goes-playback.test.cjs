const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function prepared(){
 const record={key:'4/8/4',time:100,paths:['data/cloud-tiles/abcdef-256.webp'],times:[{id:'gibs',night:100,day:null}]};
 const ctx={Date:{now:()=>130000},Map,Set,Promise,document:{title:''},frames:[{time:120}],map:{on(){}},$:()=>({addEventListener(){}}),
 cloudTileSources:()=>['gibs'],cloudTileKey:()=> 'native',cloudGetTile:async()=>{},cloudEnsureMetadata:async()=>{},cloudVisibleTiles:()=>[],
 cloudProducts:{gibs:{day:'visible',night:'ir',latest:{visible:120,ir:120},times:{visible:[100,120],ir:[100,120]}}},
 cloudAvailableTime:(p,n,t)=>Math.max(...p.times[n].filter(v=>v<=t)),fetch:async()=>({ok:true,json:async()=>({version:1,records:[record]})})};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('js/cloud-prepared.js','utf8'),ctx);return ctx;
}
test('GOES uses published prepared images until the central manifest advances',async()=>{
 const c=prepared();await c.cloudEnsureMetadata();
 assert.match(c.cloudTileKey({z:4,x:8,y:4},110),/^prepared-cloud:/);
 assert.match(c.cloudTileKey({z:4,x:8,y:4},120),/^prepared-cloud:/);
 c.Date={now:()=>20_000_000};assert.equal(c.cloudTileKey({z:4,x:8,y:4},120),'native','stalled archives recover through providers');
});
test('satellite-aligned Latest never borrows a newer archive from another satellite clock',async()=>{
 const c=prepared();c.frames=[{time:90}];c.cloudTimelineEnd=()=>90;
 await c.cloudEnsureMetadata();assert.equal(c.cloudTileKey({z:4,x:8,y:4},90),'native');
});
