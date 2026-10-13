const test=require('node:test'),assert=require('node:assert/strict'),c=require('../js/solar-eruptions.js'),now=Date.parse('2026-10-13T16:00:00Z');
test('Earth-directed filter, rolling seven days, newest first and show all',()=>{
 const rows=[{id:'old',detectedAt:'2026-10-06T15:00Z',earthImpact:'expected'},{id:'miss',detectedAt:'2026-10-13T12:00Z',earthImpact:'not-predicted'},{id:'hit',detectedAt:'2026-10-12T12:00Z',earthImpact:'expected'},{id:'glance',detectedAt:'2026-10-13T10:00Z',earthImpact:'glancing'}];
 assert.deepEqual(c.recent(rows,now).map(x=>x.id),['glance','hit']);assert.deepEqual(c.recent(rows,now,true).map(x=>x.id),['miss','glance','hit']);assert.equal(rows.length,4);
});
test('Approximate countdown never confirms arrival and flags stale forecasts',()=>{
 const r={estimatedArrival:'2026-10-15T20:00Z',earthImpact:'expected'};assert.equal(c.countdown(r,now),'About 2 days 4 h remaining');assert.match(c.countdown(r,now+3*86400000),/arrival unconfirmed/);assert.match(c.countdown(r,now,true),/Forecast stale/);assert.match(c.countdown({earthImpact:'unassessed'},now),/Awaiting/);assert.equal(c.uncertainty({arrivalUncertaintyHours:null}),null);assert.equal(c.uncertainty({arrivalUncertaintyHours:7}),7);
});
test('G0 is zero, missing is unknown, stale G5 is last reported',()=>{
 assert.equal(c.gState({scale:0,time:'2026-10-13T15:59Z'},now).value,'G0');assert.equal(c.gState({scale:null},now).value,'—');const g=c.gState({scale:5,time:'2026-10-13T14:00Z'},now);assert.equal(g.stale,true);assert.match(g.label,/Last reported/);
});
