const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),zlib=require('node:zlib');
function packed(heights){
 const h=Buffer.from(JSON.stringify({version:1,south:0,north:2,west:0,east:4,step:1,rows:3,cols:5,scale:10})),b=Buffer.alloc(4+h.length+30);b.writeUInt32LE(h.length);h.copy(b,4);
 heights.forEach((v,i)=>b.writeInt16LE(v/10,4+h.length+i*2));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
}
function context(raw){
 const c={console,Date,Math,Number,Map,Set,Promise,JSON,ArrayBuffer,DataView,Uint8Array,Int16Array,TextDecoder,AbortController,setTimeout,clearTimeout,fetch:async()=>({ok:true,arrayBuffer:async()=>raw})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/terrain-context.js','utf8'),c);return c;
}
test('static DEM packs decode real Alpine relief and reject corrupt data',()=>{
 const c=context(),api=c.NorthernTerrain;
 for(const name of ['europe','global']){
  const bytes=zlib.gunzipSync(fs.readFileSync('assets/terrain-'+name+'-v1.bin.gz'));const p=api.decode(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert.equal(p.values.length,p.rows*p.cols);assert(p.values.some(v=>v>300));
  if(name==='europe'){
   const z=(lat,lon)=>p.values[Math.round((lat-p.south)/p.step)*p.cols+Math.round((lon-p.west)/p.step)]*10;
   assert(z(45.83,6.86)>3000);assert(z(45.92,6.87)<1500);assert(z(45.74,7.32)<1200);
  }
 }
 assert.throws(()=>api.decode(new ArrayBuffer(10)));
});
test('a ridge limits rain and wind influence across valleys without changing an exact observation',async()=>{
 const c=context(packed([0,0,2500,0,0,0,0,2500,0,0,0,0,2500,0,0]));await c.NorthernTerrain.ready();const t=c.NorthernTerrain;
 assert.equal(t.influence(1,1,'wind')(1,1),1);assert(t.influence(1,1,'wind')(1,3)<.01);assert(t.influence(1,1,'rain')(1,3)<.01);
 assert(t.influence(1,0,'rain')(1,1)>.95);assert.equal(t.elevation(1,2),2500);
});
test('temperature uses bounded elevation adjustment and falls back without pretending unknown terrain is flat',async()=>{
 const c=context(packed(Array(3).fill([0,500,1000,1500,2000]).flat()));await c.NorthernTerrain.ready();const t=c.NorthernTerrain;
 assert.equal(t.temperature(15,1,0,1,2),8.5);assert.equal(t.temperature(15,1,0,1,4),3);
 assert.equal(t.temperature(15,1,0,20,20),15);assert.equal(t.influence(1,0,'rain')(20,20),.35);
});
test('foreign station corrections cross a flat border but terrain can weaken their wind contribution',()=>{
 const blend=require('../js/wind-observation-blend.js');const c=blend.makeCorrection(46,7,15,5,0);
 const near=blend.adjustSpeed(5,46,7.05,[c]);assert(near>10);
 c.terrain=()=>.001;assert(blend.adjustSpeed(5,46,7.05,[c])<5.1);
});
