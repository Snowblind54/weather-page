const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(fetch){
  const elements=new Map(),layers=new Set(),timeouts=new Map();let clock=0;
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'85',disabled:false,textContent:'',events:{},setAttribute(k,v){this[k]=v;},addEventListener(k,f){this.events[k]=f;}});return elements.get(id);};
  function Layer(options){this.options=options;this.events={};}Layer.prototype={addTo(){layers.add(this);return this;},on(k,f){this.events[k]=f;return this;},setOpacity(v){this.opacity=v;}};
  const ctx={console:{warn(){}},$:get,snowMode:true,snowLayer:new Layer({}),snowSourceLabel:'Latest source',
    snowStatus(t){ctx.status=t;},snowTileStatus(){ctx.status='Latest source';},hideSnowDepth(){ctx.hiddenDepth=(ctx.hiddenDepth||0)+1;},loadSnowDepth(){ctx.loadedDepth=(ctx.loadedDepth||0)+1;},
    map:{removeLayer(l){layers.delete(l);}},document:{hidden:false,createElement(){return {setAttribute(){}};}},
    setTimeout(f){const id=++clock;timeouts.set(id,f);return id;},clearTimeout(id){timeouts.delete(id);},
    L:{GridLayer:{extend(methods){function Sub(...args){Layer.apply(this,args);}Sub.prototype={...Layer.prototype,...methods};return Sub;}}},
    fetch,AbortSignal,Date,Blob,Response,DecompressionStream,Uint8Array};
  vm.createContext(ctx);const run=s=>vm.runInContext(s,ctx);run(fs.readFileSync('js/snow-history.js','utf8'));
  run(`snowHistoryFrames=Array.from({length:4},(_,i)=>({date:'2026-10-0'+(i+1),url:'data/snow-history/day'+i+'.json.gz'}));snowHistoryControls();`);
  return {ctx,get,layers,run,timeouts};
}
const bundle=date=>new Response(JSON.stringify({date,maxZoom:5,tiles:{'1/0/0':'abc'}}));
test('history replaces live layer, hides depths, and Latest restores it',async()=>{
  const h=harness(async url=>bundle('2026-10-0'+(Number(url.match(/day(\d)/)[1])+1)));
  h.layers.add(h.ctx.snowLayer);await h.run('selectSnowHistory(1)');
  assert.equal(h.run('snowHistoryActive'),true);assert.equal(h.ctx.hiddenDepth,1);assert.equal(h.layers.has(h.ctx.snowLayer),false);
  assert.match(h.get('snowDate').textContent,/2026-10-02.*4 km/);
  h.run('snowHistoryLatest()');assert.equal(h.run('snowHistoryActive'),false);assert.equal(h.ctx.loadedDepth,1);assert.equal(h.layers.has(h.ctx.snowLayer),true);
});
test('late historical response cannot overwrite Latest or resurrect exit',async()=>{
  let release;const h=harness(()=>new Promise(r=>release=r));
  const request=h.run('selectSnowHistory(0)');h.run('snowHistoryLatest()');release(bundle('2026-10-01'));await request;
  assert.equal(h.run('snowHistoryActive'),false);assert.equal(h.layers.size,1);
  h.run('snowHistoryCache.clear()');const second=h.run('selectSnowHistory(0)');h.run('snowMode=false;exitSnowHistory()');release(bundle('2026-10-01'));await second;
  assert.equal(h.run('snowHistoryLayer'),null);
});
test('failed day keeps the previous map and stops playback',async()=>{
  const h=harness(async()=>{throw new Error('offline');});h.layers.add(h.ctx.snowLayer);
  h.run('snowHistoryPlaying=true');await h.run('selectSnowHistory(0)');
  assert.equal(h.layers.has(h.ctx.snowLayer),true);assert.equal(h.run('snowHistoryPlaying'),false);assert.match(h.ctx.status,/could not load/);
});
test('bundle cache deduplicates requests and retains at most three days',async()=>{
  let calls=0;const h=harness(async url=>{calls++;return bundle('2026-10-0'+(Number(url.match(/day(\d)/)[1])+1));});
  await h.run('Promise.all([getSnowHistoryBundle(snowHistoryFrames[0]),getSnowHistoryBundle(snowHistoryFrames[0])])');assert.equal(calls,1);
  await h.run('getSnowHistoryBundle(snowHistoryFrames[0])');assert.equal(calls,1);
  for(let i=1;i<4;i++)await h.run(`getSnowHistoryBundle(snowHistoryFrames[${i}])`);
  assert.equal(h.run('snowHistoryCache.size'),3);assert.equal(h.run('snowHistoryCache.has(snowHistoryFrames[0].url)'),false);
});
test('slider keeps user-selected date before control refresh and debounces loads',async()=>{
  const h=harness(async url=>bundle('2026-10-0'+(Number(url.match(/day(\d)/)[1])+1)));
  h.get('snowHistorySlider').value='1';h.get('snowHistorySlider').events.input();
  assert.equal(h.get('snowHistorySlider').value,'1');const timer=[...h.timeouts.values()][0];await timer();
  await new Promise(r=>setImmediate(r));assert.equal(h.run('snowHistoryIndex'),1);
});
test('compressed daily bundle is decoded and validates its analysis date',async()=>{
  const zlib=require('node:zlib');const bytes=zlib.gzipSync(JSON.stringify({date:'2026-10-01',maxZoom:5,tiles:{}}));
  const h=harness(async()=>new Response(bytes));const data=await h.run('getSnowHistoryBundle(snowHistoryFrames[0])');assert.equal(data.date,'2026-10-01');
  await assert.rejects(h.run('getSnowHistoryBundle(snowHistoryFrames[1])'),/Invalid daily/);
});
test('station depth guard rejects current readings while browsing history',()=>{
  const s=fs.readFileSync('js/snow-depth.js','utf8');const guard=s.match(/function snowDepthEnabled\(\)\{[^}]+\}/)[0];
  const c={snowMode:true,snowHistoryActive:true,$:()=>({checked:true})};vm.createContext(c);vm.runInContext(guard,c);
  assert.equal(c.snowDepthEnabled(),false);c.snowHistoryActive=false;assert.equal(c.snowDepthEnabled(),true);
});
