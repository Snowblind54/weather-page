const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');

function context(){
  const ctx={console,Math,globalThis:null,self:null};
  ctx.globalThis=ctx;ctx.self=ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-pixels.js'),'utf8'),ctx);
  ctx.cloudProducts={eumet:{}};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/cloud-nordic-coverage.js'),'utf8'),ctx);
  ctx.installNordicCloudCoverage();
  return ctx;
}

test('polar source fades in smoothly across northern Scandinavia',()=>{
  const c=context();
  c.cloudProducts.metop={};
  const south=vm.runInContext('cloudSourceWeights(64,20)',c);
  const transition=vm.runInContext('cloudSourceWeights(67,20)',c);
  const north=vm.runInContext('cloudSourceWeights(71,20)',c);
  assert.equal(south.metop,0);
  assert(transition.metop>0 && transition.metop<1);
  assert(north.metop>.99);
  assert(north.eumet<transition.eumet,'Meteosat contribution is reduced gradually beneath the polar source');
});

test('browser does not request Metop before its product is installed',()=>{
  const c=context();
  const weights=vm.runInContext('cloudSourceWeights(71,20)',c);
  assert.equal(weights.metop,0);
});

test('polar blend covers Arctic Canada and the Nordics, but not unrelated areas',()=>{
  const c=context();c.cloudProducts.metop={};
  assert(vm.runInContext('cloudSourceWeights(71,-100).metop',c)>.8);
  assert.equal(vm.runInContext('cloudSourceWeights(60,-100).metop',c),0);
  assert.equal(vm.runInContext('cloudSourceWeights(71,50).metop',c),0);
});
