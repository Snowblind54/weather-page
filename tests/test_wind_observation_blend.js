const assert=require('assert');
const blend=require('../js/wind-observation-blend.js');

function near(actual,expected,tolerance=0.05){
  assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} not within ${tolerance} of ${expected}`);
}

assert.strictEqual(blend.ageWeight(0),1);
assert.strictEqual(blend.ageWeight(30*60),1);
assert.strictEqual(blend.ageWeight(3*60*60),0);
assert.ok(blend.ageWeight(2*60*60)>0&&blend.ageWeight(2*60*60)<1);

const fresh=blend.makeCorrection(59.4,24.7,20,10,5*60);
assert.ok(fresh);
near(blend.adjustSpeed(10,59.4,24.7,[fresh]),20);
near(blend.adjustSpeed(10,58.7,24.7,[fresh]),10,0.2);
assert.strictEqual(blend.makeCorrection(59.4,24.7,20,10,4*60*60),null);

const capped=blend.makeCorrection(59.4,24.7,60,5,0);
assert.strictEqual(capped.delta,blend.MAX_ABS_DELTA);

const a=blend.makeCorrection(59.4,24.6,14,10,0);
const b=blend.makeCorrection(59.4,24.8,6,10,0);
near(blend.adjustSpeed(10,59.4,24.7,[a,b]),10,0.25);

console.log('wind observation blend tests passed');
