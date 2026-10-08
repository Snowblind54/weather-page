const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=name=>fs.readFileSync(path.join(__dirname,'../js',name),'utf8');
function harness(){
  const c={console,Map,Set,Date,Math,Promise,Array,Uint8ClampedArray,Float32Array,
    URLSearchParams,AbortController,performance,setTimeout,clearTimeout,
    document:{querySelector:()=>null},$:()=>null,map:{on(){}},
    fmt:t=>String(t),L:{GridLayer:{extend:()=>function(){}}}};
  c.window=c;c.self=c;vm.createContext(c);
  for(const name of ['cloud-pixels.js','clouds.js','cloud-nordic-coverage.js','cloud-arctic-source.js'])vm.runInContext(script(name),c);
  vm.runInContext('installArcticCloudSource();installNordicCloudCoverage()',c);
  return {c,run:s=>vm.runInContext(s,c)};
}
test('both Canadian coasts, central Canada and Arctic islands have source coverage',()=>{
  const h=harness();
  for(const [lat,lon] of [[49.3,-123.1],[51,-114],[60,-110],[45.5,-73.6],[63.75,-68.5],[82.5,-62.3]]){
    assert(h.run(`Object.values(cloudSourceWeights(${lat},${lon})).reduce((a,b)=>a+b,0)`)>.9,`${lat},${lon}`);
  }
  assert(h.run('cloudSourceWeights(55,-130).west')>.99);
  assert(h.run('cloudSourceWeights(55,-70).gibs')>.99);
  assert(h.run('cloudSourceWeights(82.5,-62.3).metop')>.99);
});
test('central Canadian handoff is complementary and leaves European sources unchanged',()=>{
  const h=harness();
  const w=h.run('cloudSourceWeights(55,-107)');
  assert(w.west>0&&w.gibs>0);assert(Math.abs(w.west+w.gibs-1)<1e-9);
  assert.equal(h.run('cloudSourceWeights(57,25).eumet'),1);
  assert.equal(h.run('cloudSourceWeights(57,25).west'),0);
});
test('timeline keys change with GOES frames while a held polar composite reuses cache',()=>{
  const h=harness();
  h.run(`for(const id of ['gibs','west']){const p=cloudProducts[id];p.times={[p.day]:[1000,1600],[p.night]:[1000,1600]};}
    cloudProducts.metop.times={'eps:m03_ir108':[900]};`);
  assert.notEqual(h.run('cloudTileKey({z:6,x:9,y:20},1200)'),h.run('cloudTileKey({z:6,x:9,y:20},1700)'));
  assert.equal(h.run('cloudTileKey({z:6,x:19,y:5},1200)'),h.run('cloudTileKey({z:6,x:19,y:5},1700)'));
  assert.equal(h.run("cloudAvailableTime(cloudProducts.metop,'eps:m03_ir108',1200)"),900);
  assert.throws(()=>h.run("cloudAvailableTime(cloudProducts.metop,'eps:m03_ir108',800)"));
});
test('polar metadata records published composite times instead of nominal orbit steps',async()=>{
  const h=harness(),now=Math.floor(Date.now()/1000),old=now-6*3600;
  h.c.old=old;h.c.now=now;
  h.run(`cloudViewportSources=()=>['metop'];cloudFetch=async()=>'';`);
  h.c.DOMParser=class {parseFromString(){return {getElementsByTagNameNS:()=>[
    {children:[{localName:'Name',textContent:'eps:m03_ir108'},
      {localName:'Dimension',textContent:'2020-09-01T01:28:00Z/'+new Date(old*1000).toISOString()+'/PT1H40M',
        getAttribute:n=>n==='name'?'time':new Date(old*1000).toISOString()}]}
  ]};}};
  await h.run('cloudEnsureMetadata()');
  assert.deepEqual(Array.from(h.run("cloudProducts.metop.times['eps:m03_ir108']")),[old]);
  assert.equal(h.run("cloudAvailableTime(cloudProducts.metop,'eps:m03_ir108',now)"),old);
  assert(h.run(`cloudTimeDescription([{times:[{id:'metop',day:old,night:old}]}])`).includes('composite ending'));
});
test('West infrared uses the same thermal palette as East and polar IR is daylight independent',()=>{
  const h=harness(),time=Date.parse('2026-06-21T12:00:00Z')/1000;
  h.c.time=time;
  h.run("source={id:'west',night:new Uint8ClampedArray([127,0,127,255]),day:null,dayTime:time,nightTime:time};");
  const west=h.run('cloudExtractPixel(source,0,0,55,-120).alpha');
  h.run("source.id='gibs'");assert(Math.abs(h.run('cloudExtractPixel(source,0,0,55,-120).alpha')-west)<1e-10);
  h.run("source.id='metop';source.night=new Uint8ClampedArray([230,230,230,255]);source.day=source.night;");
  assert.equal(h.run('cloudExtractPixel(source,0,0,75,0).alpha'),h.run('cloudExtractPixel(source,0,0,75,-180).alpha'));
});
