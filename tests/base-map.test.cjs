const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
test('satellite starts by default; Streets adds sea shading and syncs numeric depth labels',()=>{
  const layers=new Set(),panes=new Map(),buttons={};
  for(const id of ['streetBtn','satBtn']){const flags=new Set();buttons[id]={classList:{add:f=>flags.add(f),remove:f=>flags.delete(f),contains:f=>flags.has(f)}};}
  const tileLayer=(url,options)=>({url,options,addTo(){layers.add(this);return this;}});
  let syncCalls=0;
  const context={syncSeaDepthLabels:()=>syncCalls++,window:{L:true},document:{getElementById:id=>buttons[id]},navigator:{},Intl,Date,Map,Set,
    L:{map:()=>({on(){},createPane:n=>panes.set(n,{style:{}}),getPane:n=>panes.get(n),hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l)}),
      tileLayer,layerGroup:()=>({eachLayer(){}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/map.js'),'utf8'));
  assert.equal(layers.size,3);assert(!run('map.hasLayer(seaDepth)'));
  run('useStreet()');assert.equal(layers.size,2);
  assert(run('map.hasLayer(street)&&map.hasLayer(seaDepth)'));
  assert.equal(syncCalls,1);
  run('useStreet()');assert.equal(layers.size,2,'no duplicate layers');
  run('useSatellite()');assert.equal(layers.size,3);
  assert(!run('map.hasLayer(street)||map.hasLayer(seaDepth)'));
  assert.equal(syncCalls,3);
  assert(buttons.satBtn.classList.contains('active'));
});
