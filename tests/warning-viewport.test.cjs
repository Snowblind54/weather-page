const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const G=require('../js/warning-geometry.js');
const square=(lat,lon)=>[[lat,lon],[lat,lon+1],[lat+1,lon+1],[lat+1,lon],[lat,lon]];
function harness(){
 let view={south:57,north:62,west:20,east:30},zoom=6;const events={},queue=[],constructed=[];let popupCount=0,canvasCount=0;const sharedCanvas={type:"canvas"};
 function FG(){this.initialize();}FG.prototype.initialize=function(){this.children=[];};FG.prototype.clearLayers=function(){this.children=[];};FG.prototype.addLayer=function(layer){this.children.push(layer);};FG.prototype.eachLayer=function(fn){this.children.forEach(fn);};FG.prototype.onAdd=function(){};FG.prototype.onRemove=function(){};
 FG.extend=function(methods){function Group(...args){methods.initialize.apply(this,args);}Group.prototype=Object.create(FG.prototype);Object.assign(Group.prototype,methods);return Group;};
 const map={getBounds:()=>({pad(){return this;},getWest:()=>view.west,getEast:()=>view.east,getSouth:()=>view.south,getNorth:()=>view.north}),getCenter:()=>({lng:(view.west+view.east)/2}),getZoom:()=>zoom,on(names,fn){for(const name of names.split(' '))events[name]=fn;},closePopup(){}};
 const polygon=(coords,options)=>{const child={coords,options,bindPopup(fn){this.content=fn;return this;},bringToFront(){}};constructed.push(child);return child;};
 const bounds=()=>{const points=[];return {extend:p=>points.push(p),isValid:()=>!!points.length,getCenter:()=>({lat:60,lng:24})};};
 const L={canvas:()=>{canvasCount++;return sharedCanvas;},FeatureGroup:FG,polygon,circle:polygon,latLngBounds:bounds,popup:()=>({setLatLng(){return this;},setContent(){popupCount++;return this;},openOn(){return this;}})};
 const context={window:{NorthernWarningGeometry:G},L,map,requestAnimationFrame:fn=>queue.push(fn),Set};vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/../js/warning-viewport.js','utf8'),context);
 return {api:context.window.NorthernWarningViewport,map,constructed,pan(v,z=6){view=v;zoom=z;events.moveend();while(queue.length)queue.shift()();},popupCount:()=>popupCount,canvasCount:()=>canvasCount,flush(){while(queue.length)queue.shift()();},queue};
}
test('An alert with thousands of offscreen parts creates no paths until the viewport reaches it',()=>{
 const h=harness(),source=Array.from({length:3000},()=>square(40,-90)),group=h.api.polygons(source,{fillColor:'#ffd43b'});group.bindPopup(()=>'<p>Official warning</p>');group.onAdd(h.map);
 assert.equal(h.constructed.length,0);h.pan({south:38,north:43,west:-94,east:-86});assert.equal(h.constructed.length,Math.ceil(3000/64));assert(h.constructed.every(p=>p.coords.length<=64));assert.equal(h.constructed.reduce((n,p)=>n+p.coords.length,0),3000);assert.equal(h.constructed[0].options.fillOpacity,0);
 group.onRemove(h.map);assert.equal(group.children.length,0);h.pan({south:57,north:61,west:20,east:30});assert.equal(h.constructed.length,Math.ceil(3000/64));
});
test('Only visible parts share one path, popups remain lazy and offscreen caches are released',()=>{
 const h=harness(),group=h.api.polygons([square(40,-90),square(59,24),square(60,25)],{fillColor:'#ff8c1a'});let calls=0;group.bindPopup(()=>{calls++;return 'warning';});group.warningRecord={country:'USA'};group.onAdd(h.map);
 assert.equal(h.constructed.length,1);assert.equal(h.constructed[0].coords.length,2);assert.equal(h.constructed[0].warningRecord.country,'USA');assert.equal(calls,0);
 group.openPopup();assert.equal(calls,1);assert.equal(h.popupCount(),1);
 h.pan({south:38,north:43,west:-94,east:-86});assert.equal(group.children.length,1);assert.equal(h.constructed.at(-1).coords.length,1);assert.equal(group._descriptors[1].cache.size,0);
});

test('Thousands of warnings share one canvas and cancelled batches cannot reappear',()=>{
 const h=harness(),groups=[];
 for(let i=0;i<2000;i++){const g=h.api.polygons([square(59,24)],{fillColor:'#ffd43b'});g.onAdd(h.map);groups.push(g);}
 assert.equal(h.canvasCount(),1);assert(h.constructed.every(p=>p.options.renderer===h.constructed[0].options.renderer));
 const big=h.api.polygons(Array.from({length:3000},()=>square(59,24)),{});big.onAdd(h.map);
 const before=h.constructed.length;assert(h.queue.length>0);big.onRemove(h.map);h.flush();assert.equal(h.constructed.length,before);
 groups.forEach(g=>g.onRemove(h.map));h.flush();assert(groups.every(g=>g.children.length===0));
});
