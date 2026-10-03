const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const path=require('node:path');const source=fs.readFileSync(path.join(__dirname,'../js/nordic-radar.js'),'utf8');
function harness(){const c={Map,Set,Date,URL,Number,Array,Object,Promise,console,setTimeout,clearTimeout,map:{on(){}},$:()=>({checked:true,textContent:'',className:''})};vm.createContext(c);vm.runInContext(source,c);return c;}
test('timeline picks only observations at or before the selected time and rejects stale/future frames',()=>{
 const c=harness();c.records=[{time:100},{time:400},{time:700}];
 assert.equal(vm.runInContext('radarObservationAt(records,650).time',c),400);
 assert.equal(vm.runInContext('radarObservationAt(records,50)',c),null);
 assert.equal(vm.runInContext('radarObservationAt(records,2000)',c),null);
});
test('official file URLs are restricted to known providers and midnight dates are UTC',()=>{
 const c=harness();assert.equal(vm.runInContext("trustedNordicRadarUrl('https://rgw.met.no/a.tif')",c),true);
 for(const url of ['https://evil.example/image.h5','http://brunnur.vedur.is/a.h5','https://rgw.met.no.evil.example/a.tif']){c.url=url;assert.equal(vm.runInContext('trustedNordicRadarUrl(url)',c),false);}
 const first=Date.parse('2026-10-03T23:55Z')/1000,last=Date.parse('2026-10-04T00:05Z')/1000;c.first=first;c.last=last;
 assert.equal(vm.runInContext('radarUtcDays(first,last).join(",")',c),'2026-10-03,2026-10-04');
});
test('physical radar values preserve nodata and undetect; reflectivity becomes estimated rain rate',async()=>{
 const m=await import('../js/radar-grid.mjs');
 const grid={quantity:'DBZH',gain:.5,offset:-32,nodata:255,undetect:0};
 assert(Number.isNaN(m.radarRate(255,grid)));assert(Number.isNaN(m.radarRate(0,grid)));
 assert(Math.abs(m.radarRate(110,grid)-1)<.002);
 assert.equal(m.radarRate(20,{quantity:'RATE',gain:.01,nodata:65535,undetect:0}),.2);
 assert.deepEqual(m.radarColour(m.radarRate(65535,{quantity:'RATE',gain:.01,nodata:65535})),[0,0,0,0]);
});
test('polar rays wrap around north; range and rectangular-grid edges stay transparent',async()=>{
 const m=await import('../js/radar-grid.mjs');const lookup=m.makeRayLookup([359,0,90],[360,1,91]);assert.equal(lookup[3595],0);assert.equal(lookup[5],1);assert.equal(lookup[905],2);assert.equal(lookup[1800],-1);
 const g={width:10,height:360,rstart:0,rscale:1000,rayLookup:lookup};assert.equal(m.polarIndex(0,1500,g),11);assert.equal(m.polarIndex(1500,0,g),21);assert.equal(m.polarIndex(0,11000,g),-1);
 const r={left:0,top:20,dx:1,dy:1,width:10,height:10};assert.equal(m.cartesianIndex(.5,19.5,r),0);assert.equal(m.cartesianIndex(10,19,r),-1);
});
test('Norwegian WKT2 parameters retain the native grid projection and Mercator latitude round-trips',async()=>{
 const m=await import('../js/radar-grid.mjs');const names=['Latitude of false origin','Longitude of false origin','Latitude of 1st standard parallel','Latitude of 2nd standard parallel','Easting at false origin','Northing at false origin'];
 const wkt='PROJCRS["WGS 84",METHOD["Lambert Conic Conformal (2SP)"],'+names.map((name,i)=>`PARAMETER["${name}",${[0,0,58.964,69.987,0,0][i]}]`).join(',')+']';
 assert.match(m.radarProjection(wkt),/lat_1=58.964/);assert.match(m.radarProjection(wkt),/lon_0=0/);assert.throws(()=>m.radarProjection('PROJCRS["unsupported"]'));
 for(const lat of [54,64,74])assert(Math.abs(m.latitudeAtY(m.mercatorY(lat))-lat)<1e-10);
});
