const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness(light=true){
 const drawn=[],canvases=[],pane={appendChild(c){c.parentNode=this}},view={viewport:true};
 const extent={left:-1000,top:-1000,width:4000,height:4000};
 const map={getSize:()=>({x:390,y:844}),getBounds:()=>view,on(){},off(){},getPane:()=>pane,
 containerPointToLayerPoint:p=>p,latLngToContainerPoint:p=>p.corner==='nw'?{x:extent.left,y:extent.top}:{x:extent.left+extent.width,y:extent.top+extent.height}};
 const L={point:(x,y)=>({x,y}),DomUtil:{setPosition(c,p){c.position=p}},latLngBounds:()=>({getNorthWest:()=>({corner:'nw'}),getSouthEast:()=>({corner:'se'})}),
 Layer:{extend:methods=>class{constructor(){Object.assign(this,methods)} addTo(map){this.onAdd(map);return this}}},imageOverlay:()=>({desktop:true})};
 const c={L,Math,String,Image:class{},radarLightMode:()=>light,
 document:{createElement:()=>{const canvas={width:0,height:0,style:{},dataset:{},remove(){this.parentNode=null},getContext:()=>({clearRect(){},drawImage(...args){drawn.push(args)}})};canvases.push(canvas);return canvas;}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/radar-viewport.js','utf8'),c);
 return {c,map,extent,drawn,canvases,view};
}
test('zooming a country-wide scan to street level keeps the drawing surface screen-sized',()=>{
 const {c,map,extent,drawn,canvases,view}=harness();c.frame={canvas:{width:2048,height:2048,dataset:{radarSource:'fi'}},bounds:[[50,0],[75,40]]};
 const layer=vm.runInContext('radarViewportLayer(frame,.84)',c).addTo(map);
 for(const zoom of [8,12,18]){
  extent.width=extent.height=256*2**zoom;extent.left=extent.top=-extent.width/2;
  layer._reset();assert.equal(canvases[0].width,390);assert.equal(canvases[0].height,844);
  assert.equal(canvases[0].style.width,'390px');assert.equal(canvases[0].style.height,'844px');
  assert.equal(layer.getBounds(),view);
  const args=drawn.at(-1);assert(args[3]>0&&args[3]<2048);assert(args[4]>0&&args[4]<2048);
  assert.equal(args[7],390);assert.equal(args[8],844);
 }
 assert.equal(canvases[0].dataset.radarSource,'fi');
 layer.onRemove(map);assert.equal(canvases[0].width,0);assert.equal(canvases[0].height,0);
 assert.equal(c.frame.canvas.width,2048,'removing a display must preserve reusable source pixels');
});
test('panning entirely outside the scan clears the display and allocates no new canvas',()=>{
 const {c,map,extent,drawn,canvases}=harness();c.frame={image:{naturalWidth:1200,naturalHeight:1200},bounds:[[50,0],[75,40]]};
 const layer=vm.runInContext('radarViewportLayer(frame)',c).addTo(map),before=drawn.length;
 extent.left=10000;layer._reset();assert.equal(drawn.length,before);assert.equal(canvases.length,1);
});
test('large mobile screens have bounded backing pixels and desktop image rendering stays unchanged',()=>{
 const {c,map,canvases}=harness();map.getSize=()=>({x:1200,y:3000});c.frame={canvas:{width:1024,height:1024},bounds:[[50,0],[75,40]]};
 vm.runInContext('radarViewportLayer(frame)',c).addTo(map);
 assert.equal(canvases[0].height,1536);assert(canvases[0].width<=1536);
 const desktop=harness(false);assert.equal(vm.runInContext('radarImageOverlay({},[])',desktop.c).desktop,true);
});
