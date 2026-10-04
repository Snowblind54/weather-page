// Warning display refinements for v8.4.
// Keep the source feeds intact, but display only warnings relevant to today
// or tomorrow in each warning country's local time.

const WARNING_COUNTRY_TIMEZONES={
  Estonia:'Europe/Tallinn',
  Latvia:'Europe/Riga',
  Lithuania:'Europe/Vilnius',
  Finland:'Europe/Helsinki',
  Sweden:'Europe/Stockholm',
  Norway:'Europe/Oslo',
  Iceland:'Atlantic/Reykjavik',
  Poland:'Europe/Warsaw',
  Denmark:'Europe/Copenhagen'
};

function warningCountry(record){
  return record?.country || 'Estonia';
}

function warningLocalTime(value,country){
  const date=new Date(value);
  if(!value || !Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB',{
    timeZone:WARNING_COUNTRY_TIMEZONES[country]||'Europe/Tallinn',
    day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'
  }).format(date);
}

function warningDateKey(date,timeZone){
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone,
    year:'numeric',
    month:'2-digit',
    day:'2-digit'
  }).formatToParts(date);

  const values={};
  for(const part of parts){
    if(part.type==='year' || part.type==='month' || part.type==='day'){
      values[part.type]=part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function warningAddDays(dateKey,days){
  const [year,month,day]=dateKey.split('-').map(Number);
  const d=new Date(Date.UTC(year,month-1,day+days));
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth()+1).padStart(2,'0'),
    String(d.getUTCDate()).padStart(2,'0')
  ].join('-');
}

function warningIsTodayOrTomorrow(record){
  const country=warningCountry(record);
  const endMs=Date.parse(record?.expires || '');
  // Calendar-day filtering alone kept Lithuanian warnings visible for hours
  // after their official end time. Apply exact expiry to every country.
  if(Number.isFinite(endMs) && endMs<=Date.now()) return false;
  // Snapshot age describes update health; validity decides visibility.
  if(['Latvia','Poland','Denmark'].includes(country) && !Number.isFinite(endMs)) return false;
  const timeZone=WARNING_COUNTRY_TIMEZONES[country] || 'Europe/Tallinn';
  const today=warningDateKey(new Date(),timeZone);
  const tomorrow=warningAddDays(today,1);

  const startMs=Date.parse(record?.onset || record?.effective || '');

  // Active warning feeds occasionally omit one or both validity fields.
  // Do not hide those records merely because a timestamp is unavailable.
  if(!Number.isFinite(startMs) && !Number.isFinite(endMs)) return true;

  const startKey=Number.isFinite(startMs)
    ? warningDateKey(new Date(startMs),timeZone)
    : today;
  const endKey=Number.isFinite(endMs)
    ? warningDateKey(new Date(endMs),timeZone)
    : tomorrow;

  // Includes warnings already in force today, warnings beginning tomorrow,
  // and warnings spanning across either of those two calendar days.
  return startKey<=tomorrow && endKey>=today;
}

function warningsForTodayAndTomorrow(records){
  return (records||[]).filter(warningIsTodayOrTomorrow);
}

// Filter Estonia and Lithuania at render time without destroying the full
// source arrays. This means later refreshes can still promote a warning into
// the two-day window when its date arrives.
const renderWarningsAllDays=renderWarnings;
renderWarnings=async function(){
  const all=warningRecords;
  warningRecords=warningsForTodayAndTomorrow(all);
  try{
    return await renderWarningsAllDays();
  }finally{
    warningRecords=all;
    scheduleWarningExpiryRefresh();
  }
};

const renderLithuaniaWarningsAllDays=renderLithuaniaWarnings;
renderLithuaniaWarnings=async function(){
  const all=lithuaniaWarnings;
  lithuaniaWarnings=warningsForTodayAndTomorrow(all);
  try{
    return await renderLithuaniaWarningsAllDays();
  }finally{
    lithuaniaWarnings=all;
    scheduleWarningExpiryRefresh();
  }
};

function isFinnishMarineWarning(record){
  if(record?.country!=='Finland') return false;

  const text=normalizeWarningArea([
    record.event,
    record.headline,
    record.area,
    record.description
  ].filter(Boolean).join(' '));

  // FMI's English CAP event names identify most marine warnings directly.
  if(
    text.includes('sea area') ||
    text.includes('sea wind') ||
    text.includes('wave height') ||
    text.includes('sea level') ||
    text.includes('ice accretion') ||
    text.includes('marine')
  ) return true;

  // Named Finnish marine forecast zones. This also covers cached/fallback
  // records where only the area name is available.
  return [
    'perameren',
    'selkameren',
    'merenkurkku',
    'ahvenanmeri',
    'suomenlahden',
    'pohjois itameren'
  ].some(name=>text.includes(name));
}

// Nordic renderer with two changes:
// 1) today + tomorrow filtering;
// 2) Finnish marine CAP polygons are drawn as dashed outlines with no fill.
// FMI marine polygons are forecast-zone geometry and are not coastline masks;
// an island can therefore lie geometrically inside a sea-zone polygon even
// though the warning itself applies only to the sea area.
renderNordicWarnings=async function(){
  const visibleWarnings=warningsForTodayAndTomorrow(nordicWarnings);
  if(!visibleWarnings.length) return 0;

  const list=$('warningList');
  let mapped=0;

  for(const record of visibleWarnings){
    const sev=warningSeverity(record.level);
    const marine=isFinnishMarineWarning(record);
    let firstLayer=null;

    for(const polygon of (record.polygons||[])){
      const options=marine ? {
        pane:'warningPane',
        color:sev.color,
        weight:4,
        opacity:.98,
        dashArray:'9 6',
        fill:false
      } : {
        pane:'warningPane',
        color:sev.color,
        weight:3,
        opacity:.96,
        fillColor:sev.color,
        fillOpacity:.22
      };

      const layer=L.polygon(polygon,options)
        .bindPopup(nordicWarningPopupHtml(record),{maxWidth:380});

      layer.warningRecord=record;
      warningLayerGroup.addLayer(layer);
      if(!firstLayer) firstLayer=layer;
      mapped++;
    }

    for(const circle of (record.circles||[])){
      const options=marine ? {
        pane:'warningPane',
        radius:circle.radiusKm*1000,
        color:sev.color,
        weight:4,
        opacity:.98,
        dashArray:'9 6',
        fill:false
      } : {
        pane:'warningPane',
        radius:circle.radiusKm*1000,
        color:sev.color,
        weight:3,
        opacity:.96,
        fillColor:sev.color,
        fillOpacity:.20
      };

      const layer=L.circle(circle.center,options)
        .bindPopup(nordicWarningPopupHtml(record),{maxWidth:380});

      layer.warningRecord=record;
      warningLayerGroup.addLayer(layer);
      if(!firstLayer) firstLayer=layer;
      mapped++;
    }

    const card=document.createElement('div');
    card.className='warning-card';
    card.warningRecord=record;
    card.style.borderLeftColor=sev.color;

    const end=record.expires
      ? warningLocalTime(record.expires,record.country)
      : 'No expiry provided';

    card.innerHTML=
      `<div class="warning-title">${htmlEscape(record.flag+' '+(record.headline||record.event))}</div>`+
      `<div class="warning-meta">${htmlEscape(sev.name)} · until ${htmlEscape(end)}</div>`+
      `<div class="warning-area">${htmlEscape(record.area)}</div>`+
      (record.description
        ? `<div class="warning-meta" style="margin-top:4px">${htmlEscape(record.description)}</div>`
        : '')+
      (marine
        ? '<div class="warning-meta" style="margin-top:4px">Marine warning · dashed outline applies to the sea area only.</div>'
        : '')+
      (!firstLayer
        ? '<div class="warning-meta" style="margin-top:4px">Warning loaded, but no usable map geometry was available from the source.</div>'
        : '');

    card.addEventListener('click',()=>{
      if(firstLayer){
        const bounds=firstLayer.getBounds?.();
        if(bounds && bounds.isValid()) map.fitBounds(bounds.pad(.18));
        firstLayer.openPopup?.();
      }else{
        window.open(record.sourcePage||record.capUrl||NORDIC_WARNING_PAGE,'_blank','noopener');
      }
    });

    list.appendChild(card);
  }

  scheduleWarningExpiryRefresh();
  return mapped;
};

// Counts always describe the warnings currently eligible for display.
function overdueWarningCountries(){
  const updates=new Map();
  for(const record of nordicWarnings){
    if(['Latvia','Poland','Denmark'].includes(warningCountry(record))) updates.set(warningCountry(record),record.sourceUpdatedAt);
  }
  if(latviaWarningSnapshotUpdatedAt) updates.set('Latvia',latviaWarningSnapshotUpdatedAt);
  for(const country of Object.values(nationalWarningSnapshot?.countries||{})) updates.set(country.country,country.updatedAt);
  return [...updates].filter(([country,updated])=>{
    const age=Date.now()-Date.parse(updated);
    return Number.isFinite(age) && age>(country==='Latvia'?LATVIA_WARNING_MAX_AGE:NATIONAL_WARNING_MAX_AGE);
  }).map(([country])=>country);
}

function updateVisibleWarningStatus(){
  if(!$('warningOn').checked) return;

  const visible=[
    ...warningsForTodayAndTomorrow(warningRecords),
    ...warningsForTodayAndTomorrow(lithuaniaWarnings),
    ...warningsForTodayAndTomorrow(nordicWarnings)
  ];

  const counts=new Map();
  for(const record of visible){
    const country=warningCountry(record);
    counts.set(country,(counts.get(country)||0)+1);
  }

  const previous=$('warningStatus').textContent||'';
  const parts=[`${visible.length} warnings · today + tomorrow`];

  for(const [country,label] of [
    ['Estonia','EE'],['Latvia','LV'],['Lithuania','LT'],['Finland','FI'],
    ['Sweden','SE'],['Norway','NO'],['Iceland','IS'],['Poland','PL'],['Denmark','DK']
  ]){
    const count=counts.get(country)||0;
    if(count) parts.push(`${label} ${count}`);
  }

  if(previous.includes('cached')) parts.push('cached source used');
  if(previous.includes('FI text fallback')) parts.push('FI text fallback');
  if(previous.includes('unavailable')) parts.push('some source unavailable');
  if(previous.includes('LV unavailable')) parts.push('LV unavailable');

  const overdue=overdueWarningCountries();
  if(overdue.length) parts.push('Updates overdue: '+overdue.join(', '));
  $('warningStatus').textContent=parts.join(' · ');
  if(overdue.length) $('warningStatus').className='status warn';
}

let warningExpiryTimer=null;
function clearWarningExpiryRefresh(){
  if(warningExpiryTimer!==null) clearTimeout(warningExpiryTimer);
  warningExpiryTimer=null;
}

function purgeExpiredWarningDisplay(){
  if(!$('warningOn').checked) return;
  // Remove individual warning layers/cards immediately, without waiting for
  // another feed request or reloading administrative boundary geometry.
  const expiredLayers=[];
  warningLayerGroup.eachLayer(layer=>{
    if(layer.warningRecord && !warningIsTodayOrTomorrow(layer.warningRecord)) expiredLayers.push(layer);
  });
  for(const layer of expiredLayers) warningLayerGroup.removeLayer(layer);
  for(const card of [...$('warningList').children]){
    if(card.warningRecord && !warningIsTodayOrTomorrow(card.warningRecord)) card.remove();
  }
  if(!$('warningStatus').textContent.startsWith('Loading')) updateVisibleWarningStatus();
  scheduleWarningExpiryRefresh();
}

function scheduleWarningExpiryRefresh(){
  clearWarningExpiryRefresh();
  if(!$('warningOn').checked) return;
  const now=Date.now();
  const deadlines=[];
  for(const record of [...warningRecords,...lithuaniaWarnings,...nordicWarnings]){
    const expiry=Date.parse(record.expires);
    if(Number.isFinite(expiry) && expiry>now) deadlines.push(expiry);
    if(['Latvia','Poland','Denmark'].includes(warningCountry(record))){
      const maxAge=warningCountry(record)==='Latvia'?LATVIA_WARNING_MAX_AGE:NATIONAL_WARNING_MAX_AGE;
      const staleAt=Date.parse(record.sourceUpdatedAt)+maxAge+1;
      if(Number.isFinite(staleAt) && staleAt>now) deadlines.push(staleAt);
    }
  }
  // Recheck update health even when a snapshot contains no warnings.
  if(!deadlines.length && !latviaWarningSnapshotUpdatedAt && !nationalWarningSnapshot) return;
  // Timers can be delayed in a background tab. Recheck the clock at least
  // once a minute, and remove warnings as soon as their timestamp is reached.
  const delay=Math.max(1,Math.min(60000,(deadlines.length?Math.min(...deadlines)-now:60000)));
  warningExpiryTimer=setTimeout(purgeExpiredWarningDisplay,delay);
}

const loadWarningsAllDays=loadWarnings;
loadWarnings=async function(force=false){
  try{
    await loadWarningsAllDays(force);
  }finally{
    if($('warningOn').checked){
      purgeExpiredWarningDisplay();
      updateVisibleWarningStatus();
    }
  }
};

$('warningOn').addEventListener('change',()=>{
  if(!$('warningOn').checked) clearWarningExpiryRefresh();
  else scheduleWarningExpiryRefresh();
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') purgeExpiredWarningDisplay();
});
