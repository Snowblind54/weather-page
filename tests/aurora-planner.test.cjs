const {test}=require('node:test');
const assert=require('node:assert/strict');
const D=require('../js/aurora-planner-data.js');
const Land=require('../js/aurora-planner-land.js');
const fs=require('node:fs');
const SunCalc=require('../js/vendor/suncalc-1.9.0.js');
const hour=3600000,now=Date.parse('2026-10-13T12:00:00Z');
const meta=()=>({version:1,asset_version:'cloud-v1',resolution:.25,reference_time:new Date(now).toISOString(),grids:Array.from({length:12},(_,i)=>({bounds:[-180+i*30,35,-150+i*30,90],width:121,height:221,path:`data/aurora-planner-cloud/20261013T12Z-cloud-v1/cloud-${i}-v1.json`}))});
const grid=(cloud=20,band=6)=>({...meta().grids[band],version:1,reference_time:meta().reference_time,resolution:.25,encoding:'uint8-base64',missing:255,samples:Array.from({length:25},(_,i)=>({time:new Date(now+i*3*hour).toISOString(),values:Buffer.alloc(121*221,cloud).toString('base64')}))});
const snapshot=(kp=5)=>({kpForecast:{fetchedAt:now/1000,bins:Array.from({length:24},(_,i)=>({start:new Date(now+i*3*hour).toISOString(),end:new Date(now+(i+1)*3*hour).toISOString(),value:kp,kind:'predicted'}))}});
const point={lat:59.4,lon:24.7,distance:0};
function ranked({cloud=20,kp=5,altitude=()=>-25,s=snapshot(kp)}={}){const g=D.decodeGrid(grid(cloud),meta(),6);return D.rank({points:[point],grids:new Map([[6,g]]),snapshot:s,now,altitude});}
test('Native clouds interpolate in time, keep valid zero, and refuse missing or out-of-range data',()=>{
 const g=grid(0);g.samples[1].values=Buffer.alloc(121*221,60).toString('base64');const decoded=D.decodeGrid(g,meta(),6);
 assert.equal(D.cloudAt(decoded,point,now),0);assert.equal(D.cloudAt(decoded,point,now+1.5*hour),30);
 assert.equal(D.cloudAt(decoded,point,now-hour),null);assert.equal(D.cloudAt(decoded,point,now+73*hour),null);
 assert.equal(D.cloudAt(D.decodeGrid(grid(255),meta(),6),point,now),null);
});
test('Cloud manifests refuse unknown URLs, cycles, corrupt dimensions and percentages',()=>{
 D.validateManifest(meta());const m=meta();m.grids[0].path='https://example.com/data.json';assert.throws(()=>D.validateManifest(m));
 const g=grid();g.samples[0].values=Buffer.alloc(121*221,101).toString('base64');assert.throws(()=>D.decodeGrid(g,meta(),6));
 g.samples[0].values='bad';assert.throws(()=>D.decodeGrid(g,meta(),6));
});
test('Dark clear conditions rank above overcast, daylight is excluded, weak activity is labelled',()=>{
 assert(ranked().windows[0].score>ranked({cloud:90}).windows[0].score);
 assert.equal(ranked({altitude:()=>5}).windows.length,0);
 assert.equal(ranked({kp:0}).windows[0].label,'Weak activity signal');
});
test('Forecast Kp is not extrapolated and stale feeds never create viewing windows',()=>{
 const s=snapshot();s.kpForecast.fetchedAt-=13*3600;assert.equal(ranked({s}).windows.length,0);
 assert.equal(D.kpAt(snapshot(),now+100*hour,now),null);
 const s2=snapshot();s2.kpForecast.bins[0].value=0;assert.equal(D.kpAt(s2,now,now),0);
});
test('Nearby samples cross the date line safely and result windows do not overlap',()=>{
 const points=D.nearby({lat:65,lon:179.95},100);assert.equal(points.length,9);assert(points.some(p=>p.lon<0));assert(points.every(p=>p.lon>=-180&&p.lon<180));
 const windows=ranked().windows;assert.equal(windows.length,3);for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)assert(windows[i].end<=windows[j].start||windows[j].end<=windows[i].start);
});
test('Real solar geometry excludes polar summer and finds dark autumn windows in Tallinn',()=>{
 const altitude=(t,p)=>SunCalc.getPosition(new Date(t),p.lat,p.lon).altitude*180/Math.PI;
 const windows=ranked({altitude}).windows;assert(windows.length);assert(windows.every(w=>altitude(w.start,w.point)<-12&&altitude(w.end,w.point)<-12));
 assert.equal(ranked({altitude:(t,p)=>SunCalc.getPosition(new Date('2026-06-21T12:00:00Z'),89,0).altitude*180/Math.PI}).windows.length,0);
});

test('Land verification rejects holes, water bodies and ocean, including date-line rings',()=>{
 const square=(a,b,c,d)=>[[[a,b],[c,b],[c,d],[a,d],[a,b]]];
 const land=Land.compile({version:1,land:[square(-10,35,10,70),square(170,50,190,70)],water:[square(-1,50,1,52)]});
 assert(land({lat:60,lon:0}));assert(!land({lat:51,lon:0}));assert(!land({lat:60,lon:30}));assert(land({lat:60,lon:-175}));
 const withHole=Land.compile({version:1,land:[[...square(-10,35,10,70),...square(-1,50,1,52)]],water:[]});assert(!withHole({lat:51,lon:0}));
 const actual=Land.compile(JSON.parse(fs.readFileSync(__dirname+'/../assets/aurora-land-v1.json','utf8')));
 assert(actual({lat:59.437,lon:24.754}));assert(!actual({lat:59.887,lon:24.754}));assert(!actual({lat:58.55,lon:27.55}));assert(!actual({lat:47.7,lon:-87}));assert(actual({lat:65,lon:-19}));
 assert.throws(()=>Land.compile({version:1,land:[],water:[]}));
});

test('The hourly cloud timeline keeps missing forecasts explicit and does not extrapolate',()=>{
 const g=D.decodeGrid(grid(),meta(),6),rows=D.cloudTimeline({grid:g,point,snapshot:snapshot(),now,altitude:()=>-25});
 assert.equal(rows.length,49);assert(rows.every(r=>r.dark));assert.equal(rows[0].cloud,20);assert.equal(rows[48].time,now+48*hour);
 const late=D.cloudTimeline({grid:g,point,snapshot:snapshot(),now:now+60*hour,altitude:()=>0});assert(late.some(r=>r.cloud===null));assert(late.every(r=>!r.dark));
});

test('Planning confidence drops with long lead times and variable clouds, without pretending ensemble agreement',()=>{
 const g=D.decodeGrid(grid(),meta(),6),s=snapshot();
 const c=D.planningConfidence({grid:g,point,time:now+6*hour,snapshot:s,now});assert.equal(c.label,'Moderate');assert.match(c.reason,/single cloud model/);
 assert.equal(D.planningConfidence({grid:g,point,time:now+36*hour,snapshot:s,now}).label,'Limited');
 g.samples[1].values.fill(95);assert.equal(D.planningConfidence({grid:g,point,time:now,snapshot:s,now}).label,'Limited');
});

function liveSnapshot(){return {...snapshot(),generatedAt:now/1000,aurora:{latMin:35,latMax:90,width:360,height:56,values:Array(360*56).fill(80),observationTime:new Date(now-10*60000).toISOString(),forecastTime:new Date(now+20*60000).toISOString()},solarWind:{speed:550,bz:-6,speedTime:new Date(now-5*60000).toISOString(),magTime:new Date(now-5*60000).toISOString(),bzHistory:[[-25,-1],[-20,-2],[-15,-5],[-10,-6],[-5,-7]].map(([m,v])=>[new Date(now+m*60000).toISOString(),v])}};}
test('Go now needs darkness, clearer skies and fresh live inputs; stale wind never gives a go signal',()=>{
 const g=D.decodeGrid(grid(),meta(),6),s=liveSnapshot(),inputs={point,grid:g,snapshot:s,now,altitude:()=>-25};
 const good=D.goNow(inputs);assert.equal(good.label,'Worth heading out now');assert.equal(good.trend,'Turning more southward');
 assert.equal(D.goNow({...inputs,altitude:()=>5}).label,'Not dark enough yet');
 assert.equal(D.goNow({...inputs,grid:D.decodeGrid(grid(95),meta(),6)}).label,'Clouds limit viewing');
 s.solarWind.magTime=new Date(now-40*60000).toISOString();const stale=D.goNow(inputs);assert.equal(stale.label,'Wait for fresh live data');assert.equal(stale.fresh,false);assert.equal(stale.bz,null);
});
test('Go now handles missing aurora grids, northward Bz, zero readings and stale aurora forecast explicitly',()=>{
 const g=D.decodeGrid(grid(0),meta(),6),s=liveSnapshot(),inputs={point,grid:g,snapshot:s,now,altitude:()=>-25};
 s.solarWind.bz=0;s.solarWind.speed=0;assert.equal(D.goNow(inputs).label,'Watch conditions closely');assert.equal(D.goNow(inputs).speed,0);
 s.aurora.forecastTime=new Date(now-2*hour).toISOString();assert.equal(D.goNow(inputs).label,'Wait for fresh live data');
 delete s.aurora;assert.equal(D.goNow(inputs).fresh,false);assert.equal(D.auroraAt(s,point),null);
});
