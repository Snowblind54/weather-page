const KAIA_QUERY_URL='https://avaandmed.keskkonnaportaal.ee/api/lists/active/items/query';
const KAIA_FILE_BASE='https://avaandmed.keskkonnaportaal.ee/api/lists/active/items';
const ESTONIA_WARNING_PAGE='https://www.ilmateenistus.ee/ilm/prognoosid/hoiatused/?lang=en';
const ESTONIA_COUNTY_GEOJSON='https://raw.githubusercontent.com/buildig/EHAK/master/geojson/maakond.json';

let estoniaCountyGeo=null;
let estoniaWarningFetchedAt=0;

function htmlEscape(s){
  return String(s||'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#39;");
}

function normalizeText(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/maakond/g,'')
    .replace(/county/g,'')
    .replace(/[^a-z0-9õäöüšž]+/g,' ')
    .trim();
}

function severityInfo(level){
  const s=String(level||'').toLowerCase();
  const n=Number(String(level||'').match(/\d+/)?.[0]||0);

  if(n>=3 || s.includes('level 3') || s.includes('tase 3')){
    return {name:'Level 3 / Extreme',color:'#e03131',rank:3};
  }
  if(n===2 || s.includes('level 2') || s.includes('tase 2')){
    return {name:'Level 2 / Dangerous',color:'#ff8c1a',rank:2};
  }
  if(n===1 || s.includes('level 1') || s.includes('tase 1')){
    return {name:'Level 1 / Potentially dangerous',color:'#ffd43b',rank:1};
  }
  return {name:level||'Warning',color:'#ffd43b',rank:1};
}

async function kaiaQuery(body){
  const r=await fetch(KAIA_QUERY_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),
    cache:'no-store'
  });

  if(!r.ok) throw new Error('KAIA API HTTP '+r.status);
  return await r.json();
}

async function findKaiaWarningDocuments(){
  // Warning filenames/metadata can change, so use several lightweight title
  // searches instead of hard-coding one unpublished content-type id.
  const searches=['hoiatus','warning','.xml'];
  const found=new Map();

  for(const term of searches){
    const body={
      filter:{
        contains:{
          field:'RMTitle',
          value:term
        }
      },
      pageSize:40,
      includeFileMetadata:true,
      fields:['RMTitle','Timestamp','FP.ModifiedAt','RMFileType']
    };

    try{
      const j=await kaiaQuery(body);
      for(const d of (j.documents||[])){
        const title=String(d.metadata?.RMTitle||'');
        const lower=title.toLowerCase();

        // Keep plausible warning XML only; exclude obvious unrelated XML.
        const looksWarning=
          lower.includes('hoiatus') ||
          lower.includes('warning') ||
          lower.includes('alert');

        const files=(d.fileMetadata||[]);
        for(const fm of files){
          const name=String(fm.name||title||'');
          const n=name.toLowerCase();
          const xmlish=n.endsWith('.xml') || n.includes('.xml?') ||
                       String(d.metadata?.RMFileType||'').toLowerCase().includes('xml');

          if(xmlish && (looksWarning || term==='.xml' || term==='hoiatus' || term==='warning')){
            const key=d.id+'_'+fm.id;
            found.set(key,{
              docId:d.id,
              fileId:fm.id,
              name,
              title,
              timestamp:Date.parse(
                d.metadata?.Timestamp ||
                d.metadata?.['FP.ModifiedAt'] ||
                ''
              ) || 0
            });
          }
        }
      }
    }catch(e){
      console.warn('KAIA warning search failed for',term,e);
    }
  }

  return [...found.values()].sort((a,b)=>b.timestamp-a.timestamp);
}

async function fetchKaiaWarningXml(){
  const docs=await findKaiaWarningDocuments();

  if(!docs.length){
    throw new Error('KAIA returned no XML candidates');
  }

  docs.sort((a,b)=>{
    const aw=/^warnings\.xml$/i.test(a.name||'') ? 1 : 0;
    const bw=/^warnings\.xml$/i.test(b.name||'') ? 1 : 0;
    if(aw!==bw) return bw-aw;
    return (b.timestamp||0)-(a.timestamp||0);
  });

  let lastError=null;

  for(const d of docs.slice(0,30)){
    try{
      const url=`${KAIA_FILE_BASE}/${d.docId}/files/${d.fileId}`;
      const r=await fetch(url,{cache:'no-store'});
      if(!r.ok) throw new Error('file HTTP '+r.status);

      const text=await r.text();
      if(!text || text.length<20) throw new Error('empty XML');

      const probe=new DOMParser().parseFromString(text,'application/xml');
      if(probe.querySelector('parsererror')) throw new Error('not valid XML');

      const parsed=parseEstoniaWarnings(text);

      if(/^warnings\.xml$/i.test(d.name||'')){
        return {xml:text,source:d,parsed,authoritative:true};
      }

      if(parsed.length){
        return {xml:text,source:d,parsed,authoritative:false};
      }

      lastError=new Error(`XML candidate ${d.name} contained no parseable warning rows`);
    }catch(e){
      lastError=e;
    }
  }

  throw lastError || new Error('No usable KAIA warning XML found');
}

function textByNames(el,names){
  for(const name of names){
    const nodes=el.getElementsByTagName(name);
    if(nodes.length){
      const t=(nodes[0].textContent||'').trim();
      if(t) return t;
    }
  }
  return '';
}

function attrByNames(el,names){
  for(const n of names){
    const v=el.getAttribute?.(n);
    if(v) return v;
  }
  return '';
}

function looksLikeWarningNode(el){
  const tag=(el.tagName||'').toLowerCase();
  return ['warning','area','region','county','place','location'].some(x=>tag.includes(x));
}

function parseEstoniaWarnings(xmlText){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Warning XML could not be parsed');

  const countyDefs=[
    ['ida viru','Ida-Viru maakond',['ida-viru','ida viru','ida-virumaa','ida virumaa']],
    ['laane viru','Lääne-Viru maakond',['lääne-viru','lääne viru','laane-viru','laane viru','lääne-virumaa','laane virumaa']],
    ['jogeva','Jõgeva maakond',['jõgeva','jogevamaa','jõgevamaa','jogeva']],
    ['jarva','Järva maakond',['järva','jarva','järvamaa','jarvamaa']],
    ['polva','Põlva maakond',['põlva','polva','põlvamaa','polvamaa']],
    ['parnu','Pärnu maakond',['pärnu','parnu','pärnumaa','parnumaa']],
    ['voru','Võru maakond',['võru','voru','võrumaa','vorumaa']],
    ['harju','Harju maakond',['harju','harjumaa']],
    ['hiiu','Hiiu maakond',['hiiu','hiiumaa']],
    ['laane','Lääne maakond',['lääne','laane','läänemaa','laanemaa']],
    ['rapla','Rapla maakond',['rapla','raplamaa']],
    ['saare','Saare maakond',['saare','saaremaa']],
    ['tartu','Tartu maakond',['tartu','tartumaa']],
    ['valga','Valga maakond',['valga','valgamaa']],
    ['viljandi','Viljandi maakond',['viljandi','viljandimaa']]
  ];

  const marineDefs=[
    ['Soome lahe idaosa',['soome lahe idaosa']],
    ['Soome lahe lääneosa',['soome lahe lääneosa']],
    ['Läänemere põhjaosa',['läänemere põhjaosa','laanemere pohjaosa']],
    ['Väinameri',['väinameri','vainameri']],
    ['Liivi lahe põhjaosa',['liivi lahe põhjaosa','liivi lahe pohjaosa']],
    ['Peipsi järv',['peipsi järv','peipsi jarv']]
  ];

  const phenomena=[
    ['udu','Fog'],['fog','Fog'],
    ['tugev tuul','Strong wind'],['strong wind','Strong wind'],
    ['äike','Thunderstorm'],['aike','Thunderstorm'],['thunder','Thunderstorm'],
    ['jäide','Glaze ice'],['jaide','Glaze ice'],['glaze','Glaze ice'],
    ['kõrge tuleoht','High fire danger'],['korge tuleoht','High fire danger'],['fire danger','High fire danger'],
    ['tugev vihmasadu','Heavy rain'],['heavy rain','Heavy rain'],
    ['tugev lumesadu','Heavy snow'],['heavy snow','Heavy snow'],
    ['pakane','Severe frost'],['frost','Severe frost'],
    ['tuisk','Blizzard'],['blizzard','Blizzard'],
    ['ohtlik veetase','Dangerous water level'],['water level','Dangerous water level'],
    ['kuumus','Heat'],['heat','Heat']
  ];

  function plain(s){
    return String(s||'')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ')
      .trim();
  }

  function uniqueCounties(text){
    const t=plain(text);
    const hits=[];

    for(const [canon,label,aliases] of countyDefs){
      if(aliases.some(a=>t.includes(plain(a)))){
        hits.push({canon,label});
      }
    }

    // If Lääne-Viru matched, suppress the generic Lääne hit from same text.
    const hasLV=hits.some(h=>h.canon==='laane viru');
    return hits.filter(h=>!(hasLV && h.canon==='laane'));
  }

  function uniqueMarine(text){
    const t=plain(text);
    const hits=[];
    for(const [label,aliases] of marineDefs){
      if(aliases.some(a=>t.includes(plain(a)))) hits.push(label);
    }
    return [...new Set(hits)];
  }

  function inferEvent(text){
    const t=plain(text);
    for(const [needle,label] of phenomena){
      if(t.includes(plain(needle))) return label;
    }
    return '';
  }

  function inferLevel(text){
    const s=String(text||'');

    let m=s.match(/(?:warning[_\s-]*level|level|tase|severity|risk)[^0-9]{0,20}([0-3])/i);
    if(m) return m[1];

    // Common XML-style isolated level tags embedded in serialized text.
    m=s.match(/>\s*([0-3])\s*</);
    if(m) return m[1];

    return '';
  }

  function fieldValue(el,keys){
    const kk=keys.map(k=>plain(k).replace(/[^a-z0-9]/g,''));

    // attrs on current node
    for(const a of [...(el.attributes||[])]){
      const n=plain(a.localName||a.name).replace(/[^a-z0-9]/g,'');
      if(kk.some(k=>n===k || n.includes(k))){
        if(a.value) return a.value.trim();
      }
    }

    // descendants
    for(const n of [...el.getElementsByTagName('*')]){
      const nn=plain(n.localName||n.tagName).replace(/[^a-z0-9]/g,'');
      if(kk.some(k=>nn===k || nn.includes(k))){
        const t=(n.textContent||'').trim();
        if(t) return t;
      }

      for(const a of [...(n.attributes||[])]){
        const an=plain(a.localName||a.name).replace(/[^a-z0-9]/g,'');
        if(kk.some(k=>an===k || an.includes(k))){
          if(a.value) return a.value.trim();
        }
      }
    }
    return '';
  }

  const eventKeys=['phenomenon','phenomenonname','event','eventname','warningtype','warningname'];
  const levelKeys=['level','warninglevel','severity','severitylevel','risklevel','awarenesslevel'];
  const descKeys=['description','warningtext','message','details','desc'];
  const startKeys=['start','starttime','onset','effective','validfrom','begintime'];
  const endKeys=['end','endtime','expires','validto','until','expiretime'];

  const candidates=[];

  for(const el of [...doc.getElementsByTagName('*')]){
    const text=(el.textContent||'').trim();
    if(!text) continue;

    const counties=uniqueCounties(text);
    const marine=uniqueMarine(text);

    // Key rule:
    // accept only subtrees that resolve to exactly ONE geographic warning area.
    const totalAreas=counties.length+marine.length;
    if(totalAreas!==1) continue;

    let event=fieldValue(el,eventKeys) || inferEvent(text);
    let level=fieldValue(el,levelKeys) || inferLevel(text);
    const description=fieldValue(el,descKeys);
    const effective=fieldValue(el,startKeys);
    const expires=fieldValue(el,endKeys);

    const low=plain(text+' '+event+' '+level+' '+description);

    if(
      low.includes('hoiatused puuduvad') ||
      low.includes('warnings absent') ||
      low.includes('no warning') ||
      low.includes('no warnings')
    ) continue;

    if(String(level).trim()==='0') continue;
    if(!event && !level) continue;

    const area=counties.length ? counties[0].label : marine[0];

    if(!event) event='Weather warning';
    if(!level) level='1';

    candidates.push({
      area,event,level,
      description:description||'',
      effective:effective||'',
      expires:expires||'',
      depth:(el.parentElement ? 1 : 0) + [...el.getElementsByTagName('*')].length
    });
  }

  // Prefer the smallest subtree for each county/event/level so broad parent
  // containers don't win over the actual warning row.
  const byKey=new Map();

  for(const r of candidates){
    const key=[
      canonicalCountyName(r.area)||normalizeText(r.area),
      normalizeText(r.event),
      String(r.level).trim(),
      r.effective,
      r.expires
    ].join('|');

    const existing=byKey.get(key);

    if(
      !existing ||
      r.depth<existing.depth ||
      (!existing.description && r.description)
    ){
      byKey.set(key,r);
    }
  }

  return [...byKey.values()]
    .map(({depth,...r})=>r)
    .sort((a,b)=>{
      const sr=severityInfo(b.level).rank-severityInfo(a.level).rank;
      if(sr) return sr;
      return String(a.area).localeCompare(String(b.area),'et');
    });
}

const COUNTY_ALIASES={
  'harju':['harju','harjumaa'],
  'hiiu':['hiiu','hiiumaa'],
  'ida viru':['ida viru','ida virumaa'],
  'jogeva':['jogeva','jogevamaa','jõgeva','jõgevamaa'],
  'jarva':['jarva','jarvamaa','järva','järvamaa'],
  'laane':['laane','laanemaa','lääne','läänemaa'],
  'laane viru':['laane viru','laane virumaa','lääne viru','lääne virumaa'],
  'polva':['polva','polvamaa','põlva','põlvamaa'],
  'parnu':['parnu','parnumaa','pärnu','pärnumaa'],
  'rapla':['rapla','raplamaa'],
  'saare':['saare','saaremaa'],
  'tartu':['tartu','tartumaa'],
  'valga':['valga','valgamaa'],
  'viljandi':['viljandi','viljandimaa'],
  'voru':['voru','vorumaa','võru','võrumaa']
};


const ESTONIA_MARINE_WARNING_ZONES={
  'soome lahe lääneosa':[
    [59.15,22.85],[59.75,22.80],[60.05,23.65],[60.05,25.55],
    [59.82,25.65],[59.48,25.35],[59.25,24.55],[59.15,22.85]
  ],
  'soome lahe idaosa':[
    [59.35,25.45],[59.82,25.45],[60.05,26.15],[60.08,28.65],
    [59.68,28.75],[59.42,27.85],[59.35,25.45]
  ],
  'läänemere põhjaosa':[
    [57.75,20.20],[59.75,20.20],[59.75,22.95],[59.20,23.15],
    [58.85,22.80],[58.15,22.35],[57.75,20.20]
  ],
  'väinameri':[
    [58.15,22.25],[58.95,22.20],[59.15,22.85],[59.05,23.75],
    [58.65,24.10],[58.25,23.55],[58.15,22.25]
  ],
  'liivi lahe põhjaosa':[
    [57.35,22.35],[58.20,22.25],[58.45,23.20],[58.45,24.85],
    [57.75,24.85],[57.35,23.80],[57.35,22.35]
  ],  'peipsi järv':[
    [59.02,27.00],[58.88,27.55],[58.45,27.75],[57.88,27.45],
    [57.82,27.12],[58.15,26.92],[58.72,26.93],[59.02,27.00]
  ]
};

function normalizeMarineArea(text){
  const s=String(text||'').toLowerCase().trim();

  if(s.includes('soome lahe lääneosa') || s.includes('soome lahe laaneosa')) return 'soome lahe lääneosa';
  if(s.includes('soome lahe idaosa')) return 'soome lahe idaosa';
  if(s.includes('läänemere põhjaosa') || s.includes('laanemere pohjaosa')) return 'läänemere põhjaosa';
  if(s.includes('väinameri') || s.includes('vainameri')) return 'väinameri';
  if(s.includes('liivi lahe põhjaosa') || s.includes('liivi lahe pohjaosa')) return 'liivi lahe põhjaosa';
  if(s.includes('peipsi järv') || s.includes('peipsi jarv')) return 'peipsi järv';

  return '';
}

function canonicalCountyName(text){
  const n=normalizeText(text);

  // Specific / longer names first to avoid e.g. "Lääne" matching "Lääne-Viru".
  const ordered=[
    ['ida viru',['ida viru','ida virumaa']],
    ['laane viru',['laane viru','laane virumaa','lääne viru','lääne virumaa']],
    ['jogeva',['jogeva','jogevamaa','jõgeva','jõgevamaa']],
    ['jarva',['jarva','jarvamaa','järva','järvamaa']],
    ['polva',['polva','polvamaa','põlva','põlvamaa']],
    ['parnu',['parnu','parnumaa','pärnu','pärnumaa']],
    ['voru',['voru','vorumaa','võru','võrumaa']],
    ['harju',['harju','harjumaa']],
    ['hiiu',['hiiu','hiiumaa']],
    ['laane',['laane','laanemaa','lääne','läänemaa']],
    ['rapla',['rapla','raplamaa']],
    ['saare',['saare','saaremaa']],
    ['tartu',['tartu','tartumaa']],
    ['valga',['valga','valgamaa']],
    ['viljandi',['viljandi','viljandimaa']]
  ];

  for(const [canon,aliases] of ordered){
    for(const a of aliases){
      const aa=normalizeText(a);
      if(n===aa || n.includes(aa)) return canon;
    }
  }
  return '';
}

function featureCountyName(feature){
  const blob=Object.values(feature.properties||{}).join(' ');
  return canonicalCountyName(blob);
}

async function loadCountyGeometry(){
  if(estoniaCountyGeo) return estoniaCountyGeo;

  const r=await fetch(ESTONIA_COUNTY_GEOJSON,{cache:'force-cache'});
  if(!r.ok) throw new Error('County map HTTP '+r.status);
  estoniaCountyGeo=await r.json();
  return estoniaCountyGeo;
}

function warningPopupHtml(w){
  const sev=severityInfo(w.level);
  const start=w.effective?new Date(w.effective).toLocaleString():'';
  const end=w.expires?new Date(w.expires).toLocaleString():'';

  return `<div class="warning-popup">
    <h3>${htmlEscape(w.event)}</h3>
    <p class="sev" style="color:${sev.color}">${htmlEscape(sev.name)}</p>
    <p><b>Area:</b> ${htmlEscape(w.area)}</p>
    ${start||end?`<p><b>Valid:</b> ${htmlEscape(start)}${start&&end?' – ':''}${htmlEscape(end)}</p>`:''}
    ${w.description?`<p>${htmlEscape(w.description)}</p>`:''}
    <p><a href="${ESTONIA_WARNING_PAGE}" target="_blank" rel="noopener">Official Estonian warning page ↗</a></p>
  </div>`;
}

function clearWarningLayers(){
  if(map.hasLayer(warningLayerGroup)) map.removeLayer(warningLayerGroup);
  warningLayerGroup.clearLayers();
}

async function renderWarnings(){
  clearWarningLayers();
  const list=$('warningList');
  list.innerHTML='';

  if(!$('warningOn').checked) return;

  let countyGeo=null;
  try{
    countyGeo=await loadCountyGeometry();
  }catch(e){
    console.warn('County geometry unavailable',e);
  }

  let mapped=0;

  for(const w of warningRecords){
    const sev=severityInfo(w.level);
    const county=canonicalCountyName(w.area);
    let firstLayer=null;

    if(county && countyGeo){
      const matching=(countyGeo.features||[]).filter(f=>featureCountyName(f)===county);

      for(const f of matching){
        const layer=L.geoJSON(f,{
          pane:'warningPane',
          style:{
            pane:'warningPane',
            color:sev.color,
            weight:3,
            opacity:.95,
            fillColor:sev.color,
            fillOpacity:.24
          }
        });

        layer.bindPopup(warningPopupHtml(w),{maxWidth:360});
        warningLayerGroup.addLayer(layer);

        if(!firstLayer) firstLayer=layer;
        mapped++;
      }
    }

    // Marine and Peipsi warning zones.
    if(!firstLayer){
      const marineKey=normalizeMarineArea(w.area);
      const marinePoly=ESTONIA_MARINE_WARNING_ZONES[marineKey];

      if(marinePoly){
        const layer=L.polygon(marinePoly,{
          pane:'warningPane',
          color:sev.color,
          weight:3,
          opacity:.98,
          dashArray:'7 5',
          fillColor:sev.color,
          fillOpacity:.20
        });

        layer.bindPopup(warningPopupHtml(w),{maxWidth:360});
        warningLayerGroup.addLayer(layer);

        firstLayer=layer;
        mapped++;
      }
    }


    const card=document.createElement('div');
    card.className='warning-card';
    card.style.borderLeftColor=sev.color;

    const end=w.expires?new Date(w.expires).toLocaleString():'No expiry provided';

    card.innerHTML=
      `<div class="warning-title">${htmlEscape(w.event)}</div>`+
      `<div class="warning-meta">${htmlEscape(sev.name)} · until ${htmlEscape(end)}</div>`+
      `<div class="warning-area">${htmlEscape(w.area)}</div>`+
      (w.description?`<div class="warning-meta" style="margin-top:4px">${htmlEscape(w.description)}</div>`:'')+
      (!firstLayer?`<div class="warning-meta" style="margin-top:4px">This warning area is listed, but no map polygon is available for it.</div>`:'');

    card.addEventListener('click',()=>{
      if(firstLayer){
        const b=firstLayer.getBounds?.();
        if(b && b.isValid()) map.fitBounds(b.pad(.22));
        firstLayer.openPopup?.();
      }else{
        window.open(ESTONIA_WARNING_PAGE,'_blank','noopener');
      }
    });

    list.appendChild(card);
  }

  warningLayerGroup.addTo(map);
  weatherFront();

  if(warningRecords.length){
    $('warningStatus').textContent=
      `${warningRecords.length} active Estonian warnings · ${mapped} mapped warning areas`;
    $('warningStatus').className=mapped?'status ok':'status warn';
  }else{
    $('warningStatus').textContent='No active Estonian weather warnings.';
    $('warningStatus').className='status ok';
  }
}

async function loadWarnings(force=false){
  if(!$('warningOn').checked) return;

  const generation=++warningLoadGeneration;
  $('warningStatus').textContent='Loading severe weather warnings…';
  $('warningStatus').className='status';

  let estoniaError=null;
  try{
    if(force || Date.now()-estoniaWarningFetchedAt>=10*60*1000){
      const result=await fetchKaiaWarningXml();
      if(generation!==warningLoadGeneration) return;
      warningRecords=result.parsed ?? parseEstoniaWarnings(result.xml);
      estoniaWarningFetchedAt=Date.now();
    }
  }catch(e){
    console.error(e);
    estoniaError=e;
    warningRecords=[];
  }

  if(generation!==warningLoadGeneration) return;
  await renderWarnings();

  let ltResult=null;
  let ltError=null;
  try{
    ltResult=await loadLithuaniaWarnings(force);
    lithuaniaWarnings=ltResult.records||[];
  }catch(e){
    console.error(e);
    ltError=e;
    lithuaniaWarnings=[];
  }

  if(generation!==warningLoadGeneration) return;
  const ltMapped=await renderLithuaniaWarnings();

  let nordicResult=null;
  let nordicError=null;
  try{
    nordicResult=await loadNordicWarnings(force);
    nordicWarnings=nordicResult.records||[];
  }catch(e){
    console.error(e);
    nordicError=e;
    nordicWarnings=[];
  }

  if(generation!==warningLoadGeneration) return;
  const nordicMapped=await renderNordicWarnings();

  if(!map.hasLayer(warningLayerGroup)) warningLayerGroup.addTo(map);
  weatherFront();

  const allRecords=[...warningRecords,...lithuaniaWarnings,...nordicWarnings];
  const counts=new Map();
  for(const item of allRecords){
    const country=item.country||'Estonia';
    counts.set(country,(counts.get(country)||0)+1);
  }

  const parts=[`${allRecords.length} active warning records`];
  for(const [country,label] of [
    ['Estonia','EE'],['Lithuania','LT'],['Finland','FI'],
    ['Sweden','SE'],['Norway','NO'],['Iceland','IS']
  ]){
    if(counts.get(country)) parts.push(`${label} ${counts.get(country)}`);
  }

  const mappedTotal=ltMapped+nordicMapped;
  if(mappedTotal) parts.push(`${mappedTotal} additional mapped areas`);

  if(ltResult?.fromCache) parts.push('LT cached');
  if(nordicResult?.fromCache) parts.push('Nordics cached');
  if(estoniaError) parts.push('EE unavailable');
  if(ltError) parts.push('LT unavailable');
  if(nordicError) parts.push('Nordics unavailable');

  $('warningStatus').textContent=parts.join(' · ');
  $('warningStatus').className=(estoniaError||ltError||nordicError)?'status warn':'status ok';
}


const LT_WARNING_INDEX='https://www.meteo.lt/app/mu-plugins/Meteo/Components/WeatherWarningsNew/list_JSON.php';
const LT_WARNING_PAGE='https://www.meteo.lt/prognozes/pavojingi-reiskiniai/';
const LT_MUNICIPALITY_TOPO='https://raw.githubusercontent.com/govlt/powerbi-map-lt/main/topojson/LT-savivaldybes-municipalities.json';
const LT_CACHE_KEY='weatherMapLithuaniaWarningsV63';
const LT_CACHE_MAX_AGE=6*60*60*1000;

function corsDevUrl(url){
  return 'https://proxy.cors.dev/'+url;
}

async function fetchJsonViaCorsDev(url,timeoutMs=9000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);

  try{
    const r=await fetch(corsDevUrl(url),{
      cache:'no-store',
      signal:ctrl.signal,
      headers:{'Accept':'application/json,text/plain,*/*'}
    });

    if(!r.ok) throw new Error('HTTP '+r.status);

    const text=await r.text();
    if(!text) throw new Error('empty response');

    return JSON.parse(text);
  }finally{
    clearTimeout(timer);
  }
}

function ltText(v,preferred='en'){
  if(v==null) return '';
  if(typeof v==='string') return v;
  if(typeof v==='object'){
    return v[preferred] || v.lt || v.en ||
      Object.values(v).find(x=>typeof x==='string' && x.trim()) || '';
  }
  return String(v);
}

function ltNorm(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[.,()]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function ltSeverity(level){
  const s=ltNorm(level);

  if(s.includes('extreme') || s.includes('raudon') || s.includes('catastrophic')){
    return {name:'Red / Extreme',color:'#e03131',rank:3};
  }

  if(s.includes('severe') || s.includes('orange') || s.includes('oran') || s.includes('stich')){
    return {name:'Orange / Severe',color:'#ff8c1a',rank:2};
  }

  return {name:'Yellow / Moderate',color:'#ffd43b',rank:1};
}

function parseLithuaniaWarningJson(data){
  if(!data || Array.isArray(data)) return [];

  const records=[];

  for(const phenomenonGroup of (data.phenomenon_groups||[])){
    for(const areaGroup of (phenomenonGroup.area_groups||[])){
      const areas=areaGroup.areas||[];

      for(const alert of (areaGroup.single_alerts||[])){
        if(!alert.phenomenon) continue;

        const desc=ltText(alert.description);
        if(!desc) continue;

        for(const area of areas){
          if(!area?.name) continue;

          records.push({
            country:'Lithuania',
            area:area.name,
            event:String(alert.phenomenon||'Weather warning')
              .replace(/^(dangerous|severe|extreme)-/i,'')
              .replace(/-/g,' '),
            level:alert.severity||'Moderate',
            headline:ltText(alert.headline),
            description:desc,
            instruction:ltText(alert.instruction),
            effective:alert.t_from||'',
            expires:alert.t_to||'',
            category:phenomenonGroup.phenomenon_category||'weather'
          });
        }
      }
    }
  }

  const byKey=new Map();
  for(const w of records){
    const key=[
      ltNorm(w.area),
      ltNorm(w.event),
      ltNorm(w.level),
      w.effective,
      w.expires
    ].join('|');
    if(!byKey.has(key)) byKey.set(key,w);
  }

  return [...byKey.values()].sort((a,b)=>{
    const sr=ltSeverity(b.level).rank-ltSeverity(a.level).rank;
    if(sr) return sr;
    return String(a.area).localeCompare(String(b.area),'lt');
  });
}

function saveLithuaniaCache(records){
  try{
    localStorage.setItem(LT_CACHE_KEY,JSON.stringify({
      savedAt:Date.now(),
      records
    }));
  }catch(_){}
}

function loadLithuaniaCache(){
  try{
    const raw=localStorage.getItem(LT_CACHE_KEY);
    if(!raw) return null;
    const parsed=JSON.parse(raw);
    if(!parsed?.savedAt || !Array.isArray(parsed.records)) return null;
    return parsed;
  }catch(_){
    return null;
  }
}

async function loadLithuaniaWarnings(force=false){
  if(!force && lithuaniaWarnings.length && Date.now()-lithuaniaWarningLoadedAt<10*60*1000){
    return {records:lithuaniaWarnings,fromCache:false};
  }

  try{
    const files=await fetchJsonViaCorsDev(LT_WARNING_INDEX,9000);

    if(!Array.isArray(files)){
      throw new Error('warning index format changed');
    }

    if(!files.length){
      lithuaniaWarnings=[];
      lithuaniaWarningLoadedAt=Date.now();
      saveLithuaniaCache([]);
      return {records:[],fromCache:false};
    }

    const latest=String(files[0]||'').trim();
    if(!latest) throw new Error('empty latest warning file URL');

    const latestUrl=new URL(latest,LT_WARNING_INDEX).href;
    const data=await fetchJsonViaCorsDev(latestUrl,9000);

    lithuaniaWarnings=parseLithuaniaWarningJson(data);
    lithuaniaWarningLoadedAt=Date.now();
    saveLithuaniaCache(lithuaniaWarnings);

    return {records:lithuaniaWarnings,fromCache:false};
  }catch(e){
    const cached=loadLithuaniaCache();

    if(cached && Date.now()-cached.savedAt<LT_CACHE_MAX_AGE){
      lithuaniaWarnings=cached.records;
      lithuaniaWarningLoadedAt=Date.now();
      return {
        records:lithuaniaWarnings,
        fromCache:true,
        cacheAgeMs:Date.now()-cached.savedAt,
        error:e
      };
    }

    throw e;
  }
}

async function loadLithuaniaBoundaries(){
  if(lithuaniaBoundaryGeo) return lithuaniaBoundaryGeo;
  if(typeof topojson==='undefined') throw new Error('TopoJSON library unavailable');

  const r=await fetch(LT_MUNICIPALITY_TOPO,{cache:'force-cache'});
  if(!r.ok) throw new Error('Lithuania boundary HTTP '+r.status);

  const topo=await r.json();
  const objectName=Object.keys(topo.objects||{})[0];
  if(!objectName) throw new Error('Lithuania boundary dataset format changed');

  lithuaniaBoundaryGeo=topojson.feature(topo,topo.objects[objectName]);
  return lithuaniaBoundaryGeo;
}

const LT_COUNTY_MUNICIPALITIES={
  'alytaus':['alytaus miesto','alytaus rajono','druskininku','lazdiju rajono','varenos rajono'],
  'kauno':['birstono','jonavos rajono','kaisiadoriu rajono','kauno miesto','kauno rajono','kedainiu rajono','prienu rajono','raseiniu rajono'],
  'klaipedos':['klaipedos rajono','klaipedos miesto','kretingos rajono','neringos','palangos miesto','skuodo rajono','silutes rajono'],
  'marijampoles':['kalvarijos','kazlu rudos','marijampoles','sakiu rajono','vilkaviskio rajono'],
  'panevezio':['birzu rajono','kupiskio rajono','panevezio miesto','panevezio rajono','pasvalio rajono','rokiskio rajono'],
  'siauliu':['joniskio rajono','kelmes rajono','pakruojo rajono','akmenes rajono','radviliskio rajono','siauliu miesto','siauliu rajono'],
  'taurages':['jurbarko rajono','pagegiu','silales rajono','taurages rajono'],
  'telsiu':['mazeikiu rajono','plunges rajono','rietavo','telsiu rajono'],
  'utenos':['anyksciu rajono','ignalinos rajono','moletu rajono','utenos rajono','visagino','zarasu rajono'],
  'vilniaus':['elektrenu','salcininku rajono','sirvintu rajono','svencioniu rajono','traku rajono','ukmerges rajono','vilniaus miesto','vilniaus rajono']
};

function ltAreaKey(s){
  return ltNorm(s)
    .replace(/\bsavivaldybes\b/g,'')
    .replace(/\bsavivaldybe\b/g,'')
    .replace(/\bsav\b/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

function ltFeatureMunicipality(feature){
  const p=feature.properties||{};
  const raw=p.SAV_PAV || p.name || p.NAME || p.pavadinimas || '';
  let s=ltAreaKey(raw);

  s=s
    .replace(/\bm\b/g,'miesto')
    .replace(/\br\b/g,'rajono')
    .replace(/\s+/g,' ')
    .trim();

  return s;
}

function ltFeatureMatches(feature,warningArea){
  const area=ltAreaKey(warningArea);
  const mun=ltFeatureMunicipality(feature);

  if(!area || !mun) return false;

  if(area.includes('apskritis')){
    const countyBase=area.replace(/\bapskritis\b/g,'').trim();

    const countyMunicipalities=LT_COUNTY_MUNICIPALITIES[countyBase] || [];
    return countyMunicipalities.some(m=>{
      const mm=ltAreaKey(m);
      return mun===mm || mun.includes(mm) || mm.includes(mun);
    });
  }

  return (
    mun===area ||
    mun.includes(area) ||
    area.includes(mun)
  );
}

function lithuaniaPopupHtml(w){
  const sev=ltSeverity(w.level);
  const start=w.effective ? new Date(w.effective).toLocaleString() : '';
  const end=w.expires ? new Date(w.expires).toLocaleString() : '';

  return `<div class="warning-popup">
    <h3>${htmlEscape(w.headline||w.event)}</h3>
    <p class="sev" style="color:${sev.color}">${htmlEscape(sev.name)}</p>
    <p><b>Country:</b> Lithuania</p>
    <p><b>Area:</b> ${htmlEscape(w.area)}</p>
    ${start||end?`<p><b>Valid:</b> ${htmlEscape(start)}${start&&end?' – ':''}${htmlEscape(end)}</p>`:''}
    ${w.description?`<p>${htmlEscape(w.description)}</p>`:''}
    ${w.instruction?`<p><b>Instructions:</b> ${htmlEscape(w.instruction)}</p>`:''}
    <p><a href="${LT_WARNING_PAGE}" target="_blank" rel="noopener">Official Meteo.lt warning page ↗</a></p>
  </div>`;
}

async function renderLithuaniaWarnings(){
  const list=$('warningList');
  if(!lithuaniaWarnings.length) return 0;

  let geo=null;
  try{
    geo=await loadLithuaniaBoundaries();
  }catch(e){
    console.warn(e);
  }

  let mapped=0;

  for(const w of lithuaniaWarnings){
    const sev=ltSeverity(w.level);
    let firstLayer=null;

    if(geo){
      const matches=(geo.features||[]).filter(f=>ltFeatureMatches(f,w.area));

      for(const f of matches){
        const layer=L.geoJSON(f,{
          pane:'warningPane',
          style:{
            pane:'warningPane',
            color:sev.color,
            weight:3,
            opacity:.95,
            fillColor:sev.color,
            fillOpacity:.22
          }
        }).bindPopup(lithuaniaPopupHtml(w),{maxWidth:360});

        warningLayerGroup.addLayer(layer);
        if(!firstLayer) firstLayer=layer;
        mapped++;
      }
    }

    const card=document.createElement('div');
    card.className='warning-card';
    card.style.borderLeftColor=sev.color;

    const end=w.expires ? new Date(w.expires).toLocaleString() : 'No expiry provided';

    card.innerHTML=
      `<div class="warning-title">🇱🇹 ${htmlEscape(w.headline||w.event)}</div>`+
      `<div class="warning-meta">${htmlEscape(sev.name)} · until ${htmlEscape(end)}</div>`+
      `<div class="warning-area">${htmlEscape(w.area)}</div>`+
      (w.description?`<div class="warning-meta" style="margin-top:4px">${htmlEscape(w.description)}</div>`:'')+
      (!firstLayer?`<div class="warning-meta" style="margin-top:4px">Warning loaded, but its administrative boundary was not matched.</div>`:'');

    card.addEventListener('click',()=>{
      if(firstLayer){
        const b=firstLayer.getBounds?.();
        if(b && b.isValid()) map.fitBounds(b.pad(.18));
        firstLayer.openPopup?.();
      }else{
        window.open(LT_WARNING_PAGE,'_blank','noopener');
      }
    });

    list.appendChild(card);
  }

  return mapped;
}

// -----------------------------------------------------------------------------
// Nordic severe-weather warnings — MeteoAlarm Atom feeds + linked CAP messages
// -----------------------------------------------------------------------------

const NORDIC_WARNING_SOURCES=[
  {
    country:'Sweden',flag:'🇸🇪',slug:'sweden',
    feed:'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-sweden'
  },
  {
    country:'Norway',flag:'🇳🇴',slug:'norway',
    feed:'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-norway'
  },
  {
    country:'Iceland',flag:'🇮🇸',slug:'iceland',
    feed:'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-iceland'
  }
];

const NORDIC_WARNING_PAGE='https://meteoalarm.org/';
const FMI_WARNING_PAGE='https://en.ilmatieteenlaitos.fi/warnings';
const FMI_WARNING_RSS='https://alerts.fmi.fi/cap/feed/rss_en-GB.rss';
const FMI_WARNING_ATOM='https://alerts.fmi.fi/cap/feed/atom_en-GB.xml';
const FINLAND_METEOALARM_FALLBACK={
  country:'Finland',flag:'🇫🇮',slug:'finland',
  feed:'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-finland'
};
const NORDIC_WARNING_CACHE_KEY='weatherMapNordicWarningsV83';
const NORDIC_WARNING_CACHE_MAX_AGE=6*60*60*1000;
const NORDIC_WARNING_REFRESH_MS=15*60*1000;

let nordicWarnings=[];
let nordicWarningLoadedAt=0;
const nordicCapPromiseCache=new Map();

function xmlLocalElements(root,name){
  return [...root.getElementsByTagName('*')].filter(el=>el.localName===name);
}

function xmlLocalText(root,name){
  const el=xmlLocalElements(root,name)[0];
  return (el?.textContent||'').trim();
}

function warningSeverity(level){
  const s=String(level||'').toLowerCase();

  if(s.includes('extreme') || s.includes('red')){
    return {name:'Red / Extreme',color:'#e03131',rank:3};
  }
  if(s.includes('severe') || s.includes('orange')){
    return {name:'Orange / Severe',color:'#ff8c1a',rank:2};
  }
  if(s.includes('moderate') || s.includes('yellow')){
    return {name:'Yellow / Moderate',color:'#ffd43b',rank:1};
  }

  return {name:level||'Weather warning',color:'#ffd43b',rank:1};
}

async function fetchWarningText(url,timeoutMs=12000){
  const attempt=async target=>{
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
      const response=await fetch(target,{
        cache:'no-store',
        signal:ctrl.signal,
        headers:{'Accept':'application/atom+xml,application/xml,text/xml,text/plain,*/*'}
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      const text=await response.text();
      if(!text.trim()) throw new Error('empty response');
      return text;
    }finally{
      clearTimeout(timer);
    }
  };

  try{
    return await attempt(url);
  }catch(directError){
    try{
      return await attempt(corsDevUrl(url));
    }catch(proxyError){
      throw new Error(
        'warning feed unavailable ('+
        (proxyError?.message||directError?.message||'network error')+
        ')'
      );
    }
  }
}

function parseCapPolygon(text){
  const points=String(text||'').trim().split(/\s+/).map(pair=>{
    const [lat,lon]=pair.split(',').map(Number);
    return Number.isFinite(lat)&&Number.isFinite(lon)?[lat,lon]:null;
  }).filter(Boolean);

  return points.length>=3?points:null;
}

function parseCapCircle(text){
  const m=String(text||'').trim().match(
    /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/
  );
  if(!m) return null;
  return {
    center:[Number(m[1]),Number(m[2])],
    radiusKm:Number(m[3])
  };
}

function normalizeWarningArea(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function chooseCapInfo(doc){
  const infos=xmlLocalElements(doc,'info');
  if(!infos.length) return null;

  return infos.find(info=>{
    const lang=xmlLocalText(info,'language').toLowerCase();
    return lang==='en' || lang.startsWith('en-');
  }) || infos[0];
}

function parseNordicCap(xmlText,preferredArea=''){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('CAP XML parse failed');

  const info=chooseCapInfo(doc);
  if(!info) return null;

  const areas=xmlLocalElements(info,'area').map(area=>({
    area:xmlLocalText(area,'areaDesc'),
    polygons:xmlLocalElements(area,'polygon')
      .map(el=>parseCapPolygon(el.textContent))
      .filter(Boolean),
    circles:xmlLocalElements(area,'circle')
      .map(el=>parseCapCircle(el.textContent))
      .filter(Boolean)
  }));

  const wanted=normalizeWarningArea(preferredArea);
  const selected=areas.find(a=>{
    const n=normalizeWarningArea(a.area);
    return wanted && n && (n===wanted || n.includes(wanted) || wanted.includes(n));
  }) || areas.find(a=>a.polygons.length || a.circles.length) || areas[0] || null;

  // CAP alerts may contain several <area> blocks. Finland in particular can
  // publish one warning with multiple geographic areas and localized areaDesc
  // names. The old parser kept geometry only from an exact area-name match,
  // which could leave a valid Finnish warning card with zero map polygons.
  //
  // Every geometry in the selected CAP <info> belongs to this alert, so retain
  // all of it and deduplicate identical shapes before rendering.
  const polygonMap=new Map();
  const circleMap=new Map();

  for(const area of areas){
    for(const polygon of area.polygons){
      const key=polygon
        .map(([lat,lon])=>lat.toFixed(5)+','+lon.toFixed(5))
        .join(' ');
      if(!polygonMap.has(key)) polygonMap.set(key,polygon);
    }

    for(const circle of area.circles){
      const key=[
        circle.center[0].toFixed(5),
        circle.center[1].toFixed(5),
        circle.radiusKm.toFixed(3)
      ].join(',');
      if(!circleMap.has(key)) circleMap.set(key,circle);
    }
  }

  return {
    headline:xmlLocalText(info,'headline'),
    event:xmlLocalText(info,'event'),
    severity:xmlLocalText(info,'severity'),
    effective:xmlLocalText(info,'effective') || xmlLocalText(info,'onset'),
    expires:xmlLocalText(info,'expires'),
    description:xmlLocalText(info,'description'),
    instruction:xmlLocalText(info,'instruction'),
    area:selected?.area||preferredArea,
    polygons:[...polygonMap.values()],
    circles:[...circleMap.values()]
  };
}

async function fetchNordicCap(url,preferredArea){
  if(!url) return null;

  const key=url+'|'+normalizeWarningArea(preferredArea);
  if(nordicCapPromiseCache.has(key)) return nordicCapPromiseCache.get(key);

  const promise=(async()=>{
    const xml=await fetchWarningText(url,12000);
    return parseNordicCap(xml,preferredArea);
  })();

  nordicCapPromiseCache.set(key,promise);
  try{
    return await promise;
  }finally{
    // Keep fulfilled results only during this page session through the Promise map.
  }
}

function parseFmiCapAlert(alert,capUrl=''){
  if(!alert) return null;

  const status=xmlLocalText(alert,'status');
  const messageType=xmlLocalText(alert,'msgType');
  if(status && status.toLowerCase()!=='actual') return null;
  if(messageType && messageType.toLowerCase()==='cancel') return null;

  const info=chooseCapInfo(alert);
  if(!info) return null;

  const expires=xmlLocalText(info,'expires');
  const expiryMs=Date.parse(expires||'');
  if(Number.isFinite(expiryMs) && expiryMs<Date.now()-2*60*1000) return null;

  const areas=xmlLocalElements(info,'area');
  const areaNames=[];
  const polygons=[];
  const circles=[];

  for(const area of areas){
    const name=xmlLocalText(area,'areaDesc');
    if(name && !areaNames.includes(name)) areaNames.push(name);

    for(const node of xmlLocalElements(area,'polygon')){
      const polygon=parseCapPolygon(node.textContent);
      if(polygon) polygons.push(polygon);
    }

    for(const node of xmlLocalElements(area,'circle')){
      const circle=parseCapCircle(node.textContent);
      if(circle) circles.push(circle);
    }
  }

  const event=xmlLocalText(info,'event')||'Weather warning';
  const headline=xmlLocalText(info,'headline')||event;
  const officialWeb=xmlLocalText(info,'web');

  return {
    country:'Finland',
    flag:'🇫🇮',
    sourceSlug:'finland-fmi',
    area:areaNames.join(', ')||'Finland',
    event,
    level:xmlLocalText(info,'severity')||'Moderate',
    headline,
    description:xmlLocalText(info,'description'),
    instruction:xmlLocalText(info,'instruction'),
    effective:xmlLocalText(info,'effective')||xmlLocalText(info,'onset'),
    expires,
    identifier:xmlLocalText(alert,'identifier'),
    capUrl:capUrl||officialWeb||FMI_WARNING_PAGE,
    officialWeb:officialWeb||FMI_WARNING_PAGE,
    polygons,
    circles:[...circles],
    sourceName:'Finnish Meteorological Institute'
  };
}

function parseFmiCapXml(xmlText,capUrl=''){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('FMI CAP XML parse failed');

  const roots=[];
  if(doc.documentElement?.localName==='alert') roots.push(doc.documentElement);
  for(const alert of xmlLocalElements(doc,'alert')){
    if(!roots.includes(alert)) roots.push(alert);
  }

  return roots
    .map(alert=>parseFmiCapAlert(alert,capUrl))
    .filter(Boolean);
}

function fmiRssCapLinks(xmlText){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('FMI RSS XML parse failed');

  const links=new Set();

  for(const item of xmlLocalElements(doc,'item')){
    const candidates=[
      ...xmlLocalElements(item,'link').map(el=>(el.textContent||'').trim()),
      ...xmlLocalElements(item,'guid').map(el=>(el.textContent||'').trim())
    ];

    for(const candidate of candidates){
      if(!candidate) continue;

      // FMI RSS is a thin feed: entries point to the actual CAP document.
      // Accept any FMI CAP XML URL, including archived timestamped documents.
      const match=candidate.match(/https?:\/\/alerts\.fmi\.fi\/cap\/[^\s<>"']+\.xml(?:\?[^\s<>"']*)?/i);
      if(match) links.add(match[0].replace(/&amp;/g,'&'));
    }
  }

  return [...links];
}

async function loadFinlandOfficialWarnings(){
  // FMI recommends RSS when clients do not need every CAP message embedded in
  // the feed. It is much smaller than their "fat" Atom feed. Follow the RSS
  // links and fetch only the CAP documents that are actually current.
  const rss=await fetchWarningText(FMI_WARNING_RSS,12000);
  const links=fmiRssCapLinks(rss);

  if(links.length){
    const records=[];
    let next=0;

    const workers=Array.from({length:Math.min(4,links.length)},async()=>{
      while(true){
        const index=next++;
        if(index>=links.length) return;

        const url=links[index];
        try{
          const capXml=await fetchWarningText(url,12000);
          records.push(...parseFmiCapXml(capXml,url));
        }catch(e){
          console.warn('FMI CAP document unavailable',url,e);
        }
      }
    });

    await Promise.all(workers);
    if(records.length) return dedupeNordicWarnings(records);
  }

  // Defensive fallback: FMI describes its Atom endpoint as a "fat Atom" feed
  // containing the CAP messages inline. It is larger, so only use it when the
  // small RSS feed did not expose usable CAP links.
  const atom=await fetchWarningText(FMI_WARNING_ATOM,20000);
  const records=parseFmiCapXml(atom,FMI_WARNING_ATOM);
  return dedupeNordicWarnings(records);
}

async function loadFinlandWarningsWithFallback(){
  try{
    return {
      records:await loadFinlandOfficialWarnings(),
      official:true
    };
  }catch(officialError){
    console.warn('Official FMI warning feed unavailable; using MeteoAlarm text fallback',officialError);

    // Preserve alert cards even if FMI is temporarily unreachable. This
    // fallback may not contain polygons because MeteoAlarm can use EMMA_IDs.
    const xml=await fetchWarningText(FINLAND_METEOALARM_FALLBACK.feed,12000);
    const records=parseMeteoAlarmAtom(xml,FINLAND_METEOALARM_FALLBACK);
    await enrichNordicWarnings(records);

    return {
      records,
      official:false,
      error:officialError
    };
  }
}

function parseMeteoAlarmAtom(xmlText,source){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error(source.country+' Atom XML parse failed');

  const now=Date.now();
  const records=[];

  for(const entry of xmlLocalElements(doc,'entry')){
    const area=xmlLocalText(entry,'areaDesc');
    const event=xmlLocalText(entry,'event') || 'Weather warning';
    const severity=xmlLocalText(entry,'severity') || 'Moderate';
    const effective=xmlLocalText(entry,'effective') || xmlLocalText(entry,'onset');
    const expires=xmlLocalText(entry,'expires');
    const status=xmlLocalText(entry,'status');
    const messageType=xmlLocalText(entry,'message_type') || xmlLocalText(entry,'msgType');
    const identifier=xmlLocalText(entry,'identifier') || xmlLocalText(entry,'id');
    const title=xmlLocalText(entry,'title');

    if(status && status.toLowerCase()!=='actual') continue;
    if(messageType && messageType.toLowerCase()==='cancel') continue;

    const expiryMs=Date.parse(expires||'');
    if(Number.isFinite(expiryMs) && expiryMs<now-2*60*1000) continue;

    let capUrl='';
    for(const link of xmlLocalElements(entry,'link')){
      const type=String(link.getAttribute('type')||'').toLowerCase();
      const href=link.getAttribute('href')||'';
      if(type.includes('cap+xml') && href){
        capUrl=href;
        break;
      }
    }

    if(!area && !title) continue;

    records.push({
      country:source.country,
      flag:source.flag,
      sourceSlug:source.slug,
      area:area||source.country,
      event,
      level:severity,
      headline:title||event,
      description:'',
      instruction:'',
      effective,
      expires,
      identifier,
      capUrl,
      polygons:[],
      circles:[]
    });
  }

  return records;
}

async function enrichNordicWarnings(records){
  // Keep a small concurrency limit so a major warning day does not hammer the feeds.
  let next=0;
  const workers=Array.from({length:Math.min(4,records.length)},async()=>{
    while(true){
      const index=next++;
      if(index>=records.length) return;

      const record=records[index];
      if(!record.capUrl) continue;

      try{
        const cap=await fetchNordicCap(record.capUrl,record.area);
        if(!cap) continue;

        record.headline=cap.headline||record.headline;
        record.event=cap.event||record.event;
        record.level=cap.severity||record.level;
        record.effective=cap.effective||record.effective;
        record.expires=cap.expires||record.expires;
        record.description=cap.description||record.description;
        record.instruction=cap.instruction||record.instruction;
        record.area=cap.area||record.area;
        record.polygons=cap.polygons||[];
        record.circles=cap.circles||[];
      }catch(e){
        // The Atom feed itself is still enough to show a useful alert card.
        console.warn('CAP detail unavailable for',record.country,record.area,e);
      }
    }
  });

  await Promise.all(workers);
  return records;
}

function dedupeNordicWarnings(records){
  const mapByKey=new Map();

  for(const record of records){
    const key=[
      record.country,
      normalizeWarningArea(record.area),
      normalizeWarningArea(record.event),
      record.effective||'',
      record.expires||''
    ].join('|');

    const current=mapByKey.get(key);
    if(!current || warningSeverity(record.level).rank>warningSeverity(current.level).rank){
      mapByKey.set(key,record);
    }
  }

  return [...mapByKey.values()].sort((a,b)=>{
    const rank=warningSeverity(b.level).rank-warningSeverity(a.level).rank;
    if(rank) return rank;
    const country=String(a.country).localeCompare(String(b.country));
    if(country) return country;
    return String(a.area).localeCompare(String(b.area));
  });
}

function saveNordicWarningsCache(records){
  try{
    localStorage.setItem(NORDIC_WARNING_CACHE_KEY,JSON.stringify({
      savedAt:Date.now(),
      records
    }));
  }catch(_){}
}

function loadNordicWarningsCache(){
  try{
    const raw=localStorage.getItem(NORDIC_WARNING_CACHE_KEY);
    if(!raw) return null;
    const cached=JSON.parse(raw);
    if(!cached?.savedAt || !Array.isArray(cached.records)) return null;
    return cached;
  }catch(_){
    return null;
  }
}

async function loadNordicWarnings(force=false){
  if(!force &&
     nordicWarningLoadedAt &&
     Date.now()-nordicWarningLoadedAt<NORDIC_WARNING_REFRESH_MS){
    return {records:nordicWarnings,fromCache:false};
  }

  try{
    const tasks=[
      {
        country:'Finland',
        run:()=>loadFinlandWarningsWithFallback()
      },
      ...NORDIC_WARNING_SOURCES.map(source=>({
        country:source.country,
        run:async()=>{
          const xml=await fetchWarningText(source.feed,12000);
          const records=parseMeteoAlarmAtom(xml,source);
          await enrichNordicWarnings(records);
          return {records,official:false};
        }
      }))
    ];

    const results=await Promise.allSettled(tasks.map(task=>task.run()));
    const loaded=[];
    const failures=[];
    let finlandOfficial=true;

    results.forEach((result,index)=>{
      const task=tasks[index];
      if(result.status==='fulfilled'){
        loaded.push(...(result.value.records||[]));
        if(task.country==='Finland' && result.value.official===false){
          finlandOfficial=false;
        }
      }else{
        failures.push(task.country);
      }
    });

    if(failures.length===tasks.length){
      throw new Error('all Nordic warning feeds unavailable');
    }

    nordicWarnings=dedupeNordicWarnings(loaded);
    nordicWarningLoadedAt=Date.now();
    saveNordicWarningsCache(nordicWarnings);

    return {
      records:nordicWarnings,
      fromCache:false,
      failedCountries:failures,
      finlandOfficial
    };
  }catch(e){
    const cached=loadNordicWarningsCache();
    if(cached && Date.now()-cached.savedAt<NORDIC_WARNING_CACHE_MAX_AGE){
      nordicWarnings=cached.records;
      nordicWarningLoadedAt=Date.now();
      return {
        records:nordicWarnings,
        fromCache:true,
        cacheAgeMs:Date.now()-cached.savedAt,
        error:e
      };
    }
    throw e;
  }
}

function nordicWarningPopupHtml(record){
  const sev=warningSeverity(record.level);
  const start=record.effective?new Date(record.effective).toLocaleString():'';
  const end=record.expires?new Date(record.expires).toLocaleString():'';

  return `<div class="warning-popup">
    <h3>${htmlEscape(record.flag+' '+(record.headline||record.event))}</h3>
    <p class="sev" style="color:${sev.color}">${htmlEscape(sev.name)}</p>
    <p><b>Country:</b> ${htmlEscape(record.country)}</p>
    <p><b>Area:</b> ${htmlEscape(record.area)}</p>
    ${start||end?`<p><b>Valid:</b> ${htmlEscape(start)}${start&&end?' – ':''}${htmlEscape(end)}</p>`:''}
    ${record.description?`<p>${htmlEscape(record.description)}</p>`:''}
    ${record.instruction?`<p><b>Instructions:</b> ${htmlEscape(record.instruction)}</p>`:''}
    <p><a href="${record.capUrl||NORDIC_WARNING_PAGE}" target="_blank" rel="noopener">${record.country==='Finland'?'Official FMI CAP source':'MeteoAlarm / CAP source'} ↗</a></p>
  </div>`;
}

async function renderNordicWarnings(){
  if(!nordicWarnings.length) return 0;

  const list=$('warningList');
  let mapped=0;

  for(const record of nordicWarnings){
    const sev=warningSeverity(record.level);
    let firstLayer=null;

    for(const polygon of (record.polygons||[])){
      const layer=L.polygon(polygon,{
        pane:'warningPane',
        color:sev.color,
        weight:3,
        opacity:.96,
        fillColor:sev.color,
        fillOpacity:.22
      }).bindPopup(nordicWarningPopupHtml(record),{maxWidth:380});

      warningLayerGroup.addLayer(layer);
      if(!firstLayer) firstLayer=layer;
      mapped++;
    }

    for(const circle of (record.circles||[])){
      const layer=L.circle(circle.center,{
        pane:'warningPane',
        radius:circle.radiusKm*1000,
        color:sev.color,
        weight:3,
        opacity:.96,
        fillColor:sev.color,
        fillOpacity:.20
      }).bindPopup(nordicWarningPopupHtml(record),{maxWidth:380});

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
}

