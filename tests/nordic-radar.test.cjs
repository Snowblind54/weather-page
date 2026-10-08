const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const path=require('node:path');const source=fs.readFileSync(path.join(__dirname,'../js/nordic-radar.js'),'utf8');
function harness(){const c={Image:class{get naturalWidth(){return 2}get naturalHeight(){return 2}set src(value){if(value)queueMicrotask(()=>this.onload?.())}decode(){return Promise.resolve()}},Map,Set,Date,URL,Number,Array,Object,Promise,console,setTimeout,clearTimeout,map:{on(){}},$:()=>({checked:true,textContent:'',className:''})};vm.createContext(c);vm.runInContext(source,c);return c;}
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
test('static radar archives accept only bounded official PNG observations',()=>{
 const c=harness();c.frame={source:'dk',station:'dk',time:100,format:'png',url:'data/radar-cache/dk-100-0123456789ab.png',bounds:[[52,3],[60,21]],source_url:'https://opendataapi.dmi.dk/v1/radardata/download/a.h5'};
 assert.equal(vm.runInContext("validNordicRadarArchiveFrame(frame,{id:'dk'})",c),true);
 c.frame.url='https://example.com/tracking.png';assert.equal(vm.runInContext("validNordicRadarArchiveFrame(frame,{id:'dk'})",c),false);
 c.frame.url='data/radar-cache/dk-100-0123456789ab.png';c.frame.bounds=[[60,3],[52,21]];assert.equal(vm.runInContext("validNordicRadarArchiveFrame(frame,{id:'dk'})",c),false);
});
test('each source paints independently and an older pending selection cannot repaint the map',async()=>{
 const c=harness();const elements={radarOn:{checked:true},nordicRadarStatus:{},timeline:{value:0}};c.$=id=>elements[id];c.fmt=t=>String(t);c.weatherFront=()=>{};c.playing=true;c.frames=[];c.scheduleRadarPlaybackPreload=()=>{};
 c.map.getZoom=()=>5;c.map.removeLayer=()=>{};c.L={imageOverlay:(url)=>({radarUrl:url,addTo(){return this},bringToFront(){}})};
 let resolveOld;c.oldFrame=new Promise(resolve=>resolveOld=resolve);
 vm.runInContext("NORDIC_RADAR_SOURCES.splice(2);nordicRadarVisible=()=>true;listNordicRadar=async source=>[{time:100,station:source.id},{time:200,station:source.id}];nordicRadarFrame=(record)=>record.station==='se'&&record.time===100?oldFrame:Promise.resolve({url:record.station+record.time,image:{src:record.station+record.time},bounds:[[53,4],[71,31]]})",c);
 const old=vm.runInContext('drawNordicRadars(100)',c);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext("nordicRadarLayers.get('fi:fi').radarUrl",c),'fi100');
 assert.match(elements.nordicRadarStatus.textContent,/SE.*loading/);
 await vm.runInContext('drawNordicRadars(200)',c);
 resolveOld({url:'se100',bounds:[[53,4],[71,31]]});await old;
 assert.equal(vm.runInContext("nordicRadarLayers.get('se:se').radarUrl",c),'se200');
 assert.equal(vm.runInContext("nordicRadarLayers.get('fi:fi').radarUrl",c),'fi200');
});
test('old frame remains until decoding finishes; replacement uses the decoded element',async()=>{
 const c=harness(),elements={radarOn:{checked:true},nordicRadarStatus:{}};
 c.$=id=>elements[id];c.fmt=String;c.weatherFront=()=>{};c.playing=true;c.scheduleRadarPlaybackPreload=()=>{};
 c.map.getZoom=()=>5;const displayed=new Set(),images=[];let finishDecode;
 c.map.removeLayer=layer=>displayed.delete(layer);
 c.L={imageOverlay:image=>{assert(image.naturalWidth);return {image,addTo(){displayed.add(this);return this},bringToFront(){}}}};
 c.Image=class{constructor(){images.push(this)}get naturalWidth(){return 512}get naturalHeight(){return 512}set src(value){if(value)queueMicrotask(()=>this.onload?.())}decode(){return images.length===1?Promise.resolve():new Promise(resolve=>finishDecode=resolve)}};
 c.Blob=Blob;c.URL=class extends URL{static createObjectURL(){return 'blob:'+images.length}static revokeObjectURL(){}};c.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
 vm.runInContext("NORDIC_RADAR_SOURCES.splice(1);nordicRadarVisible=()=>true;listNordicRadar=async()=>[{time:100,station:'fi',format:'png',url:'https://opendata.fmi.fi/first'},{time:200,station:'fi',format:'png',url:'https://opendata.fmi.fi/next'}]",c);
 await vm.runInContext('drawNordicRadars(100)',c);const first=[...displayed][0];
 const next=vm.runInContext('drawNordicRadars(200)',c);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(displayed.size,1);assert(displayed.has(first));assert.match(elements.nordicRadarStatus.textContent,/Loading/);
 finishDecode();await next;assert.equal(displayed.size,1);assert(!displayed.has(first));assert.equal([...displayed][0].image,images[1]);
});
test('a disabled layer cannot reappear when a late image finishes decoding',async()=>{
 const c=harness(),toggle={checked:true};c.$=()=>toggle;c.fmt=String;c.weatherFront=()=>{};c.playing=true;c.scheduleRadarPlaybackPreload=()=>{};c.map.getZoom=()=>5;c.map.removeLayer=()=>{};
 let finishDecode,added=0;c.L={imageOverlay:()=>({addTo(){added++;return this},bringToFront(){}})};
 c.Image=class{get naturalWidth(){return 512}get naturalHeight(){return 512}set src(value){if(value)queueMicrotask(()=>this.onload?.())}decode(){return new Promise(resolve=>finishDecode=resolve)}};
 const revoked=[];c.Blob=Blob;c.URL=class extends URL{static createObjectURL(){return 'blob:late'}static revokeObjectURL(url){revoked.push(url)}};c.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
 vm.runInContext("NORDIC_RADAR_SOURCES.splice(1);nordicRadarVisible=()=>true;listNordicRadar=async()=>[{time:100,station:'fi',format:'png',url:'https://opendata.fmi.fi/first'}]",c);
 const draw=vm.runInContext('drawNordicRadars(100)',c);await new Promise(resolve=>setImmediate(resolve));toggle.checked=false;vm.runInContext('clearNordicRadars()',c);finishDecode();await draw;
 assert.equal(added,0);assert.deepEqual(revoked,['blob:late']);assert.equal(vm.runInContext('nordicRadarLayers.size',c),0);
});
test('cross-border stacking is identical for different source completion orders',()=>{
 const c=harness();const order=[];c.weatherFront=()=>order.push('weather');c.order=order;
 for(const ids of [['fi:fi','se:se','no:no','is:isska','is:iskef'],['is:iskef','is:isska','no:no','fi:fi','se:se']]){
   order.length=0;c.ids=ids;vm.runInContext("nordicRadarLayers.clear();for(const id of ids)nordicRadarLayers.set(id,{bringToFront(){order.push(id)}});orderNordicRadarLayers()",c);
   assert.deepEqual(order,['no:no','se:se','fi:fi','is:iskef','is:isska','weather']);
 }
});
test('decoded pixel memory is bounded and failures release their object URLs',async()=>{
 const c=harness();const revoked=[];let next=0;c.Blob=Blob;c.URL={createObjectURL:()=> 'blob:'+(next++),revokeObjectURL:url=>revoked.push(url)};c.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
 c.Image=class{get naturalWidth(){return 2000}get naturalHeight(){return 2000}set src(value){if(value)queueMicrotask(()=>this.onload?.())}decode(){return Promise.resolve()}};
 for(let i=0;i<4;i++){c.record={url:'frame'+i,format:'png'};await vm.runInContext('nordicRadarFrame(record,2000)',c)}
 assert.equal(vm.runInContext('nordicRadarFrames.size',c),4);assert.deepEqual(revoked,[]);assert(vm.runInContext('[...nordicRadarFrames.values()].reduce((n,f)=>n+f.bytes,0)',c)<=48*1024*1024);
 c.record={url:'frame0',format:'png'};c.fetch=()=>assert.fail('prepared history was downloaded again');const reused=await vm.runInContext('nordicRadarFrame(record,2000)',c);assert(reused.image);assert.equal(reused.url,'blob:0');
 c.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});
 c.Image=class{set src(value){if(value)queueMicrotask(()=>this.onerror?.())}};c.record={url:'bad',format:'png'};await assert.rejects(vm.runInContext('nordicRadarFrame(record,2000)',c),/could not be displayed/);assert.equal(revoked.at(-1),'blob:4');
});
test('Iceland live relay accepts only this service and uses live data ahead of the archive',async()=>{
 const c=harness();c.fetch=async url=>{assert.equal(url,'https://northern-weather-radar.franz-sammel54.chatgpt.site/api/iceland/radar');return {ok:true,json:async()=>({frames:[{time:Math.floor(Date.now()/1000)-300,station:'iskef',format:'h5',path:'/api/iceland/file/2026-10-04/iskef/T_PAGZ41_C_BIRK_20261004003002.h5',source_url:'https://brunnur.vedur.is/radar/data/2026-10-04/iskef/T_PAGZ41_C_BIRK_20261004003002.h5'}]})};};c.AbortController=AbortController;
 const records=await vm.runInContext("listNordicRadar({id:'is',name:'IMO'})",c);assert.equal(records.length,1);assert.match(records[0].url,/northern-weather-radar/);
 for(const url of ['https://evil.example/api/iceland/file/2026-10-04/iskef/T_PAGZ41_C_BIRK_20261004003002.h5','https://northern-weather-radar.franz-sammel54.chatgpt.site/api/iceland/file/2026-10-04/iskef/T_PAJZ41_C_BIRK_20261004003002.h5']){c.url=url;assert.equal(vm.runInContext('trustedIcelandRadarRelay(url)',c),false);}
});
test('polar interpolation wraps north, blends known-zero echoes and keeps nodata missing',async()=>{
 const m=await import('../js/radar-grid.mjs');const starts=[0,90,180,270],ends=[90,180,270,360];
 const grid={width:2,height:4,rscale:1000,rstart:0,gain:1,offset:0,nodata:255,undetect:0,values:new Uint8Array([20,20,20,20,20,20,0,0]),rayLookup:m.makeRayLookup(starts,ends),raySampling:m.makeRaySampling(starts,ends),reflectivity:Float32Array.from({length:256},(_,i)=>10**(i/10))};
 const sample=m.polarInterpolation(0,1000,grid);assert(sample);assert.equal(Math.floor(sample.index/2),3);
 const rate=m.polarReflectivity(sample.index,sample.weights,grid);assert(rate>0&&rate<m.radarRate(20,{...grid,quantity:'DBZH'}));
 grid.values[0]=255;assert(Number.isNaN(m.polarReflectivity(sample.index,sample.weights,grid)));
 assert.equal(m.polarInterpolation(0,2100,grid),null);
 const sparse=m.makeRaySampling([0,90],[1,91]);assert.equal(sparse.lower[450],-1);
});
test('Iceland latest clock advances without changing historical selections',()=>{
 const c=harness();const elements={timeline:{value:1,max:1},timeLabel:{}};c.$=id=>elements[id];c.fmt=String;c.playing=false;c.cloudTimelineMode=false;c.renderTimelineTicks=()=>{};
 c.end=Math.floor(Date.now()/1000/300)*300-300;vm.runInContext('let radarTimelineFrames=[{time:end-600},{time:end-300}];let frames=radarTimelineFrames',c);
 vm.runInContext('followNordicRadarClock()',c);assert.equal(vm.runInContext('frames.at(-1).time',c),c.end);assert.equal(elements.timeline.value,2);
 elements.timeline.value=0;vm.runInContext('radarTimelineFrames.at(-1).time-=300;followNordicRadarClock()',c);assert.equal(elements.timeline.value,0);assert.equal(vm.runInContext('frames.at(-1).time',c),c.end-300);
});

test('background Nordic preparation is reused on activation and survives hiding the layer',async()=>{
 const c=harness(),toggle={checked:false};c.$=()=>toggle;c.Blob=Blob;c.URL={createObjectURL:()=> 'blob:prepared',revokeObjectURL:()=>assert.fail('cached image was released')};
 let downloads=0,resolveDownload;c.fetch=()=>{downloads++;return new Promise(resolve=>resolveDownload=resolve)};
 c.record={url:'data/radar-cache/dk-100-0123456789ab.png',format:'png',time:100,bounds:[[52,3],[60,21]]};
 const preparing=vm.runInContext('nordicRadarFrame(record,900,{background:true,canPrepare:()=>true})',c);
 toggle.checked=true;const selected=vm.runInContext('nordicRadarFrame(record,900)',c);
 assert.equal(preparing,selected);resolveDownload({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)});await preparing;
 toggle.checked=false;vm.runInContext('clearNordicRadars()',c);
 toggle.checked=true;const cached=await vm.runInContext('nordicRadarFrame(record,900)',c);
 assert.equal(cached.url,'blob:prepared');assert.equal(downloads,1);
});
test('queued foreground frames overtake background history and obsolete background work stops',async()=>{
 const c=harness(),toggle={checked:false};c.$=()=>toggle;c.Blob=Blob;c.URL={createObjectURL:()=> 'blob:x',revokeObjectURL(){}};
 const started=[],resolvers=[];c.fetch=url=>{started.push(url);return new Promise(resolve=>resolvers.push(()=>resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)})))};
 c.records=['first','history','selected'].map(url=>({url,format:'png',time:100}));
 const first=vm.runInContext('nordicRadarFrame(records[0],900,{background:true,canPrepare:()=>true})',c);
 const old=vm.runInContext('nordicRadarFrame(records[1],900,{background:true,canPrepare:()=>false})',c);const rejected=assert.rejects(old,/preparation paused/);
 assert.deepEqual(started,['first']);toggle.checked=true;
 const chosen=vm.runInContext('nordicRadarFrame(records[2],900)',c);assert.deepEqual(started,['first','selected']);
 resolvers[1]();await chosen;toggle.checked=false;resolvers[0]();await first;await rejected;
 assert.deepEqual(started,['first','selected']);
});


test('close zoom uses native footprints; overview and unknown sources retain cross-border coverage',()=>{
 const c=harness();let zoom=7;
 c.map.getZoom=()=>zoom;c.map.getBounds=()=>({intersects:b=>b[0][1]<25&&b[1][1]>24});
 c.L={latLngBounds:b=>b};
 vm.runInContext("radarFootprints.set('no',{bounds:[[54,-1],[76,10]],at:Date.now()})",c);
 assert.equal(vm.runInContext("nordicRadarVisible({id:'no',bounds:[[54,-1],[76,40]]})",c),false);
 zoom=4;assert.equal(vm.runInContext("nordicRadarVisible({id:'no',bounds:[[54,-1],[76,40]]})",c),true);
 zoom=7;assert.equal(vm.runInContext("nordicRadarVisible({id:'fi',bounds:[[56,16],[73,38]]})",c),true);
});
test('worker footprint follows scan geometry even when every measurement is dry',async()=>{
 const m=await import('../js/radar-grid.mjs');const worker=fs.readFileSync(path.join(__dirname,'../js/nordic-radar-worker.js'),'utf8').replace(/^import .*;$/m,'');
 const c={...m,console,Uint8Array,Int32Array,Uint16Array,Array,Map,Math,Number,JSON,self:{},proj4:(from,to)=>({forward:([x,y])=>from==='EPSG:4326'?[x*1000,(y-60)*1000]:[x/1000,60+y/1000]})};
 vm.createContext(c);vm.runInContext(worker,c);
 c.grid={width:10,height:360,left:-2000,top:2000,dx:400,dy:4000/360,projection:'native',polar:true,rscale:200,rstart:0,elevation:0,values:new Uint8Array(3600)};
 const coverage=vm.runInContext('mappingFor(grid,96,proj4).coverage',c);
 assert.equal(coverage.cells[0],0);assert.equal(coverage.cells[16*32+16],1);
 assert(coverage.cells.some(v=>v===0)&&coverage.cells.some(v=>v===1));
});

test('prepared Iceland PNGs replace only the identical official scan and preserve latest raw scans',()=>{
 const c=harness();c.live=[{station:'iskef',time:100,url:'relay',source_url:'https://brunnur.vedur.is/scan.h5'},{station:'iskef',time:200,url:'new-relay',source_url:'https://brunnur.vedur.is/new.h5'}];
 c.prepared=[{station:'iskef',time:100,format:'png',url:'data/radar-cache/exact.png',source_url:'https://brunnur.vedur.is/scan.h5'},{station:'isska',time:200,format:'png',url:'wrong-station',source_url:'https://brunnur.vedur.is/new.h5'}];
 let rows=vm.runInContext('preparedIcelandRadar(live,prepared)',c);assert.equal(rows[0].format,'png');assert.equal(rows[1].url,'new-relay');assert.equal(rows[1].time,200);
 c.prepared[0].source_url='https://brunnur.vedur.is/different.h5';rows=vm.runInContext('preparedIcelandRadar(live,prepared)',c);assert.equal(rows[0].url,'relay');
});

test('mobile overview reduces raster size and retains full close-zoom detail',()=>{
 const c=harness();let zoom=4;c.map.getZoom=()=>zoom;
 assert.equal(vm.runInContext('nordicRadarEdge()',c),900);
 c.window={matchMedia:()=>({matches:true})};
 assert.equal(vm.runInContext('nordicRadarEdge()',c),512);
 zoom=6;assert.equal(vm.runInContext('nordicRadarEdge()',c),900);
 zoom=7;assert.equal(vm.runInContext('nordicRadarEdge()',c),2000);
 c.window.matchMedia=()=>({matches:false});zoom=6;
 assert.equal(vm.runInContext('nordicRadarEdge()',c),1400);
});
