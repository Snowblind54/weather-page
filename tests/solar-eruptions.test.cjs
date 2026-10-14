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

test('Arrivals remain for four hours, then expire even with show all',()=>{
 const rows=[
  {id:'expired',detectedAt:'2026-10-12T12:00Z',estimatedArrival:'2026-10-13T12:00Z',earthImpact:'expected'},
  {id:'older',detectedAt:'2026-10-12T12:00Z',estimatedArrival:'2026-10-13T11:59Z',earthImpact:'expected'},
  {id:'recent',detectedAt:'2026-10-12T12:00Z',estimatedArrival:'2026-10-13T12:01Z',earthImpact:'expected'},
  {id:'now',detectedAt:'2026-10-12T12:00Z',estimatedArrival:'2026-10-13T16:00Z',earthImpact:'expected'},
  {id:'future',detectedAt:'2026-10-12T12:00Z',estimatedArrival:'2026-10-14T12:00Z',earthImpact:'expected'}];
 assert.deepEqual(c.recent(rows,now).map(r=>r.id),['recent','now','future']);
 assert.deepEqual(c.recent(rows,now,true).map(r=>r.id),['recent','now','future']);
 assert.match(c.countdown(rows[2],now),/arrival unconfirmed/);
 assert.deepEqual(c.recent([rows[3]],now+4*3600000),[]);
});

const shock={code:'WARSUD',kind:'upstream',issuedAt:'2026-10-13T15:10Z',shockAt:'2026-10-13T15:05Z',validFrom:'2026-10-13T15:15Z',validTo:'2026-10-13T15:50Z'};
const impulse={code:'SUMSUD',kind:'observed',issuedAt:'2026-10-13T15:40Z',observedAt:'2026-10-13T15:30Z'};
const feed=entries=>({fetchedAt:now/1000,entries});
test('upstream shock stays unconfirmed after forecast window; ground report confirms observation',()=>{
 assert.equal(c.arrivalState(feed([shock]),now).kind,'upstream');
 assert.equal(c.arrivalState(feed([shock,impulse]),now).kind,'observed');
 assert.equal(c.arrivalState(feed([shock,impulse]),now).report,impulse);
 assert.equal(c.countdown({estimatedArrival:'2026-10-13T15:20Z'},now).includes('unconfirmed'),true);
});
test('new upstream shock supersedes an older ground impulse; cancellation clears warning',()=>{
 const later={...shock,issuedAt:'2026-10-13T15:55Z',shockAt:'2026-10-13T15:50Z'};
 assert.equal(c.arrivalState(feed([later,impulse]),now).kind,'upstream');
 const cancelled={code:'WARSUD',kind:'cancelled',issuedAt:'2026-10-13T15:59Z'};
 assert.equal(c.arrivalState(feed([later,cancelled]),now).kind,'none');
});
test('arrival indicators expire at four hours and flag retained stale reports',()=>{
 const after=Date.parse(impulse.observedAt)+4*3600000;
 assert.equal(c.arrivalState({fetchedAt:after/1000,entries:[impulse]},after).kind,'none');
 assert.equal(c.arrivalState(undefined,now).kind,'unknown');
 assert.equal(c.arrivalState({fetchedAt:(now-3600000)/1000,entries:[impulse]},now).stale,true);
 assert.equal(c.arrivalState(feed([]),now).kind,'none');
 const future={...impulse,observedAt:'2026-10-13T17:00Z'};
 assert.equal(c.arrivalState(feed([future]),now).kind,'none');
 assert.equal(c.arrivalState(feed([{...shock,validTo:'invalid'}]),now).kind,'none');
});
