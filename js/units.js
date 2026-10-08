// Display preferences only: source data, colour scales and calculations stay in native units.
(function(){
  'use strict';
  const key='northernWeatherUnitsV1';
  let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch(_){}
  const state={temperature:saved.temperature==='F'?'F':'C',wind:saved.wind==='km/h'?'km/h':'m/s'};
  const temperatureValue=value=>Number.isFinite(value)?(state.temperature==='F'?value*9/5+32:value):null;
  const windValue=value=>Number.isFinite(value)?(state.wind==='km/h'?value*3.6:value):null;
  const number=(value,digits)=>value===null?'Unavailable':(digits===0?String(Math.round(value)):value.toFixed(digits));
  globalThis.WeatherUnits={
    temperatureValue,windValue,
    temperatureUnit:()=>state.temperature==='F'?'°F':'°C',windUnit:()=>state.wind,
    temperature:(value,digits=1)=>number(temperatureValue(value),digits)+(Number.isFinite(value)?(state.temperature==='F'?'°F':'°C'):''),
    wind:(value,digits=1)=>number(windValue(value),digits)+(Number.isFinite(value)?' '+state.wind:'')
  };
  for(const [id,field] of [['temperatureUnits','temperature'],['windUnits','wind']]){
    const select=document.getElementById(id);if(!select)continue;select.value=state[field];
    select.addEventListener('change',()=>{
      state[field]=select.value;
      try{localStorage.setItem(key,JSON.stringify(state));}catch(_){}
      document.dispatchEvent(new CustomEvent('weather-units-change'));
    });
  }
  document.addEventListener('weather-units-change',()=>{
    if(typeof map!=='undefined')map.closePopup();
    if(typeof showWindLegend==='function')showWindLegend();
    if(typeof renderOfficialWind==='function'){officialWindRenderKey='';renderOfficialWind();}
    const frame=typeof frames!=='undefined'?frames[Number(document.getElementById('timeline')?.value)]:null;
    if(frame&&typeof renderTemperatureLabels==='function')renderTemperatureLabels(frame.time);
    const status=document.getElementById('tempStatus');
    try{
      const range=JSON.parse(status?.dataset.unitRange||'null');
      if(range)status.textContent=status.textContent.replace(/-?\d+(?:\.\d+)?°[CF] to -?\d+(?:\.\d+)?°[CF]/,WeatherUnits.temperature(range[0])+' to '+WeatherUnits.temperature(range[1]));
    }catch(_){}
    if(typeof renderCyclones==='function'&&document.getElementById('cycloneOn')?.checked)renderCyclones();
  });
})();
