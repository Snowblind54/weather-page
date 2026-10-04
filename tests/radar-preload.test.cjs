const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/radar-capture.js'),'utf8');
function harness({saveData=false}={}){
 const toggle={checked:false},events={},timers=[];
 const c={console,Promise,Date,Set,window:{},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn},navigator:{connection:{saveData}},$:()=>toggle,
 setTimeout:(fn,ms)=>{if(ms===80){queueMicrotask(fn);return 0}timers.push({fn,ms});return timers.length},clearTimeout:()=>{},
 map:{on:(name,fn)=>events[name]=fn,getBounds:()=>({intersects:b=>b.visible})},L:{latLngBounds:b=>b},
 NORDIC_RADAR_SOURCES:[{id:'fi'},{id:'is'}],nordicRadarVisible:s=>s.id==='fi',nordicRadarEdge:()=>900,
 RADAR_BOUNDS:{visible:true},frames:[{time:1000,url:'ee',id:'ee'}],radarTimelineFrames:[{time:400,url:'ee0'},{time:700,url:'ee1'},{time:1000,url:'ee2'}],
 visibleBalticRadarSources:()=>[{id:'lt'}],listNordicRadar:async()=>[{station:'fi',time:400},{station:'fi',time:700},{station:'fi',time:1000}],
 radarObservationAt:(records,time)=>records.filter(r=>r.time<=time&&time-r.time<=900).at(-1),
 nordicRadarFrame:async()=>{},h5ToRadarImage:async()=>{},prepareBalticRadarFrame:async()=>{},};
 vm.createContext(c);vm.runInContext(source,c);return {c,toggle,events,timers};
}
test('preload prepares visible latest frames before history without changing timeline or enabling radar',async()=>{
 const {c,toggle}=harness(),calls=[];c.nordicRadarFrame=async(r,e,o)=>{assert(o.background);assert(o.canPrepare());calls.push(['fi',r.time]);};
 c.h5ToRadarImage=async(f,o)=>{assert(o.quiet);calls.push(['ee',f.time]);};c.prepareBalticRadarFrame=async(s,time)=>calls.push([s.id,time]);
 await vm.runInContext('preloadVisibleRadars()',c);
 assert.deepEqual(calls.slice(0,3).map(x=>x[1]),[1000,1000,1000]);
 assert.equal(calls.length,9);assert(calls.every(x=>x[0]!=='is'));assert.equal(toggle.checked,false);assert.equal(c.frames[0].time,1000);
});
test('hidden tabs do no work; enabling radar midway skips background history',async()=>{
 const {c,toggle}=harness();let reads=0;c.listNordicRadar=async()=>{reads++;return [{station:'fi',time:1000}]};
 c.document.hidden=true;await vm.runInContext('preloadVisibleRadars()',c);assert.equal(reads,0);
 c.document.hidden=false;c.nordicRadarFrame=async()=>{toggle.checked=true};let histories=0;c.prepareBalticRadarFrame=async(s,time)=>{if(time<1000)histories++};
 await vm.runInContext('preloadVisibleRadars()',c);assert.equal(reads,1);assert.equal(histories,0);
});
test('data-saving connections prepare latest only, and map movement invalidates old preparation',async()=>{
 const {c,events,timers}=harness({saveData:true});let renders=0;c.nordicRadarFrame=async()=>renders++;
 await vm.runInContext('preloadVisibleRadars()',c);assert.equal(renders,1);
 assert.equal(vm.runInContext('radarPreloadAllowed(radarPreloadGeneration)',c),true);
 c.old=vm.runInContext('radarPreloadGeneration',c);events.moveend();assert.equal(vm.runInContext('radarPreloadAllowed(old)',c),false);assert.equal(timers.at(-1).ms,1200);
});
test('Estonian activation shares an unfinished background conversion and reuses the completed image',async()=>{
 const c={Map,Set,Promise,Date,URL,console};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/radar.js'),'utf8'),c);
 c.radarImageCache=new Map();c.frame={id:'ee-current',url:'official.h5',time:1000};let preparations=0,finish;
 c.prepareKaiaRadarImage=(f,o)=>{preparations++;assert(o.quiet);return new Promise(resolve=>finish=()=>{c.radarImageCache.set(f.id,'data:prepared');resolve('data:prepared')})};
 const background=vm.runInContext('h5ToRadarImage(frame,{quiet:true})',c),foreground=vm.runInContext('h5ToRadarImage(frame)',c);
 assert.equal(background,foreground);finish();await background;
 assert.equal(await vm.runInContext('h5ToRadarImage(frame)',c),'data:prepared');assert.equal(preparations,1);
});
test('Baltic activation shares unfinished history preparation',async()=>{
 const c={Map,Set,Promise,Date,console};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/radar-history.js'),'utf8'),c);
 let calls=0,finish;c.ltHistory=()=>{calls++;return new Promise(resolve=>finish=resolve)};
 const a=vm.runInContext("prepareBalticRadarFrame({id:'lt'},1000,1000)",c),b=vm.runInContext("prepareBalticRadarFrame({id:'lt'},1000,1000)",c);
 assert.equal(a,b);finish({dataUrl:'data:prepared',time:1000});await a;assert.equal(calls,1);
});
