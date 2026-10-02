// Warning display refinements for v8.4.
// Keep the source feeds intact, but display only warnings relevant to today
// or tomorrow in each warning country's local time.

const WARNING_COUNTRY_TIMEZONES={
  Estonia:'Europe/Tallinn',
  Lithuania:'Europe/Vilnius',
  Finland:'Europe/Helsinki',
  Sweden:'Europe/Stockholm',
  Norway:'Europe/Oslo',
  Iceland:'Atlantic/Reykjavik'
};

function warningCountry(record){
  return record?.country || 'Estonia';
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
  const timeZone=WARNING_COUNTRY_TIMEZONES[country] || 'Europe/Tallinn';
  const today=warningDateKey(new Date(),timeZone);
  const tomorrow=warningAddDays(today,1);

  const startMs=Date.parse(record?.effective || record?.onset || '');
  const endMs=Date.parse(record?.expires || '');

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

      warningLayerGroup.addLayer(layer);
      if(!firstLayer) firstLayer=layer;
      mapped++;
    }

    const card=document.createElement('div');
    card.className='warning-card';
    card.style.borderLeftColor=sev.color;

    const end=record.expires
      ? new Date(record.expires).toLocaleString()
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
        window.open(record.capUrl||NORDIC_WARNING_PAGE,'_blank','noopener');
      }
    });

    list.appendChild(card);
  }

  return mapped;
};

// Keep the existing data-loading/error handling, but replace its final count
// with the number the user can actually see after the two-day filter.
const loadWarningsAllDays=loadWarnings;
loadWarnings=async function(force=false){
  await loadWarningsAllDays(force);

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
    ['Estonia','EE'],['Lithuania','LT'],['Finland','FI'],
    ['Sweden','SE'],['Norway','NO'],['Iceland','IS']
  ]){
    const count=counts.get(country)||0;
    if(count) parts.push(`${label} ${count}`);
  }

  if(previous.includes('cached')) parts.push('cached source used');
  if(previous.includes('FI text fallback')) parts.push('FI text fallback');
  if(previous.includes('unavailable')) parts.push('some source unavailable');

  $('warningStatus').textContent=parts.join(' · ');
};
