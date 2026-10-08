const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=name=>fs.readFileSync(require('node:path').join(__dirname,'../js',name),'utf8');
function harness(){
  const status={checked:true,textContent:'',className:''};
  const c={Date,Intl,Map,Number,Object,Array,Math,JSON,console,$:()=>status,
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
for(const country of ['Latvia','Poland','Denmark','Greenland','Canada'])test(`${country}: overdue warnings remain visible, expired ones disappear`,()=>{
  const h=harness();const record={country,level:'Moderate',effective:updatedAt,expires:future,messageExpires:future,polygons:[polygon]};
  h.c.record=record;h.c.snapshot={version:1,updatedAt,records:[record]};
  if(country==='Latvia')h.run('records=validateLatviaSnapshot(snapshot)');
  else {h.c.snapshot.countries={[({Poland:'PL',Denmark:'DK',Greenland:'GL',Canada:'CA'})[country]]:{country,updatedAt,records:[record]}};h.run(`records=validateNationalWarningCountry(snapshot,'${({Poland:'PL',Denmark:'DK',Greenland:'GL',Canada:'CA'})[country]}')`);}
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
  h.c.warningLayerGroup={addLayer:layer=>layers.push(layer)};
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
  assert.match(layers[0].content,/Statement · Information/);
  assert.match(cards[0].innerHTML,/Statement · Information/);
  assert.equal(layers[0].warningRecord.country,'Canada');
  assert.equal(layers[1].options.fill,false);
  assert.equal(layers[1].options.dashArray,'9 6');
});
