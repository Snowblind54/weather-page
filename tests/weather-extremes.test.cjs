const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {summarize}=require('../js/weather-extremes-data.js');
const now=1800000000;
const station=(name,extra={})=>({country:'EE',code:name,name,lat:59,lon:25,...extra});
const pick=(data,id,options={})=>summarize(data,{now,...options}).find(r=>r.id===id);
test('temperatures rank each station’s newest valid reading, not its historical extremes',()=>{
 const temperature={stations:[station('North',{rows:[[now-3600,-30],[now-60,5]]}),station('South',{rows:[[now-120,10]]}),station('Expired',{rows:[[now-96*60,60]]}),station('Future',{rows:[[now+1,-80]]}),station('Missing',{rows:[[now,null]]})]};
 assert.equal(pick({temperature},'cold').winner.name,'North');assert.equal(pick({temperature},'cold').winner.value,5);
 assert.equal(pick({temperature},'warm').winner.value,10);assert.equal(pick({temperature},'warm').count,2);
});
test('sustained wind and gusts rank independently and preserve reporting periods',()=>{
 const wind={sources:{EE:{name:'Official service',period:'10 minute mean',timeKind:'feed'}},stations:[station('Mean',{rows:[[now-60,20,null,10],[now-120,5,25,20]]}),station('Gust',{rows:[[now-60,10,30,20]]}),station('Old',{rows:[[now-10801,90,95,10]]})]};
 assert.equal(pick({wind},'wind').winner.value,20);assert.equal(pick({wind},'gust').winner.name,'Gust');
 assert.equal(pick({wind},'wind').winner.period,'10 minute mean');assert.equal(pick({wind},'wind').winner.timeKind,'feed');
});
test('24-hour precipitation requires every hourly measurement and never includes future hours',()=>{
 const end=Math.floor(now/3600)*3600,times=Array.from({length:24},(_,i)=>end-(23-i)*3600),amounts=Array(24).fill(2);
 const complete=station('Complete',{times,amounts});
 const rain={stations:[complete,station('Gap',{times:times.filter((_,i)=>i!==6),amounts:amounts.slice(1).fill(10)}),station('Future',{times:times.map(t=>t+3600),amounts:Array(24).fill(20)})]};
 assert.equal(pick({rain},'rain').winner.value,48);assert.equal(pick({rain},'rain').count,1);assert.equal(pick({rain},'rain').winner.time,end);
 const missing=station('Missing',{times,amounts:[...amounts.slice(1),null]});assert.equal(pick({rain:{stations:[missing]}},'rain').winner,null);
});
test('published Iceland totals and slightly delayed gauges retain the actual window end',()=>{
 const end=Math.floor(now/3600)*3600-3600;
 const s=station('Iceland',{country:'IS',times:[],amounts:[],accumulations:[{end,hours:24,value:100},{end:now+3600,hours:24,value:500}]});
 assert.equal(pick({rain:{stations:[s]}},'rain').winner.time,end);assert.equal(pick({rain:{stations:[s]}},'rain').winner.value,100);
 assert.equal(pick({rain:{stations:[{...s,accumulations:[{end:end-3*3600,hours:24,value:100}]}]}},'rain').winner,null);
});
test('snow rejects stale, future and nonnumeric trace states while retaining measured zero',()=>{
 const snow={stations:[station('Current',{time:now-3600,depthCm:0}),station('Trace',{time:now-3600,depthCm:null,state:'trace'}),station('Old',{time:now-36*3600-1,depthCm:500}),station('Future',{time:now+1,depthCm:900})]};
 assert.equal(pick({snow},'snow').winner.value,0);assert.equal(pick({snow},'snow').count,1);
});
test('country and viewport filters include equivalent world copies and deduplicate stations',()=>{
 const temperature={stations:[station('East',{country:'CA',lon:-175,rows:[[now-60,5]]}),station('West',{country:'CA',lon:175,rows:[[now-60,6]]}),station('Outside',{country:'CA',lon:-100,rows:[[now-60,50]]}),station('UK',{country:'GB',rows:[[now-60,10]]})]};
 assert.equal(pick({temperature},'warm',{country:'CA',bounds:{west:170,east:190,south:40,north:70}}).count,2);
 assert.equal(pick({temperature},'warm',{country:'UK'}).winner.name,'UK');
 temperature.stations.push({...temperature.stations[0]});assert.equal(pick({temperature},'warm').count,4);
});
test('an unavailable feed does not remove other leaders and tied winners are deterministic',()=>{
 const temperature={stations:[station('B',{rows:[[now-60,5]]}),station('A',{rows:[[now-60,5]]})]};
 const results=summarize({temperature},{now});assert.equal(results[0].winner.name,'A');assert.equal(results.find(x=>x.id==='wind').winner,null);
});
test('panel loads lazily, tolerates one failed feed, and rerenders saved wind units',async()=>{
 class Element{constructor(){this.children=[];this.listeners={};this.value='all';this.open=false;this.hidden=false;this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}addEventListener(type,fn){this.listeners[type]=fn;}}
 const ids=Object.fromEntries(['weatherExtremes','weatherExtremesList','weatherExtremesStatus','weatherExtremesScope','weatherExtremesRefresh','warningSection'].map(id=>[id,new Element()]));
 const events={},calls=[],time=Date.now()/1000;
 const c={WeatherExtremesData:require('../js/weather-extremes-data.js'),AbortSignal,Date,Set,Map,Promise,console,MutationObserver:class{observe(){}},setInterval(){},map:{on(){}},document:{hidden:false,getElementById:id=>ids[id],createElement:()=>new Element(),addEventListener:(e,fn)=>events[e]=fn},WeatherUnits:{wind:n=>(n/0.44704).toFixed(1)+' mph'},fetch:async url=>{
  calls.push(url);if(url.includes('rainfall'))throw Error('offline');
  return {ok:true,json:async()=>({stations:url.includes('wind')?[station('Wind',{rows:[[time-60,10,15,0]]})]:[]})};
 }};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/weather-extremes.js','utf8'),c);
 assert.equal(calls.length,0);ids.weatherExtremes.open=true;ids.weatherExtremes.listeners.toggle();await new Promise(setImmediate);
 assert.equal(calls.length,4);assert.match(ids.weatherExtremesStatus.textContent,/1 of 4/);
 const wind=ids.weatherExtremesList.children[2];assert.equal(wind.children[0].children[1].textContent,'22.4 mph');
 c.WeatherUnits.wind=n=>n.toFixed(1)+' m/s';events['weather-units-change']();assert.equal(ids.weatherExtremesList.children[2].children[0].children[1].textContent,'10.0 m/s');
 ids.weatherExtremes.listeners.toggle();assert.equal(calls.length,4,'cached reopening does not download snapshots again');
});
