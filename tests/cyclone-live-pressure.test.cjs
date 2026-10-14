const test=require('node:test'),assert=require('node:assert/strict'),p=require('../js/cyclone-live-pressure.js');
const start=Date.parse('2026-10-14T06:00Z')/1000;
function frame(time,shift=0){
 const grid={width:9,height:5,west:-2,south:50,dx:.5,dy:.5},b=Buffer.alloc(grid.width*grid.height*2);
 for(let y=0;y<grid.height;y++)for(let x=0;x<grid.width;x++)b.writeUInt16LE(Math.round((1000+grid.west+x*.5-shift)*10),(y*grid.width+x)*2);
 return {time,grid,values:b.toString('base64')};
}
test('pressure interpolation follows a translating analytic field with 1 hPa isobars',()=>{
 const archive={version:1,modelRun:start,frames:[frame(start),frame(start+3600,2)]};
 p.validate(archive,start,start+7200);
 const result=p.frame(archive,start+1800),line=result.lines.find(l=>l.pressure===1000);
 assert.ok(line);assert.ok(line.points.every(([lon])=>Math.abs(lon-1)<1e-6));
 assert.equal(result.time,start+1800);assert.equal(result.interpolated,true);
 assert.equal(p.frame(archive,start+1800),result,'pans reuse the calculated contours');
 assert.equal(p.frame({...archive,modelRun:start+1},start+1800)===result,false,'new snapshots release cached output');
});
test('pressure grids never bridge missing hours or incompatible grids',()=>{
 const a=frame(start),b=frame(start+7200);
 assert.equal(p.canInterpolate({frames:[a,b]},start+1800),false);
 assert.equal(p.frame({frames:[a,b]},start+1800),null);
 b.time=start+3600;b.grid.west=-1;
 assert.equal(p.canInterpolate({frames:[a,b]},start+1800),false);
 assert.equal(p.canInterpolate({frames:[a]},start+1800),false);
});
test('invalid byte values, mixed model runs and oversized grids are rejected',()=>{
 const a=frame(start),archive={version:1,modelRun:start,frames:[a,frame(start+3600)]};
 assert.throws(()=>p.validate({...archive,modelRun:start+3600},start,start+7200));
 assert.throws(()=>p.validate({...archive,frames:[{...a,values:'AAAA'}]},start,start+7200));
 const bytes=Buffer.from(a.values,'base64');bytes.writeUInt16LE(100,0);
 assert.throws(()=>p.validate({...archive,frames:[{...a,values:bytes.toString('base64')}]},start,start+7200));
 assert.throws(()=>p.validate({...archive,frames:[{...a,grid:{...a.grid,width:1000}}]},start,start+7200));
});
test('closed lows produce closed rings without fabricated connections at boundaries',()=>{
 const grid={width:21,height:21,west:-5,south:50,dx:.5,dy:.5},values=[];
 for(let y=0;y<21;y++)for(let x=0;x<21;x++)values.push(990+(-5+x*.5)**2+(-5+y*.5)**2);
 const lines=p.contour(grid,values),ring=lines.find(l=>l.pressure===991);
 assert.ok(ring);assert.deepEqual(ring.points[0],ring.points.at(-1));
 assert.ok(ring.points.every(([x,y])=>Math.abs(Math.hypot(x,y-55)-1)<.06));
 assert.ok(lines.every(l=>l.points.every(pt=>pt.every(Number.isFinite))));
});
