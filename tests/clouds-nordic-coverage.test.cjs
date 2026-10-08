const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

function harness(){
  const context={console,Map,Set,Date,Math,Array,Uint8ClampedArray,Float32Array};
  context.self=context;
  context.cloudProducts={eumet:{}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-pixels.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-nordic-coverage.js'),'utf8'),context);
  vm.runInContext('installNordicCloudCoverage()',context);
  return context;
}

function brightSource(size,time){
  const side=size*17/16;
  const day=new Uint8ClampedArray(side*side*4);
  for(let i=0;i<day.length;i+=4){day[i]=235;day[i+1]=238;day[i+2]=242;day[i+3]=255;}
  return {id:'eumet',day,night:null,mask:new Uint8ClampedArray(day.length),dayTime:time,nightTime:time};
}

test('legacy MSG mask is bypassed only for tiles extending north of 67.5N',()=>{
  const h=harness();
  const size=128,time=Date.parse('2026-06-21T12:00:00Z')/1000;
  h.northSource=brightSource(size,time);
  h.southSource=brightSource(size,time);

  // z6/y14 covers about 68.7–70.6N: MTG imagery exists but the old MSG mask does not.
  h.northCoords={z:6,x:36,y:14};
  const north=vm.runInContext('cloudProcessPixels(northCoords,[northSource],128)',h);
  assert(north.some(value=>value>0),'northern Scandinavia should retain visible Meteosat clouds');
  assert(h.northSource.mask,'the source mask must be restored after processing');

  // z6/y16 stays below the old mask edge, so the existing clean mask behaviour remains unchanged.
  h.southCoords={z:6,x:36,y:16};
  const south=vm.runInContext('cloudProcessPixels(southCoords,[southSource],128)',h);
  assert.equal(south.some(value=>value>0),false,'southern transparent mask should still suppress false clouds');
});

test('Nordic coverage installer is idempotent',()=>{
  const h=harness();
  const once=vm.runInContext('cloudProcessPixels',h);
  vm.runInContext('installNordicCloudCoverage()',h);
  assert.equal(vm.runInContext('cloudProcessPixels',h),once);
});
