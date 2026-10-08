const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=file=>fs.readFileSync(path.join(__dirname,'../js',file),'utf8');
function harness(){const c={Map,Set,Date,Intl,URL,URLSearchParams,Promise,AbortController,setTimeout,clearTimeout,console:{warn(){}},map:{on(){}},$:()=>({checked:true})};vm.createContext(c);vm.runInContext(code('radar-images.js')+code('nordic-radar.js')+code('radar-history.js'),c);return c;}
test('DMI native projection agrees with PROJ EPSG:3575 fixtures and WMS tiles retain selected UTC time',()=>{
 const c=harness();for(const [lon,lat,x,y] of [[2,52,-579166.8800412331,-4120986.4824531176],[22,61,665747.5578328171,-3132096.00589202],[12.5683,55.6761,169048.30203058216,-3768744.365531258]]){c.lon=lon;c.lat=lat;const p=vm.runInContext('dmiPolarPoint(lon,lat)',c);assert(Math.abs(p[0]-x)<.001);assert(Math.abs(p[1]-y)<.001);}
 for(const edge of [900,1400,2000]){c.edge=edge;const plan=vm.runInContext("dmiImagePlan(Date.parse('2026-10-04T00:05Z')/1000,edge)",c);assert.equal(Math.max(plan.width,plan.height),edge);assert(plan.tiles.length>1);for(const tile of plan.tiles){const u=new URL(tile.url);assert.equal(u.origin,'https://www.dmi.dk');assert.equal(u.searchParams.get('SRS'),'EPSG:3575');assert.equal(u.searchParams.get('WIDTH'),'512');assert.equal(u.searchParams.get('HEIGHT'),'512');assert.equal(u.searchParams.get('TIME'),'2026-10-04T00:05:00Z');}}
});
test('native image preparation shares downloads, avoids CORS pixel access and bounds failure caches',async()=>{
 const c=harness();let started=0,image;c.Image=class{constructor(){image=this;started++;}set src(url){this.url=url;}get naturalWidth(){return 512;}get naturalHeight(){return 512;}};
 const first=vm.runInContext("loadRadarNativeImage('https://www.dmi.dk/radar.png')",c),second=vm.runInContext("loadRadarNativeImage('https://www.dmi.dk/radar.png')",c);assert.equal(first,second);assert.equal(started,1);assert.equal(image.crossOrigin,undefined);image.onload();await first;
 await vm.runInContext("loadRadarNativeImage('https://www.dmi.dk/radar.png')",c);assert.equal(started,1);
 const failed=vm.runInContext("loadRadarNativeImage('https://www.dmi.dk/missing.png')",c);image.onerror();await assert.rejects(failed);await assert.rejects(vm.runInContext("loadRadarNativeImage('https://www.dmi.dk/missing.png')",c));assert.equal(started,2);
 vm.runInContext("for(let i=0;i<120;i++)cacheRadarNativeImage('missing'+i,{at:Date.now(),error:new Error('offline')})",c);assert.equal(vm.runInContext('radarNativeImages.size',c),100);
});
test('Lithuania falls back only to earlier UTC PNG observations across midnight',async()=>{
 const c=harness();c.target=Date.parse('2026-10-04T00:02Z')/1000;c.source={bounds:[[49.876389,15.618611],[59.701667,34.313611]]};const urls=[];c.loadRadarNativeImage=async url=>{urls.push(url);if(!url.includes('202610032355'))throw new Error('not published');};
 const frame=await vm.runInContext('ltHistory(source,target)',c);assert.equal(frame.time,Date.parse('2026-10-03T23:55Z')/1000);assert.deepEqual(urls.map(u=>u.match(/composite-(\d+)/)[1]),['202610040000','202610032355']);assert.equal(frame.bounds,c.source.bounds);
 c.loadRadarNativeImage=async()=>{throw new Error('not published');};c.fmt=String;await assert.rejects(vm.runInContext('ltHistory(source,target)',c),/15 minutes/);
});
test('Latvia uses Riga observation time, validates paths and excludes stale or invalid filenames',()=>{
 const c=harness();c.now=Date.parse('2026-10-04T09:30Z')/1000;c.payload=[{name:'Latvija/Latvija_satelits/png/LATVIJA_202610041215_RADAR.png'},'Latvija/Latvija_satelits/LATVIJA_202610041220.png','https://evil.example/LATVIJA_202610041215.png','Latvija/Latvija_satelits/../LATVIJA_202610041215.png','Latvija/Latvija_satelits/LATVIJA_202610049999.png','Latvija/Latvija_satelits/LATVIJA_202610041245.png','Latvija/Latvija_satelits/LATVIJA_202610040815.png'];
 const frames=vm.runInContext('parseLvRadarRecords(payload,now)',c);assert.equal(frames.length,2);assert.equal(frames[0].time,Date.parse('2026-10-04T09:15Z')/1000);assert.equal(frames[1].time,Date.parse('2026-10-04T09:20Z')/1000);assert(frames.every(f=>f.url.startsWith('https://videscentrs.lvgmc.lv/kartes-images/Latvija/Latvija_satelits/')));
});
test('an empty Latvian publisher is disclosed, deduplicated and retried when forced',async()=>{
 const c=harness();const calls=[];c.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>[]};};await assert.rejects(vm.runInContext('listLvRadar()',c),/not publishing recent/);await assert.rejects(vm.runInContext('listLvRadar()',c));assert.equal(calls.length,2);await assert.rejects(vm.runInContext('listLvRadar(true)',c));assert.equal(calls.length,4);assert(calls.every(u=>u.startsWith('https://videscentrs.lvgmc.lv/')));
});
test('Denmark uses direct official metadata ahead of the archive and never fetches a public proxy',async()=>{
 const c=harness();const now=Math.floor(Date.now()/1000),calls=[];c.fetch=async url=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify({features:[{properties:{datetime:new Date((now-600)*1000).toISOString()},asset:{data:{href:'https://opendataapi.dmi.dk/v1/radardata/download/scan.h5'}}}]})};};c.cachedNordicRadar=()=>assert.fail('archive used despite direct observations');const frames=await vm.runInContext("listNordicRadar({id:'dk'})",c);assert.equal(frames[0].format,'dmi-wms');assert.equal(calls.length,1);assert(calls[0].startsWith('https://opendataapi.dmi.dk/'));
 c.fetch=async url=>{assert(url.startsWith('https://opendataapi.dmi.dk/'));throw new Error('offline');};c.cachedNordicRadar=async()=>[{time:now-600,format:'png'}];assert.equal((await vm.runInContext("listNordicRadar({id:'dk'},true)",c))[0].format,'png');
});


test('historical Baltic frames remain cached beyond a minute and decoded native images are reused',async()=>{
 const c=harness();c.directRadarImageCache=new Map();let calls=0;c.ltHistory=async()=>{calls++;return {dataUrl:'official.png',time:100}};
 await vm.runInContext("prepareBalticRadarFrame({id:'lt'},100,200)",c);
 vm.runInContext("directRadarImageCache.get('lt|100').at-=120000",c);
 await vm.runInContext("prepareBalticRadarFrame({id:'lt'},100,200)",c);assert.equal(calls,1);
 let image;c.Image=class{constructor(){image=this;}set src(value){}get naturalWidth(){return 512;}get naturalHeight(){return 512;}};
 const first=vm.runInContext("loadRadarNativeImage('native.png',{pixels:true})",c);image.onload();const loaded=await first;
 const again=await vm.runInContext("loadRadarNativeImage('native.png',{pixels:true})",c);assert.equal(again.image,loaded.image);
});

test('Danish and Swedish ownership masks are complementary and disappear on source failure',()=>{
 const c=harness();c.radarMercatorY=lat=>lat;c.radarLatitudeAtY=y=>y;
 const bounds={getSouth:()=>52,getWest:()=>2,getNorth:()=>61,getEast:()=>22};
 c.dk={getElement:()=>c.dkElement,getBounds:()=>bounds};c.se={getElement:()=>c.seElement,getBounds:()=>bounds};c.dkElement={style:{}};c.seElement={style:{}};
 vm.runInContext("nordicRadarLayers.set('dk:dk',dk);nordicRadarLayers.set('se:se',se);setEstoniaRadarPriorityMask(dk,false);setEstoniaRadarPriorityMask(se,false)",c);
 assert(c.dkElement.style.maskImage);assert(c.seElement.style.maskImage);assert.notEqual(c.dkElement.style.maskImage,c.seElement.style.maskImage);
 vm.runInContext("nordicRadarLayers.delete('se:se');setEstoniaRadarPriorityMask(dk,false)",c);assert.equal(c.dkElement.style.maskImage,'');
 c.coverageLayer={radarCoverage:{bounds:[[52,2],[61,22]],cols:1,rows:1,cells:[0]}};
 assert.equal(vm.runInContext('radarDomainInCoverage(SWEDEN_RADAR_DOMAIN,coverageLayer).length',c),0);
 c.coverageLayer.radarCoverage.cells=[1];assert.equal(vm.runInContext('radarDomainInCoverage(SWEDEN_RADAR_DOMAIN,coverageLayer).length',c),1);
});
