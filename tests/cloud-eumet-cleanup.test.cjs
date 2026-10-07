const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');

function harness(){
  const context={console,Map,Set,Date,Math,Array,Uint8ClampedArray,Float32Array,globalThis:null};
  context.globalThis=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-pixels.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-eumet-cleanup.js'),'utf8'),context);
  context.installEumetCleanClouds();
  return context;
}

test('Meteosat cleanup removes neutral GeoColour surface wash without removing cloud',()=>{
  const c=harness();
  const noon=Date.parse('2026-10-07T12:00:00Z')/1000;

  c.gray={
    id:'eumet',eumetClean:true,
    day:new Uint8ClampedArray([150,150,150,255]),
    night:new Uint8ClampedArray([20,20,20,255]),
    dayTime:noon,nightTime:noon
  };
  assert.equal(vm.runInContext('cloudExtractPixel(gray,0,0,50,10).alpha',c),0);

  c.cloud={
    id:'eumet',eumetClean:true,
    day:new Uint8ClampedArray([235,235,235,255]),
    night:new Uint8ClampedArray([220,220,220,255]),
    dayTime:noon,nightTime:noon
  };
  assert(vm.runInContext('cloudExtractPixel(cloud,0,0,50,10).alpha',c)>.5);
});

test('cleanup is EUMETSAT-only',()=>{
  const c=harness();
  const noon=Date.parse('2026-10-07T12:00:00Z')/1000;
  c.other={id:'metop',day:new Uint8ClampedArray([170,170,170,255]),night:null,dayTime:noon,nightTime:noon};
  const expected=vm.runInContext('visualCloudScore(170,170,170)**1.45*.86',c);
  const actual=vm.runInContext('cloudExtractPixel(other,0,0,50,10).alpha',c);
  assert(Math.abs(actual-expected)<1e-9);
});
