const test=require('node:test'),assert=require('node:assert/strict'),Cache=require('../js/decoded-image-cache.js');
function image(){return {width:256,height:256,closed:0,close(){this.closed++}};}
test('Concurrent crops share one decode and a later viewport reuses it',async()=>{
 const cache=new Cache({maxBytes:1024*1024});let calls=0;const bitmap=image(),load=async()=>{calls++;return bitmap;};
 const [a,b]=await Promise.all([cache.acquire('immutable',load),cache.acquire('immutable',load)]);assert.equal(calls,1);assert.equal(a.image,b.image);a.release();b.release();
 const next=await cache.acquire('immutable',load);assert.equal(calls,1);next.release();assert.equal(bitmap.closed,0);
});
test('Budget eviction closes idle resources, never an image still being drawn',async()=>{
 const cache=new Cache({maxBytes:256*256*4});const x=image(),y=image();const a=await cache.acquire('a',()=>x),b=await cache.acquire('b',()=>y);
 assert.equal(x.closed,0);assert.equal(y.closed,0);a.release();assert.equal(x.closed,1);assert.equal(y.closed,0);b.release();assert.equal(cache.bytes(),256*256*4);
 cache.clear();assert.equal(y.closed,1);assert.equal(cache.bytes(),0);
});
test('Disable while decode is pending retires the bitmap after its last draw',async()=>{
 const cache=new Cache({maxBytes:1024*1024});let resolve;const x=image(),p=cache.acquire('a',()=>new Promise(r=>resolve=r));await Promise.resolve();cache.clear();resolve(x);const a=await p;
 assert.equal(x.closed,0);a.release();a.release();assert.equal(x.closed,1);assert.equal(cache.bytes(),0);
});
test('A failed decode can retry; frame memory reduces the radar tile allowance',async()=>{
 let budget=1024*1024;const cache=new Cache({maxBytes:()=>budget});await assert.rejects(cache.acquire('a',()=>Promise.reject(Error('bad'))));const x=image(),a=await cache.acquire('a',()=>x);a.release();budget=0;cache.trim();assert.equal(x.closed,1);assert.equal(cache.bytes(),0);
});
