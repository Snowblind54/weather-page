const {test}=require('node:test');const assert=require('node:assert/strict');
const G=require('../js/warning-geometry.js');
const square=(lat,lon)=>[[lat,lon],[lat,lon+1],[lat+1,lon+1],[lat+1,lon],[lat,lon]];
test('Offscreen alerts are rejected without expanding or changing official coordinates',()=>{
 const source=[square(40,-90),square(59,24)],before=JSON.stringify(source),ds=G.cap(source),view={south:57,north:61,west:21,east:28};
 assert.equal(ds.filter(d=>G.intersects(d.bounds,view)).length,1);assert.equal(ds[0].rings[0],source[0]);assert.equal(JSON.stringify(source),before);
});
test('GeoJSON uses longitude/latitude correctly and keeps holes and islands',()=>{
 const feature={type:'Feature',geometry:{type:'MultiPolygon',coordinates:[[[[24,59],[25,59],[25,60],[24,60],[24,59]],[[24.2,59.2],[24.4,59.2],[24.4,59.4],[24.2,59.4],[24.2,59.2]]],[[[26,59],[26.1,59],[26.1,59.1],[26,59.1],[26,59]]]]}};
 const ds=G.geojson(feature);assert.equal(ds.length,2);assert.equal(ds[0].bounds.west,24);assert.equal(ds[0].bounds.south,59);
 const rings=G.simplified(ds[0],6,24);assert.equal(rings.length,2);assert.deepEqual(rings[0][0],[59,24]);assert.deepEqual(rings[1][0],[59.2,24.2]);
});
test('Boundary detail adapts to zoom, tiny rings survive, and inputs remain immutable',()=>{
 const ring=Array.from({length:2000},(_,i)=>{const a=i*Math.PI*2/1999;return [59+Math.sin(a)*(1+.002*Math.cos(a*200)),24+Math.cos(a)*(1+.002*Math.cos(a*200))];});ring[ring.length-1]=ring[0];
 const before=JSON.stringify(ring),d=G.cap([ring])[0],low=G.simplified(d,3,24)[0],high=G.simplified(d,12,24)[0];assert(low.length<high.length);assert(low.length<ring.length/10);assert.equal(JSON.stringify(ring),before);
 const tiny=square(59,24).map(([lat,lon])=>[59+(lat-59)*.00001,24+(lon-24)*.00001]);assert(G.simplified(G.cap([tiny])[0],2,24)[0].length>=4);
});
test('Date-line warnings match the Alaska viewport without becoming world-spanning polygons',()=>{
 const d=G.cap([[[60,179],[60,-179],[62,-179],[62,179],[60,179]]])[0];
 assert.equal(d.bounds.east-d.bounds.west,2);assert(G.intersects(d.bounds,{south:58,north:64,west:-185,east:-170}));assert(!G.intersects(d.bounds,{south:58,north:64,west:20,east:30}));
 assert(G.simplified(d,6,-175)[0].every(p=>p[1]>=-181&&p[1]<=-179));
});
