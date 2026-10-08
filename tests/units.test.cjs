const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('js/units.js','utf8');
function harness(saved){
 const listeners={},events={},controls={temperatureUnits:{addEventListener(type,fn){this.change=fn;}},windUnits:{addEventListener(type,fn){this.change=fn;}}};
 const storage=new Map(saved?[['northernWeatherUnitsV1',saved]]:[]);
 const c={localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},CustomEvent:class{constructor(type){this.type=type;}},document:{getElementById:id=>controls[id],addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn);},dispatchEvent:e=>{for(const fn of listeners[e.type]||[])fn(e);}},map:{closePopup(){events.closed=true;}}};
 vm.createContext(c);vm.runInContext(source,c);return {c,controls,storage,events,change(id,value){controls[id].value=value;controls[id].change();}};
}
test('defaults retain Celsius and m/s, zero is calm, missing values remain unavailable',()=>{
 const h=harness(),u=h.c.WeatherUnits;assert.equal(u.temperature(0),'0.0°C');assert.equal(u.wind(0),'0.0 m/s');
 assert.equal(u.wind(null),'Unavailable');assert.equal(u.temperature(NaN),'Unavailable');
});
test('changing units converts values, redraws immediately and persists independently',()=>{
 const h=harness();let renders=0;h.c.renderOfficialWind=()=>renders++;h.c.officialWindRenderKey='old';
 h.change('temperatureUnits','F');assert.equal(h.c.WeatherUnits.temperature(0),'32.0°F');assert.equal(h.c.WeatherUnits.temperature(-40),'-40.0°F');
 assert.equal(h.c.WeatherUnits.wind(10),'10.0 m/s');
 h.change('windUnits','km/h');assert.equal(h.c.WeatherUnits.wind(10),'36.0 km/h');assert.equal(h.c.WeatherUnits.wind(0),'0.0 km/h');
 assert.equal(renders,2);assert(h.events.closed);assert.equal(h.c.officialWindRenderKey,'');
 const restored=harness(h.storage.get('northernWeatherUnitsV1'));assert.equal(restored.controls.temperatureUnits.value,'F');assert.equal(restored.controls.windUnits.value,'km/h');
 h.change('temperatureUnits','C');assert.equal(h.c.WeatherUnits.temperature(0),'0.0°C');assert.equal(h.c.WeatherUnits.wind(10),'36.0 km/h');
});
test('bad saved preferences fall back safely and storage failure does not block changes',()=>{
 const h=harness('{bad json');assert.equal(h.c.WeatherUnits.temperatureUnit(),'°C');
 h.c.localStorage.setItem=()=>{throw Error('private mode');};h.change('windUnits','km/h');assert.equal(h.c.WeatherUnits.wind(5),'18.0 km/h');
});
