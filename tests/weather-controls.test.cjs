const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const read=name=>fs.readFileSync(path.join(__dirname,'../js',name),'utf8');
function temperatureHarness(){
  const elements={tempOn:{checked:false,addEventListener(){}},heatmapOn:{checked:true,addEventListener(){}},tempOpacity:{value:'58'},tempStatus:{},timeline:{value:'0'}};
  const layers=new Set(),map={on(){},hasLayer:l=>layers.has(l),removeLayer:l=>layers.delete(l),getZoom:()=>6,getBounds:()=>({contains:()=>false})};
  const group=children=>({children,clearLayers(){},eachLayer(f){this.children.forEach(f);},addTo(){layers.add(this);return this;}});
  const context={console,Map,Set,Date,Math,Number,Promise,Float32Array,$:id=>elements[id],map,
    temperatureSeries:[{}],temperatureLabels:group([]),temperatureLayer:null,temperatureRenderToken:0,
    temperatureDebounceTimer:null,temperaturePrecacheTimer:null,clearTimeout(){},weatherFront(){},fmt:String,
    L:{layerGroup:group,imageOverlay:(url,bounds,options)=>({url,bounds,options,setOpacity(){}})}};
  vm.createContext(context);const run=s=>vm.runInContext(s,context);run(read('temperature.js'));
  run('createTemperatureImage=async()=>({regions:[{dataUrl:"model-image",bounds:[[53,20],[60,29]]}],minT:5,maxT:14})');
  const app=read('app.js');run(app.slice(app.indexOf('async function updateTemperatureVisibility'),app.indexOf("$('windOn').addEventListener")));
  run('loadTemperatures=async()=>buildTemperatureOverlay(10000)');
  return {run,elements,layers,context};
}
test('heatmap draws independently of numbers; changing either control preserves the other',async()=>{
  const h=temperatureHarness();await h.run('buildTemperatureOverlay(10000)');
  assert.equal(h.layers.size,1);assert(!h.layers.has(h.context.temperatureLabels));assert.equal(h.elements.tempOn.checked,false);
  h.elements.tempOn.checked=true;await h.run('updateTemperatureVisibility()');
  assert.equal(h.layers.size,2);assert(h.layers.has(h.context.temperatureLabels));
  h.elements.tempOn.checked=false;await h.run('updateTemperatureVisibility()');
  assert.equal(h.layers.size,1);assert(!h.layers.has(h.context.temperatureLabels));assert(h.run('temperatureLayer')!==null);
  h.elements.tempOn.checked=true;h.elements.heatmapOn.checked=false;await h.run('updateTemperatureVisibility()');
  assert.equal(h.run('temperatureLayer'),null);assert(h.layers.has(h.context.temperatureLabels));
});
test('disabling both temperature layers during an image build cannot resurrect the heatmap',async()=>{
  const h=temperatureHarness();let release;
  h.context.pending=new Promise(resolve=>release=resolve);h.run('createTemperatureImage=()=>pending');
  const render=h.run('buildTemperatureOverlay(10000)');h.elements.heatmapOn.checked=false;
  await h.run('updateTemperatureVisibility()');release({regions:[],minT:5,maxT:10});await render;
  assert.equal(h.layers.size,0);assert.equal(h.run('temperatureLayer'),null);
});
test('wind colours interpolate continuously through anchors, with purple and extreme-gust pink',()=>{
  const context={Math,Number,Object,Array,parseInt,$:()=>null};vm.createContext(context);
  const source=read('wind.js');vm.runInContext(source.slice(source.indexOf('// Continuous colour stops'),source.indexOf('function windPopupContent')),context);
  const colour=(speed,mode='sustained')=>vm.runInContext(`windColour(${speed},'${mode}')`,context);
  assert.equal(colour(0),'#8fdcff');assert.equal(colour(3),'#45dfac');assert.equal(colour(25),'#bd75ff');assert.equal(colour(40),'#bd75ff');assert.equal(colour(34,'gust'),'#ff52c8');
  assert.notEqual(colour(1.5),colour(0));assert.notEqual(colour(1.5),colour(3));
  const rgb=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
  for(const anchor of [3,6,10,15,25]){
    const a=rgb(colour(anchor-.01)),b=rgb(colour(anchor+.01));assert(a.every((v,i)=>Math.abs(v-b[i])<=2));
  }
  for(const speed of [-10,0,12.4,33,100])assert(vm.runInContext(`windColourIndex(${speed})`,context)>=0&&vm.runInContext(`windColourIndex(${speed})`,context)<=100);
});

test('wind particle drawing samples once per particle and batches strokes without blurred shadows',()=>{
  let samples=0,strokes=0;
  const ctx={fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++;}};
  const context={Math,Number,Object,Array,requestAnimationFrame:()=>1,L:{Layer:{extend:methods=>methods}},windColourIndex:()=>0};
  vm.createContext(context);
  const source=read('wind.js');vm.runInContext(source.slice(source.indexOf('const WindCanvasLayer='),source.indexOf('function hideWind')),context);
  context.ctx=ctx;context.sampleSpy=()=>{samples++;return [2,3];};
  vm.runInContext(`windTest=Object.create(WindCanvasLayer);Object.assign(windTest,{ctx,lastFrame:null,width:500,height:400,mode:'sustained',
    colours:['#fff'],segments:[[]],particles:Array.from({length:10},()=>({x:100,y:100,age:0,life:3})),sample:sampleSpy,validPoint:()=>true});windTest.animate(1000);`,context);
  assert.equal(samples,10);assert.equal(strokes,1);assert.equal(ctx.shadowBlur,0);
});

test('same-hour redraw resumes a paused wind animation without restarting an active one',()=>{
 const c={L:{Layer:{extend:m=>m}},currentWindMode:()=> 'sustained',windData:{},document:{hidden:false}};vm.createContext(c);
 const source=read('wind.js');vm.runInContext(source.slice(source.indexOf('const WindCanvasLayer='),source.indexOf('function hideWind')),c);
 c.calls=0;vm.runInContext('layer=Object.create(WindCanvasLayer);Object.assign(layer,{unix:100,data:windData,mode:"sustained",_map:{},raf:null,scheduleReset(){calls++;}});layer.setTime(100)',c);assert.equal(c.calls,1);
 vm.runInContext('layer.raf=1;layer.setTime(100)',c);assert.equal(c.calls,1);
 vm.runInContext('layer.raf=null;document.hidden=true;layer.setTime(100)',c);assert.equal(c.calls,1);
});
