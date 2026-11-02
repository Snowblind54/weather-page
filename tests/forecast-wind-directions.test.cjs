const {test}=require('node:test'),assert=require('node:assert/strict');
const D=require('../js/forecast-wind-directions.js');
const time=Date.parse('2026-11-02T13:00:00Z');
const grid={version:1,time:new Date(time).toISOString(),bounds:[-190,18,-30,84],width:2,height:2,projection:'mercator',convention:'wind_from_degrees',values:[0,90,180,null]};
test('from bearings point down for a northerly and right for a westerly',()=>{
 assert(Math.abs(Math.cos(D.flowAngle(0))+1)<1e-10);
 assert(Math.abs(Math.sin(D.flowAngle(270))-1)<1e-10);
});
test('only matching-hour validated grids are accepted',()=>{
 assert(D.validate(grid,time));assert(!D.validate(grid,time+3600000));
 assert(!D.validate({...grid,values:[360,0,0,0]},time));
 assert(!D.validate({...grid,width:10000},time));
});
test('samples respect no-data, coverage and longitude world copies',()=>{
 assert.equal(D.sample(grid,84,-190),0);assert.equal(D.sample(grid,18,-30),null);
 assert.equal(D.sample(grid,84,170,360),0);assert.equal(D.sample(grid,0,-190),null);
});
test('direction URLs must match the colour frame cycle and selected hour',()=>{
 const key=new Date(time).toISOString(),path='data/forecast-cache/20261102T06Z-precipitation-v2/wind-vectors-20261102T13Z.json';
 const r={images:{wind:{[key]:'data/forecast-cache/20261102T06Z-precipitation-v2/wind-20261102T13Z.webp'}},wind_vectors:{version:1,frames:{[key]:path}}};
 assert.equal(D.asset(r,time),path);assert.equal(D.asset(r,time+3600000),null);
 r.wind_vectors.frames[key]=path.replace('06Z','00Z');assert.equal(D.asset(r,time),null);
});
