const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=name=>fs.readFileSync(require('node:path').join(__dirname,'../js',name),'utf8');
function harness(){
  const status={checked:true,textContent:'',className:''};
  const c={warningLoadGeneration:0,Date,Intl,Map,Number,Object,Array,Math,JSON,console,$:()=>status,
    warningRecords:[],lithuaniaWarnings:[],nordicWarnings:[],estoniaLegacyForecast:false,
    renderNordicWarnings(){},loadWarnings(){},setTimeout(){},clearTimeout(){}};
  vm.createContext(c);
  vm.runInContext(read('latvia-warnings.js')+'\n'+read('national-warnings.js'),c);
  const filters=read('warning-filters.js');
  vm.runInContext(filters.slice(0,filters.indexOf('const renderWarningsAllDays'))+filters.slice(filters.indexOf('function overdueWarningCountries'),filters.indexOf('let warningExpiryTimer')),c);
  return {c,status,run:s=>vm.runInContext(s,c)};
}
const polygon=[[55,20],[56,20],[56,21],[55,20]];
const updatedAt=new Date(Date.now()-3*3600000).toISOString();
const future=new Date(Date.now()+3600000).toISOString();
const past=new Date(Date.now()-1000).toISOString();
for(const country of ['Latvia','Poland','Denmark','Greenland','Canada','United Kingdom','Ireland','Germany','Netherlands','Belgium','Luxembourg','Czechia','Slovakia','Spain','Italy','Greece','Turkey'])test(`${country}: overdue warnings remain visible, expired ones disappear`,()=>{
  const h=harness();const record={country,level:'Moderate',effective:updatedAt,expires:future,messageExpires:future,polygons:[polygon]};
  h.c.record=record;h.c.snapshot={version:1,updatedAt,records:[record]};
  if(country==='Latvia')h.run('records=validateLatviaSnapshot(snapshot)');
  else {h.c.snapshot.countries={[({Poland:'PL',Denmark:'DK',Greenland:'GL',Canada:'CA','United Kingdom':'UK',Ireland:'IE',Germany:'DE',Netherlands:'NL',Belgium:'BE',Luxembourg:'LU',Czechia:'CZ',Slovakia:'SK',Spain:'ES',Italy:'IT',Greece:'GR',Turkey:'TR'})[country]]:{country,updatedAt,records:[record]}};h.run(`records=validateNationalWarningCountry(snapshot,'${({Poland:'PL',Denmark:'DK',Greenland:'GL',Canada:'CA','United Kingdom':'UK',Ireland:'IE',Germany:'DE',Netherlands:'NL',Belgium:'BE',Luxembourg:'LU',Czechia:'CZ',Slovakia:'SK',Spain:'ES',Italy:'IT',Greece:'GR',Turkey:'TR'})[country]}')`);}
  assert.equal(h.run('records.length'),1);
  assert.equal(h.run('warningIsTodayOrTomorrow(records[0])'),true);
  h.c.nordicWarnings=h.run('records');
  h.run('updateVisibleWarningStatus()');assert.match(h.status.textContent,/Updates overdue/);assert.match(h.status.textContent,new RegExp(country));
  record.expires=past;assert.equal(h.run('warningIsTodayOrTomorrow(record)'),false);
});

test('Canadian message expiry hides alerts even when the weather event ends later',()=>{
 const h=harness();h.c.record={country:'Canada',effective:updatedAt,expires:future,messageExpires:past};
 assert.equal(h.run('warningIsTodayOrTomorrow(record)'),false);
});
test('Canadian regional time zones determine today and tomorrow',()=>{
 const h=harness();h.c.record={country:'Canada',effective:new Date(Date.now()+47*3600000).toISOString(),expires:new Date(Date.now()+49*3600000).toISOString(),timeZone:'America/Vancouver'};
 const zone='America/Vancouver';
 const start=new Date(h.c.record.effective);
 const today=h.run(`warningDateKey(new Date(),'${zone}')`);
 const tomorrow=h.run(`warningAddDays('${today}',1)`);
 h.c.start=start;h.c.tomorrow=tomorrow;
 assert.equal(h.run('warningIsTodayOrTomorrow(record)'),h.run(`warningDateKey(start,'${zone}')<=tomorrow`));
});
test('Canadian statement labels and subdued polygons render while Finnish marine outlines remain dashed',async()=>{
  const h=harness(),layers=[],cards=[];
  h.c.htmlEscape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');
  h.c.document={createElement:()=>({style:{},addEventListener(){}})};
  h.c.$=id=>id==='warningList'?{appendChild:card=>cards.push(card)}:h.status;
  h.c.L={polygon:(geometry,options)=>({geometry,options,bindPopup(content){this.content=content;return this;}})};
  h.c.warningLayerGroup={addLayer:layer=>layers.push(layer)};h.c.window={NorthernWarningViewport:{polygons:(geometry,options)=>h.c.L.polygon(geometry,options)}};
  h.c.isFinnishMarineWarning=record=>record.country==='Finland';
  h.c.scheduleWarningExpiryRefresh=()=>{};
  const src=read('warnings.js');
  h.run(src.slice(src.indexOf('function warningSeverity('),src.indexOf('async function fetchWarningText(')));
  h.run(src.slice(src.indexOf('function nordicWarningPopupHtml('),src.indexOf('async function renderNordicWarnings(')));
  const filters=read('warning-filters.js');
  h.run(filters.slice(filters.indexOf('renderNordicWarnings=async function(){'),filters.indexOf('// Counts always describe')));
  const base={effective:updatedAt,expires:future,polygons:[polygon],circles:[],area:'Coast',flag:'🇨🇦',event:'Special weather statement',headline:'Special weather statement',sourceName:'ECCC',sourcePage:'https://weather.gc.ca/'};
  h.c.nordicWarnings=[{...base,country:'Canada',level:'Information',alertType:'Statement',messageExpires:future,timeZone:'America/Vancouver'}, {...base,country:'Finland',level:'Moderate'}];
  assert.equal(await h.run('renderNordicWarnings()'),2);
  assert.equal(layers[0].options.fillOpacity,.09);
  assert.match(layers[0].content(),/Statement · Information/);
  assert.match(cards[0].innerHTML,/Statement · Information/);
  assert.equal(layers[0].warningRecord.country,'Canada');
  assert.equal(layers[1].options.fill,false);
  assert.equal(layers[1].options.dashArray,'9 6');
});

test('Belgium and Luxembourg show healthy zero counts when their official feeds are empty',()=>{
 const h=harness();h.c.snapshot={version:1,countries:{BE:{country:'Belgium',updatedAt:new Date().toISOString(),records:[]},LU:{country:'Luxembourg',updatedAt:new Date().toISOString(),records:[]}}};
 h.run('nationalWarningSnapshot=snapshot; updateVisibleWarningStatus()');
 assert.match(h.status.textContent,/BE 0/);assert.match(h.status.textContent,/LU 0/);assert.doesNotMatch(h.status.textContent,/unavailable|overdue/);
});
test('Western and Central European warnings create map paths, preserve popup details and distinguish Dutch marine zones',async()=>{
 const h=harness(),layers=[],cards=[];
 h.c.htmlEscape=String;h.c.normalizeWarningArea=String;
 h.c.document={createElement:()=>({style:{},addEventListener(){}})};
 h.c.$=id=>id==='warningList'?{appendChild:card=>cards.push(card)}:h.status;
 h.c.L={polygon:(geometry,options)=>({geometry,options,bindPopup(content){this.content=content;return this;}})};
 h.c.window={NorthernWarningViewport:{polygons:(geometry,options)=>h.c.L.polygon(geometry,options)}};
 h.c.warningLayerGroup={addLayer:layer=>layers.push(layer)};h.c.scheduleWarningExpiryRefresh=()=>{};
 const src=read('warnings.js'),filters=read('warning-filters.js');
 h.run(src.slice(src.indexOf('function warningSeverity('),src.indexOf('async function fetchWarningText(')));
 h.run(src.slice(src.indexOf('function nordicWarningPopupHtml('),src.indexOf('async function renderNordicWarnings(')));
 h.run(filters.slice(filters.indexOf('function isFinnishMarineWarning'),filters.indexOf('// Nordic renderer')));
 h.run(filters.slice(filters.indexOf('renderNordicWarnings=async function(){'),filters.indexOf('// Counts always describe')));
 const definitions=[['Germany','DE','DWD'],['Netherlands','NL','KNMI'],['Belgium','BE','RMI/KMI'],['Luxembourg','LU','MeteoLux'],['Czechia','CZ','ČHMÚ'],['Slovakia','SK','SHMÚ'],['Spain','ES','AEMET'],['Italy','IT','MeteoAM'],['Greece','GR','HNMS'],['Turkey','TR','MGM']];
 h.c.nordicWarnings=definitions.map(([country,code,service])=>({country,identifier:code,level:'Moderate',effective:updatedAt,onset:updatedAt,expires:future,polygons:[polygon],circles:[],area:'Official region',headline:'Official wind warning',event:'Wind',instruction:'Take care',sourceName:service,sourcePage:'https://meteoalarm.org/',marine:code==='NL'}));
 assert.equal(await h.run('renderNordicWarnings()'),definitions.length);
 definitions.forEach(([country,code,service],i)=>{assert.equal(layers[i].warningRecord.country,country);assert.match(layers[i].content(),new RegExp(service));assert.match(layers[i].content(),/Take care/);assert.equal(layers[i].options.fill===false,code==='NL');});
 assert.equal(layers[1].options.dashArray,'9 6');assert.equal(cards.length,definitions.length);
 // The same selection removes map paths and cards, while retaining source data.
 const originalDollar=h.c.$;
 h.c.$=id=>id==='warningSeverityYellow'?{checked:false}:originalDollar(id);
 h.c.nordicWarnings[0].level='Extreme';h.c.nordicWarnings[1].level='Severe';
 layers.length=0;cards.length=0;
 assert.equal(await h.run('renderNordicWarnings()'),2);
 assert.equal(layers.length,2);assert.equal(cards.length,2);
 assert.equal(layers[0].options.color,'#e03131');assert.equal(layers[1].options.color,'#ff8c1a');
 assert.equal(h.c.nordicWarnings.length,definitions.length);
 h.c.$=originalDollar;layers.length=0;cards.length=0;
 assert.equal(await h.run('renderNordicWarnings()'),definitions.length);

});

test('severity boxes default to all levels and combine with country and date filters',()=>{
 const h=harness(),nodes=Object.fromEntries(['Yellow','Orange','Red','Other'].map(name=>['warningSeverity'+name,{checked:true}]));
 h.c.$=id=>nodes[id]||h.status;
 const base={effective:updatedAt,expires:future,country:'Greece'};
 h.c.selection=[{...base,level:'Extreme'},{...base,level:'Severe'},{...base,level:'Moderate'},{...base,level:'Information'},
  {...base,country:'Estonia',level:'3'},{...base,country:'Estonia',level:'2'},{...base,country:'Estonia',level:'1'}];
 assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),7);
 nodes.warningSeverityYellow.checked=false;nodes.warningSeverityOther.checked=false;
 assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),4);
 nodes.warningSeverityOrange.checked=false;
 assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),2);
 h.c.NorthernCountryFocus={matchesCountry:c=>c==='Greece'};
 assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),1);
 h.c.selection[0].expires=past;assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),0);
 nodes.warningSeverityRed.checked=false;assert.equal(h.run('warningsForTodayAndTomorrow(selection).length'),0);
 assert.equal(h.c.selection.length,7);
});
