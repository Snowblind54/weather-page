const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(__dirname+'/../js/'+name,'utf8');
const now=Math.floor(Date.now()/1000);

test('history downloads only on popup open, shares requests, and indexes the selected station',async()=>{
  let requests=0,resolve;
  const station={country:'DE',code:'1',name:'Test',time:now,temp:12};
  const c={Date,Math,Map,Number,Promise,AbortController,setTimeout,clearTimeout,htmlEscape:s=>s,
    __officialTemperatureHistoryFile:'data/official-temperature-history.json',
    officialTemperatureStations:[station],officialTemperaturePopup:()=>'<div>Measured reading</div>',
    fetch:()=>{requests++;return new Promise(r=>resolve=r);}};
  vm.createContext(c);vm.runInContext(read('temperature-history.js'),c);
  assert.equal(requests,0);
  const popup=()=>({isOpen:()=>true,setContent(html){this.content=html;}}),a=popup(),b=popup();
  assert.match(c.officialTemperaturePopup(station,a),/Loading measured history/);
  c.officialTemperaturePopup(station,b);assert.equal(requests,1);
  resolve({ok:true,json:async()=>({version:1,stations:[{...station,rows:[[now-80000,5],[now,12]]},
    {country:'BE',code:'1',rows:[[now-80000,50],[now,50]]}]})});
  await new Promise(setImmediate);
  assert.match(a.content,/2 obs/);assert.match(a.content,/5.0°C/);assert.doesNotMatch(a.content,/50.0°C/);
  assert.match(b.content,/2 obs/);
  assert.match(c.officialTemperaturePopup(station,popup()),/2 obs/);assert.equal(requests,1);
});

test('unavailable history preserves the reading and recent observations',async()=>{
  const station={country:'NO',code:'1',name:'Test',time:now,temp:0};
  const c={Date,Math,Map,Number,Promise,AbortController,setTimeout,clearTimeout,htmlEscape:s=>s,
    __officialTemperatureHistoryFile:'data/official-temperature-history.json',officialTemperatureStations:[station],
    officialTemperaturePopup:()=>'<div>Measured zero</div>',fetch:async()=>({ok:false,status:503})};
  vm.createContext(c);vm.runInContext(read('temperature-history.js'),c);
  const popup={isOpen:()=>true,setContent(html){this.content=html;}};
  c.officialTemperaturePopup(station,popup);await new Promise(setImmediate);
  assert.match(popup.content,/Measured zero/);assert.match(popup.content,/temporarily unavailable/);
});

test('station selection reuses work without changing playback or freshness after updates',()=>{
  const source=read('stations.js');
  const selection=source.slice(source.indexOf('function officialStationsNearTime('),source.indexOf('function officialStationSourceSummary('));
  const c={Map,Number,frames:[{time:now-7200},{time:now}],rows:[
    {country:'NO',code:'1',time:now-7200,temp:0},{country:'NO',code:'1',time:now,temp:10}],
    OFFICIAL_TEMP_LABEL_MAX_OFFSET:5700,OFFICIAL_TEMP_LABEL_MAX_OFFSET_BY_COUNTRY:{NO:10800},OFFICIAL_TEMP_FUTURE_TOLERANCE_SEC:600,
    officialTempStationKey:s=>s.country+'|'+s.code};
  vm.createContext(c);vm.runInContext('let officialTemperatureStations=rows,officialTemperatureSelectionSource=null;const officialTemperatureSelectionCache=new Map();'+selection,c);
  const latest=c.officialStationsNearTime(now);assert.equal(latest[0].temp,10);
  assert.equal(c.officialStationsNearTime(now),latest);assert.equal(c.officialStationsNearTime(now-7200)[0].temp,0);
  vm.runInContext('officialTemperatureStations=[{country:"NO",code:"1",time:frames[1].time,temp:15}]',c);
  assert.equal(c.officialStationsNearTime(now)[0].temp,15);
});

test('viewport skips offscreen regions and handles wrapped longitudes and cache identity',()=>{
  const source=read('temperature.js');
  const functions=source.slice(source.indexOf('function visibleTemperatureRegions('),source.indexOf('async function createTemperatureImage('));
  let view=[47,2,55,16];
  const c={Math,TEMP_REGIONS:[{id:'europe',bounds:[[47,2],[55,16]]},{id:'usa',bounds:[[30,-125],[50,-70]]},
    {id:'aleutians',bounds:[[50,170],[55,180]]}],nearestQuarterHour:t=>Math.floor(t/900)*900,
    map:{getBounds:()=>({getSouth:()=>view[0],getWest:()=>view[1],getNorth:()=>view[2],getEast:()=>view[3]})}};
  vm.createContext(c);vm.runInContext(functions,c);
  assert.equal(c.visibleTemperatureRegions().map(r=>r.id).join(','),'europe');
  const europeKey=c.temperatureViewportCacheKey(now);
  view=[30,-130,50,-65];assert.equal(c.visibleTemperatureRegions().map(r=>r.id).join(','),'usa');
  assert.notEqual(c.temperatureViewportCacheKey(now),europeKey);
  view=[30,230,50,295];assert.equal(c.visibleTemperatureRegions().map(r=>r.id).join(','),'usa');
  view=[50,169,56,-169];assert.equal(c.visibleTemperatureRegions().map(r=>r.id).join(','),'aleutians');
});
