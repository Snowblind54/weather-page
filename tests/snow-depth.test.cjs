const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync('js/snow-depth.js','utf8');
function harness(){
  const els={},get=id=>els[id]||(els[id]={checked:true,textContent:'',addEventListener(){}});
  const group={clearLayers(){},addTo(){return this;}};
  const ctx={console,Date,Intl,Number,Math,Object,String,Promise,setTimeout,clearTimeout,AbortSignal,
    L:{layerGroup:()=>group},map:{on(){},hasLayer:()=>false},$:get,snowMode:true};
  vm.createContext(ctx);vm.runInContext(source,ctx);return {ctx,get,run:s=>vm.runInContext(s,ctx)};
}
test('missing, future and outdated snow depths cannot appear as 0 cm',()=>{
  const h=harness();h.ctx.station={country:'FI',name:'Station',lat:60,lon:25,time:Date.now()/1000-3600,depthCm:0,state:'bare'};
  assert.equal(h.run('snowDepthValid(station)'),true);
  for(const patch of [{depthCm:null},{time:Date.now()/1000-73*3600},{time:Date.now()/1000+3600},{country:'XX'}]){
    const old={...h.ctx.station};Object.assign(h.ctx.station,patch);
    assert.equal(h.run('snowDepthValid(station)'),false);h.ctx.station=old;
  }
});
test('patchy and trace snow remain non-numeric station labels',()=>{
  const h=harness();h.ctx.station={country:'SE',name:'Station',lat:60,lon:18,time:Date.now()/1000-3600,depthCm:null,state:'patchy'};
  assert.equal(h.run('snowDepthValid(station)'),true);
  assert.equal(h.run('snowDepthText(station)'),'Patchy');
  h.ctx.station.state='trace';assert.equal(h.run('snowDepthText(station)'),'<0.5 cm');
});
test('popup reports observation day, provisional quality and escapes station text',()=>{
  const h=harness();h.ctx.station={country:'FI',name:'<Station>',time:Date.now()/1000-40*3600,depthCm:12,state:'depth',timePrecision:'day',quality:'provisional'};
  const html=h.run('snowDepthPopup(station)');
  assert.match(html,/&lt;Station&gt;/);assert.match(html,/observation day/);
  assert.match(html,/Older reading/);assert.match(html,/Provisional official reading/);
});
