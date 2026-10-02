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

  $('warningStatus').textContent='Loading Estonia warnings…';
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

  $('warningStatus').textContent=
    `${warningRecords.length} Estonia warning records loaded · loading Lithuania…`;
  $('warningStatus').className=estoniaError?'status warn':'status ok';

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

  if(!map.hasLayer(warningLayerGroup)) warningLayerGroup.addTo(map);
  weatherFront();

  const total=warningRecords.length+lithuaniaWarnings.length;
  const parts=[`${total} EE + LT warning records`];

  if(lithuaniaWarnings.length){
    parts.push(`${lithuaniaWarnings.length} Lithuania`);
  }

  if(ltMapped){
    parts.push(`${ltMapped} Lithuania map areas`);
  }

  if(ltResult?.fromCache){
    const mins=Math.max(1,Math.round((ltResult.cacheAgeMs||0)/60000));
    parts.push(`Lithuania cached ${mins} min old`);
  }

  if(estoniaError) parts.push('Estonia unavailable');
  if(ltError) parts.push('Lithuania unavailable');

  $('warningStatus').textContent=parts.join(' · ');
  $('warningStatus').className=(estoniaError||ltError)?'status warn':'status ok';
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
