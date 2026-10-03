const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
function harness(){
  const layers=new Set(),panes=new Map(),elements={depthLabelsStatus:{}},street={},markers=[];
  layers.add(street);
  const group={clearLayers(){markers.length=0;},addTo(){layers.add(this);return this;}};
  const context={Date,Map,Math,Number,JSON,AbortController,console,setTimeout,clearTimeout,street,
    $:id=>elements[id],localStorage:{getItem:()=>null,setItem(){}},
    document:{querySelector:()=>null},
    loadTemperatureCountryFeatures:async()=>[{land:true}],weatherPointInFeature:(lat,lon)=>lon>=25,
    map:{on(){},createPane:n=>panes.set(n,{style:{}}),getPane:n=>panes.get(n),hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),
      getZoom:()=>6,getCenter:()=>({lat:57}),getBounds:()=>({getWest:()=>10,getEast:()=>30,getSouth:()=>53,getNorth:()=>60}),
      latLngToContainerPoint:([lat,lon])=>({x:lon*10,y:lat*10})},
    L:{layerGroup:()=>group,divIcon:o=>o,marker:(point,options)=>({addTo(){markers.push({point,options});return this;}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);
  run(fs.readFileSync(path.join(__dirname,'../js/bathymetry.js'),'utf8'));
  return {context,run,layers,street,markers,elements,panes};
}
test('EMODnet negative elevation becomes positive metres; land/null are never depth labels',()=>{
  const h=harness();
  assert.equal(h.run('parseSeaDepth({avg:-75.97})'),75.97);
  for(const value of ['null','{}','{avg:null}','{avg:14.56}','{avg:0}','{avg:NaN}','{avg:-99999}']) assert.equal(h.run('parseSeaDepth('+value+')'),null);
  assert.equal(h.panes.get('depthLabelPane').style.zIndex,'300');
  const points=h.run('seaDepthLabelPoints([{land:true}])');assert(points.length>0&&points.length<=48);
  assert(points.every(p=>p[1]<25),'only visible offshore points sampled');
});
test('depth requests are cached/deduplicated, bounded in concurrency and rendered as small numbers',async()=>{
  const h=harness();let requests=0,active=0,maxActive=0;
  h.context.fetch=async url=>{requests++;active++;maxActive=Math.max(maxActive,active);
    const geom=new URL(url).searchParams.get('geom');assert(/^POINT\([-\d.]+ [-\d.]+\)$/.test(geom));
    await new Promise(r=>setImmediate(r));active--;return {ok:true,json:async()=>({avg:-75.97})};};
  await Promise.all([h.run('fetchSeaDepth(59.7,24)'),h.run('fetchSeaDepth(59.7,24)')]);assert.equal(requests,1);
  await h.run('fetchSeaDepth(59.7,24)');assert.equal(requests,1);
  await h.run('renderSeaDepthLabels(0)');assert(maxActive<=4);assert(h.markers.length>0);
  assert(h.markers.every(m=>m.options.icon.html.includes('76 m')&&m.options.pane==='depthLabelPane'&&!m.options.interactive));
  h.layers.delete(h.street);h.run('syncSeaDepthLabels()');assert.equal(h.markers.length,0);assert(h.elements.depthLabelsStatus.hidden);
});
test('switching to satellite during a depth request does not resurrect labels',async()=>{
  const h=harness();let release;
  h.context.fetch=async()=>{await new Promise(r=>{release=r;});return {ok:true,json:async()=>({avg:-76})};};
  const pending=h.run('fetchSeaDepth(59,24)');h.layers.delete(h.street);h.run('syncSeaDepthLabels()');release();await pending;
  await h.run('renderSeaDepthLabels(0)');assert.equal(h.markers.length,0);
});
