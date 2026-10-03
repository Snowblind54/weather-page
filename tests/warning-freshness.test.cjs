const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=name=>fs.readFileSync(require('node:path').join(__dirname,'../js',name),'utf8');
function harness(){
  const status={checked:true,textContent:'',className:''};
  const c={Date,Intl,Map,Number,Object,Array,Math,JSON,console,$:()=>status,
    warningRecords:[],lithuaniaWarnings:[],nordicWarnings:[],
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
for(const country of ['Latvia','Poland','Denmark'])test(`${country}: overdue warnings remain visible, expired ones disappear`,()=>{
  const h=harness();const record={country,level:'Moderate',effective:updatedAt,expires:future,polygons:[polygon]};
  h.c.record=record;h.c.snapshot={version:1,updatedAt,records:[record]};
  if(country==='Latvia')h.run('records=validateLatviaSnapshot(snapshot)');
  else {h.c.snapshot.countries={[country==='Poland'?'PL':'DK']:{country,updatedAt,records:[record]}};h.run(`records=validateNationalWarningCountry(snapshot,'${country==='Poland'?'PL':'DK'}')`);}
  assert.equal(h.run('records.length'),1);
  assert.equal(h.run('warningIsTodayOrTomorrow(records[0])'),true);
  h.c.nordicWarnings=h.run('records');
  h.run('updateVisibleWarningStatus()');assert.match(h.status.textContent,/Updates overdue/);assert.match(h.status.textContent,new RegExp(country));
  record.expires=past;assert.equal(h.run('warningIsTodayOrTomorrow(record)'),false);
});
