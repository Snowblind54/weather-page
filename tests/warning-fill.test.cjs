const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
test('Fills reuse existing geometry, preserve holes, sort severity and allocate only one bounded canvas',()=>{
 const calls=[],queue=[],layers=new Set(),panes={warningPane:{style:{zIndex:'625'}}};let watch;
 class Polygon{constructor(color,rings,fill=true){this.options={fill,fillColor:color,fillOpacity:.22};this.rings=rings;}getLatLngs(){return this.rings;}setStyle(style){Object.assign(this.options,style);}bringToFront(){}toGeoJSON(){assert.fail('Geometry was duplicated');}}
 class Circle{}
 function Layer(){}Layer.prototype.addTo=function(m){m.addLayer(this);return this;};Layer.extend=function(methods){function Child(){}Child.prototype=Object.create(Layer.prototype);Object.assign(Child.prototype,methods);return Child;};
 const ctx={setTransform(){},clearRect(){},beginPath(){calls.push(['begin']);},moveTo(){calls.push(['ring']);},lineTo(){},closePath(){},fill(rule){calls.push(['fill',this.fillStyle,rule]);}};
 const canvas={style:{},getContext:()=>ctx,remove(){this.removed=true;}};
 const ring=[{lat:59,lng:24},{lat:59,lng:25},{lat:60,lng:25},{lat:59,lng:24}],hole=[{lat:59.2,lng:24.2},{lat:59.2,lng:24.3},{lat:59.3,lng:24.3},{lat:59.2,lng:24.2}];
 const raw=[ring,hole],orange=new Polygon('#ff8c1a',raw),yellow=new Polygon('#ffd43b',[ring]),marine=new Polygon('#e03131',[ring],false);
 const group={eachLayer(fn){[orange,yellow,marine].forEach(fn);},on(){},addLayer(){},removeLayer(){},clearLayers(){}};layers.add(group);
 const map={createPane:name=>panes[name]={style:{},appendChild(){}},getPane:name=>panes[name],hasLayer:x=>layers.has(x),addLayer(x){layers.add(x);x.onAdd?.(this);},removeLayer(x){x.onRemove?.(this);layers.delete(x);},on(){},off(){},getSize:()=>({x:3000,y:1800}),containerPointToLayerPoint:p=>p,latLngToContainerPoint:p=>({x:p.lng,y:p.lat})};
 const c={map,warningLayerGroup:group,L:{Polygon,Circle,Layer,point:(x,y)=>({x,y}),DomUtil:{setPosition(){}},geoJSON(){assert.fail('A duplicate fill layer was created');}},document:{createElement:()=>canvas},window:{NorthernWarningViewport:{onChange:fn=>watch=fn}},requestAnimationFrame:fn=>queue.push(fn)};
 vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/warning-fill.js','utf8'),c);while(queue.length)queue.shift()();
 const fills=calls.filter(x=>x[0]==='fill');assert.deepEqual(fills.map(x=>x[1]),['#ffd43b','#ff8c1a']);assert(fills.every(x=>x[2]==='evenodd'));assert.equal(calls.filter(x=>x[0]==='ring').length,3);
 assert.equal(orange.getLatLngs(),raw);assert.equal(orange.options.fillOpacity,0);assert.equal(panes.warningFillPane.style.opacity,'.22');assert.equal(canvas.width,1600);assert(canvas.height<=1600);assert.equal(layers.size,2);
 layers.delete(group);watch();while(queue.length)queue.shift()();assert(canvas.removed);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});
