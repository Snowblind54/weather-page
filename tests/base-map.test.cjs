const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
test('satellite starts by default; Streets adds and removes both sea-depth layers',()=>{
  const layers=new Set(),panes=new Map(),buttons={};
  for(const id of ['streetBtn','satBtn']){const flags=new Set();buttons[id]={classList:{add:f=>flags.add(f),remove:f=>flags.delete(f),contains:f=>flags.has(f)}};}
  const tileLayer=(url,options)=>({url,options,addTo(){layers.add(this);return this;}});
  tileLayer.wms=tileLayer;
  const context={window:{L:true},document:{getElementById:id=>buttons[id]},navigator:{},Intl,Date,Map,Set,
    L:{map:()=>({on(){},createPane:n=>panes.set(n,{style:{}}),getPane:n=>panes.get(n),hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l)}),
      tileLayer,layerGroup:()=>({eachLayer(){}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/map.js'),'utf8'));
  assert.equal(layers.size,3);assert(!run('map.hasLayer(seaDepthContours)'));
  run('useStreet()');assert.equal(layers.size,3);
  assert(run('map.hasLayer(street)&&map.hasLayer(seaDepth)&&map.hasLayer(seaDepthContours)'));
  assert.equal(run('seaDepthContours.options.layers'),'emodnet:contours');
  assert.equal(run('seaDepthContours.options.minZoom'),5);
  assert.equal(run('seaDepthContours.options.transparent'),true);
  assert.equal(panes.get('depthContourPane').style.zIndex,'260');
  assert.equal(panes.get('depthContourPane').style.pointerEvents,'none');
  run('useStreet()');assert.equal(layers.size,3,'no duplicate layers');
  run('useSatellite()');assert.equal(layers.size,3);
  assert(!run('map.hasLayer(street)||map.hasLayer(seaDepth)||map.hasLayer(seaDepthContours)'));
  assert(buttons.satBtn.classList.contains('active'));
});
