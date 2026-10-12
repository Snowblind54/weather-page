const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
  const listeners={},ids={};
  function element(){return {style:{},children:[],attributes:{},dataset:{},textContent:'',replaceChildren(...children){this.children=children;},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,f){this[k]=f;}};}
  for(const id of ['tempLegendBar','tempLegendTicks','tempLegendUnit','tempColorScale','temperatureUnits','windUnits'])ids[id]=element();
  const c={document:{getElementById:id=>ids[id],createElement:element,addEventListener(k,f){(listeners[k]??=[]).push(f);},dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);}},
    localStorage:{getItem:()=>null,setItem(){}},CustomEvent:class{constructor(type){this.type=type;}},map:{on(){},closePopup(){}},console};
  vm.createContext(c);vm.runInContext(fs.readFileSync('js/units.js','utf8'),c);vm.runInContext(fs.readFileSync('js/temperature.js','utf8'),c);
  return {ids,run:code=>vm.runInContext(code,c),change(value){ids.temperatureUnits.value=value;ids.temperatureUnits.change();}};
}
test('severe cold and extreme heat remain distinct while ordinary temperatures keep their colours',()=>{
  const h=harness(),rgb=t=>JSON.parse(JSON.stringify(h.run(`tempColor(${t})`)));
  assert.notDeepEqual(rgb(-50),rgb(-20));assert.notDeepEqual(rgb(50),rgb(40));
  assert.deepEqual(rgb(0),[49,167,223]);assert.deepEqual(rgb(20),[240,218,59]);
  assert.deepEqual(rgb(-90),rgb(-60));assert.deepEqual(rgb(70),rgb(60));
  assert.deepEqual(rgb(45),[185,31,62]);
});
test('ruler positions describe the actual Celsius colours and convert immediately to Fahrenheit',()=>{
  const h=harness(),labels=()=>h.ids.tempLegendTicks.children.map(x=>x.textContent),positions=()=>h.ids.tempLegendTicks.children.map(x=>x.style.left);
  assert.deepEqual(labels(),['≤-60°','-40°','-20°','0°','20°','40°','≥60°']);
  assert.equal(h.ids.tempLegendTicks.children[3].style.left,'50%');
  assert(h.ids.tempLegendBar.style.background.includes('rgb(49,167,223) 50%'));
  const before=positions();h.change('F');
  assert.deepEqual(labels(),['≤-76°','-40°','-4°','32°','68°','104°','≥140°']);
  assert.equal(h.ids.tempLegendUnit.textContent,'°F');assert.deepEqual(positions(),before);
  assert.match(h.ids.tempColorScale.attributes['aria-label'],/°F.*32°/);
});
