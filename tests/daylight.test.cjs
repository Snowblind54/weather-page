const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const SunCalc=require('../js/vendor/suncalc-1.9.0.js');
const context={SunCalc,Date,Math,Number};vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname+'/../js/daylight-math.js','utf8'),context);
const sun=context.NorthernDaylightMath,rad=Math.PI/180;

test('day/night geometry agrees with solar position across hemispheres and wrapped longitudes',()=>{
 for(const iso of ['2026-03-20T12:00Z','2026-06-21T00:00Z','2026-12-21T18:00Z']){
  const date=new Date(iso),vector=sun.solarVector(date);
  for(const lat of [-89,-60,0,59.44,83,89])for(const lon of [-180,-123,0,24.75,179,540]){
   const expected=SunCalc.getPosition(date,lat,lon).altitude/rad;
   assert(Math.abs(sun.elevation(vector,lat,lon)-expected)<1e-6);
  }
 }
 const date=new Date('2026-03-20T12:00Z'),vector=sun.solarVector(date);
 assert.equal(sun.state(sun.elevation(vector,0,0)),'Daylight');
 assert.equal(sun.state(sun.elevation(vector,0,180)),'Night');
 assert.equal(sun.colour(20)[3],0);assert(sun.colour(-20)[3]>sun.colour(-3)[3]);
});

test('upcoming sunrise and sunset are future events across midnight and the date line',()=>{
 for(const lon of [-179,-123,24.75,179,384.75]){
  const now=new Date('2026-10-12T23:59Z'),events=sun.nextEvents(now,59.44,lon);
  for(const name of ['sunrise','sunset']){
   assert(+events[name]>+now);assert(+events[name]-now<26*3600000);
   assert(Math.abs(SunCalc.getPosition(events[name],59.44,lon).altitude/rad+.833)<.3);
  }
 }
 assert.throws(()=>sun.nextEvents(new Date(),91,0),/Invalid/);
});

test('polar day and night show real future seasonal events instead of invalid dates',()=>{
 for(const [lat,date] of [[69.65,'2026-06-21T12:00Z'],[69.65,'2026-12-21T12:00Z'],[-90,'2026-06-21T12:00Z'],[90,'2026-06-21T12:00Z']]){
  const now=new Date(date),events=sun.nextEvents(now,lat,18.96);
  assert(events.polar);
  for(const key of ['sunrise','sunset']){
   assert(Number.isFinite(+events[key]));assert(+events[key]>+now);assert(+events[key]-now<371*86400000);
  }
 }
});

test('map toggle, map-click priority, minute refresh and removal preserve bounded canvas surfaces',()=>{
 const listeners={},toggle={checked:false,addEventListener:(name,fn)=>listeners[name]=fn},status={};
 const handlers={},pane={style:{},appendChild(c){c.parentNode=this}},container={addEventListener(name,fn,capture){handlers[name]=fn;assert(capture)}};
 let nextTimer,canvas,popup,adds=0,removes=0,paints=0,offset=0;
 const map={createPane(){},getPane:()=>pane,getSize:()=>({x:3000,y:1500}),on(){},off(){},
  containerPointToLayerPoint:p=>p,containerPointToLatLng:p=>({lat:0,lng:p.x/3000*360-180+offset}),
  getContainer:()=>container,mouseEventToLatLng:()=>({lat:59.44,lng:24.75}),
  removeLayer(l){removes++;l.onRemove?.(this)},hasLayer:()=>true};
 const math={solarVector:()=>[1,0,0],elevation:()=>20,colour:()=>[0,0,0,0],longitude:x=>x,
  state:()=> 'Daylight',nextEvents:()=>({sunrise:new Date('2026-10-13T05:00Z'),sunset:new Date('2026-10-12T15:00Z')})};
 const L={point:(x,y)=>({x,y}),DomUtil:{setPosition(c,p){c.position=p}},Layer:{extend:methods=>class{
  constructor(){Object.assign(this,methods)}addTo(m){adds++;this.onAdd(m);return this}}},popup:()=>{
  popup={setLatLng(){return this},setContent(s){this.content=s;return this},openOn(){return this}};return popup}};
 const c={L,map,window:{NorthernDaylightMath:math},$:id=>id==='daylightOn'?toggle:status,Date,Math,Intl,
  requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},setInterval:fn=>{nextTimer=fn},
  document:{hidden:false,addEventListener(){},createElement(){canvas={width:0,height:0,style:{},remove(){},getContext:()=>({
   createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){paints++}})};return canvas}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../js/daylight.js','utf8'),c);
 toggle.checked=true;listeners.change();assert.equal(adds,1);assert.equal(canvas.width,480);assert.equal(canvas.height,240);
 let stopped=false;const click={detail:1,clientX:100,clientY:100,target:{closest:()=>null},stopPropagation(){stopped=true}};
 handlers.click(click);assert(stopped);assert(popup.content.includes('Next sunrise'));assert(popup.content.includes('Times in'));
 const before=paints;nextTimer();assert(paints>before);c.document.hidden=true;const hidden=paints;nextTimer();assert.equal(paints,hidden);
 toggle.checked=false;listeners.change();assert(removes>=1);assert.equal(canvas.width,0);
 stopped=false;handlers.click(click);assert(!stopped,'disabled sunlight layer does not intercept weather clicks');
});
