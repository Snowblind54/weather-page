const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/wind.js'),'utf8');
function harness(){
  let projections=0,fieldReads=0,strokes=0,origin=0,clock=0;
  const callbacks=new Map(),elements={windDensity:{value:'100'},windStatus:{}};
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++;}};
  const context={console,Math,Number,Object,Array,Date,window:{devicePixelRatio:2},document:{hidden:false},
    $:id=>elements[id],windData:{},currentWindMode:()=> 'sustained',windTimeSlice:()=>({i:0,f:0}),
    windAt:()=>{fieldReads++;return [2,3];},windGustAt:()=>9,WIND_COLOUR_PALETTES:{sustained:['#fff'],gust:['#fff']},windColourIndex:()=>0,
    requestAnimationFrame:cb=>{const id=++clock;callbacks.set(id,cb);return id;},cancelAnimationFrame:id=>callbacks.delete(id),
    L:{Layer:{extend:methods=>methods},DomUtil:{setPosition(){}}}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('const WindCanvasLayer='),source.indexOf('function hideWind')),context);
  const map={getSize:()=>({x:240,y:240}),getZoom:()=>6,containerPointToLayerPoint:()=>[0,0],containerPointToLatLng:([x,y])=>{projections++;return {lat:y/10,lng:x/10+origin};}};
  const layer=vm.runInContext('Object.create(WindCanvasLayer)',context);
  Object.assign(layer,{ctx,canvas:{width:0,height:0,style:{}},_map:map,unix:1,mode:'sustained'});
  return {layer,context,callbacks,elements,counts:()=>({projections,fieldReads,strokes}),pan:()=>origin++};
}
test('fast wind sampling preserves bilinear sustained and gust vectors, invalid cells and calm gusts',()=>{
  const h=harness(),l=h.layer;Object.assign(l,{width:24,height:24,step:24,cols:2,field:[[2,4,8],[4,6,10],[6,8,12],[8,10,14]]});
  const out=[0,0,0];assert.equal(l.sample(12,12,out),out);assert.deepEqual(out,[5,7,0]);
  l.mode='gust';l.sample(12,12,out);assert(Math.abs(out[2]-11)<1e-10);assert(Math.abs(Math.hypot(out[0],out[1])-11)<1e-10);assert(Math.abs(out[0]/out[1]-5/7)<1e-10);
  assert.equal(l.sample(-1,0,out),null);assert.equal(l.sample(24,0,out),null);l.field[3]=null;assert.equal(l.sample(12,12,out),null);
  l.field=Array.from({length:4},()=>[0,0,0]);assert.deepEqual(Array.from(l.sample(12,12,out)),[0,0,0]);
  l.field=Array.from({length:4},()=>[0,0,10]);assert.equal(l.sample(12,12,out),null);
});
test('density-only resets reuse projected wind data; pan, time, mode and refreshed data rebuild it',()=>{
  const h=harness(),l=h.layer;l.reset();const first=h.counts();assert(first.fieldReads>0);assert.equal(l.canvas.width,300);
  h.elements.windDensity.value='200';l.reset();assert.equal(h.counts().fieldReads,first.fieldReads);assert(l.particles.length>0);
  h.pan();l.reset();assert.equal(h.counts().fieldReads,first.fieldReads*2);
  l.unix=2;l.reset();assert.equal(h.counts().fieldReads,first.fieldReads*3);
  l.mode='gust';l.reset();assert.equal(h.counts().fieldReads,first.fieldReads*4);
  h.context.windData={};l.reset();assert.equal(h.counts().fieldReads,first.fieldReads*5);
});
test('zoom and move completion coalesce into one rebuild; disabling cancels queued work',()=>{
  const h=harness(),l=h.layer;l.scheduleReset();l.scheduleReset();assert.equal(h.callbacks.size,1);
  const [id,cb]=h.callbacks.entries().next().value;h.callbacks.delete(id);cb();assert(h.counts().fieldReads>0);assert.equal(h.callbacks.size,1);
  l.scheduleReset();l.pause();assert.equal(h.callbacks.size,0);assert.equal(l.canvas.style.visibility,'hidden');
});
test('rounded 60 Hz timestamps produce a steady 30 fps instead of dropping to 20 fps',()=>{
  const h=harness(),l=h.layer;let samples=0;
  Object.assign(l,{width:240,height:240,lastFrame:null,colours:['#fff'],segments:[[]],particles:[{x:100,y:100,age:0,life:99}],sample:()=>{samples++;return [2,3];},validPoint:()=>true});
  for(let i=0;i<=60;i++)l.animate(Math.round(i*1000/60*10)/10);
  assert.equal(samples,31);assert.equal(h.counts().strokes,31);
});

test('world-zoom field reaches the equator at the same screen position as particles, including a viewport beyond the pole',()=>{
  for(const originY of [-155,0,200]){
    const worldSize=1024,size={x:300,y:936};let raster,destination;
    const unproject=({x,y})=>({lat:Math.atan(Math.sinh(Math.PI*(1-2*y/worldSize)))*180/Math.PI,lng:x/worldSize*360-180});
    const map={getSize:()=>size,getZoom:()=>2,getPixelBounds:()=>({min:{x:0,y:originY}}),
      containerPointToLayerPoint:()=>[0,0],containerPointToLatLng:([x,y])=>unproject({x,y:y+originY}),
      // Real Mercator projection clamps near the poles; the round trip loses
      // negative world pixels and used to shift the entire coloured field.
      project:ll=>({x:(ll.lng+180)/360*worldSize,y:worldSize*(1-Math.asinh(Math.tan(Math.max(-85.0511287798,Math.min(85.0511287798,ll.lat))*Math.PI/180))/Math.PI)/2}),
      unproject};
    const ctx={clearRect(){},save(){},restore(){},drawImage(...args){destination=args;}};
    const lowCtx={createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{raster=image;}};
    const c={console,Math,Number,Object,Array,Date,Map,windData:{},windTimeSlice:()=>({i:0,f:0}),
      windAt:lat=>lat>=0&&lat<=84?[3,4]:null,windGustAt:()=>8,windColourIndex:()=>0,
      WIND_COLOUR_PALETTES:{sustained:['#45dfac']},windHeatmapCorrections:()=>[],windHeatmapCorrectionIndex:()=>({count:0}),windHeatmapNearbyCorrections:()=>[],
      $:id=>id==='windHeatmapOpacity'?{value:'50'}:{},fmt:()=>'',globalThis:{},
      document:{createElement:()=>({getContext:()=>lowCtx})},L:{Layer:{extend:m=>m},DomUtil:{setPosition(){}},point:(x,y)=>({x,y})}};
    vm.createContext(c);vm.runInContext(source.slice(source.indexOf('const WindHeatmapLayer='),source.indexOf('function hideWindHeatmap')),c);
    const layer=vm.runInContext('Object.create(WindHeatmapLayer)',c);Object.assign(layer,{_map:map,ctx,canvas:{style:{}},mode:'sustained',unix:100});layer.reset();
    let last=-1;
    for(let y=0;y<raster.height;y++)if(raster.data[(y*raster.width+1)*4+3]>0)last=y;
    const [, , , , ,dx,dy,dw,dh]=destination,step=dh/raster.height;
    const lastPaintedCentre=dy+(last+.5)*step;
    const equatorOnScreen=worldSize/2-originY;
    assert(Math.abs(lastPaintedCentre-equatorOnScreen)<=step,`${originY}: field ended at ${lastPaintedCentre}, equator at ${equatorOnScreen}`);
  }
});
