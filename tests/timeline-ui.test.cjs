const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('cyclone timeline opens at Now, uses available history and restores weather selection',()=>{
  const els={},now=1800000000;
  const el=id=>els[id]??(els[id]={hidden:true,checked:false,value:'0',min:'0',max:'0',step:'1',textContent:'',style:{},classList:{contains:()=>false,toggle(){}},addEventListener(){},setAttribute(k,v){this[k]=v;},focus(){},replaceChildren(...items){this.children=items;},append(item){this.children.push(item);},getBoundingClientRect:()=>({left:500})});
  const context={Math,Date,Set,Promise,Number,console,$:el,frames:[{time:now-600},{time:now-300},{time:now}],cloudTimelineMode:false,
    window:{innerWidth:1400,addEventListener(){}},document:{querySelectorAll:()=>[],addEventListener(){},querySelector:()=>el('dock'),createElement:()=>({})},
    MutationObserver:class{observe(){}},temperatureEnabled:()=>false,activeAccumulationHours:()=>0,
    cycloneData:{systems:[{history:[{time:now-24*3600}],points:[{time:now},{time:now+48*3600}]}]},cyclonePlaying:false,
    cycloneTrackStart:()=>now,cycloneSelectedTime:()=>now+Number(el('cycloneForecastHour').value)*3600,fmt:String,
    stop(){},stopCyclonePlayback(){},clearTimeout(){},timelineDebounceTimer:null,applyFrame:()=>Promise.resolve(),scheduleCloudPrecache(){},renderCyclones(){},
    updateWeatherTimeline(){el('timeline').max='2';}};
  el('timeline').value='1';el('timeline').max='2';
  vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/../js/ui.js','utf8'),context);
  vm.runInContext("openWeatherPanel('cycloneSection')",context);
  assert.equal(el('timeline').value,0);assert.equal(el('timeline').min,-24);assert.equal(el('timeline').max,48);
  assert.equal(el('timeline')['aria-label'],'Cyclone movement time');
  assert.match(el('timeLabel').textContent,/Now/);
  el('cycloneForecastHour').value=-12;vm.runInContext('updateCycloneTimeline()',context);
  assert.equal(el('timeline').value,-12);assert.match(el('timeLabel').textContent,/-12 h/);
  vm.runInContext('closeWeatherPanel()',context);
  assert.equal(el('timeline').value,1);assert.equal(el('timeline').max,'2');
  assert.equal(el('timeline')['aria-label'],'Weather observation time');
});
