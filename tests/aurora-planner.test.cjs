const {test}=require('node:test');
const assert=require('node:assert/strict');
const D=require('../js/aurora-planner-data.js');
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
