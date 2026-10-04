// v8.6: historical Latvia + Lithuania radar support.
const LT_RADAR_INFO='https://beta.meteo.lt/?pid=radarai';
const LT_STEP=300;
const LV_STEP=600;
const HIST_TTL=4*60*1000;
const LV_DISCOVERY_TTL=15*60*1000;
const LV_LOCAL_KEY='balticWeatherLvRadarHistoryV86';
const histBundles=new Map();
const histFrames=new Map();
let ltTimeCache=null;
let lvDiscoveryCache=null;

async function radarText(url){
  const get=async u=>{
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),10000);
    try{
      const r=await fetch(u,{cache:'no-store',signal:c.signal});
      if(!r.ok) throw new Error('HTTP '+r.status);
      let baseUrl=url;
      try{
        const finalUrl=new URL(r.url||url);
        if(!finalUrl.hostname.includes('proxy.cors.dev')) baseUrl=finalUrl.href;
      }catch(_){}
      return {text:await r.text(),url:baseUrl};
    }finally{clearTimeout(t)}
  };
  try{return await get(url)}catch(_){return await get(directRadarProxyUrl(url))}
}

function localTimeToUnix(y,m,d,h,min,zone){
  let guess=Date.UTC(y,m-1,d,h,min);
  for(let k=0;k<2;k++){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
    const p={};
    for(const x of parts) if(x.type!=='literal') p[x.type]=Number(x.value);
    const shown=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second||0);
    guess=Date.UTC(y,m-1,d,h,min)-(shown-guess);
  }
  return Math.floor(guess/1000);
}

async function ltLatestUnix(force=false){
  if(!force&&ltTimeCache&&Date.now()-ltTimeCache.at<180000)return ltTimeCache.unix;
  let unix=Math.floor(Date.now()/1000/LT_STEP)*LT_STEP;
  try{
    const {text}=await radarText(LT_RADAR_INFO);
    const m=text.match(/Duomenys\s+atnaujinti\s*:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/i);
    if(m) unix=localTimeToUnix(+m[1],+m[2],+m[3],+m[4],+m[5],'Europe/Vilnius');
  }catch(e){console.warn('LT radar timestamp fallback',e)}
  ltTimeCache={at:Date.now(),unix};
  return unix;
}

async function animationBundle(url,force=false){
  const old=histBundles.get(url);
  if(!force&&old&&Date.now()-old.at<HIST_TTL)return old;
  const blob=await fetchDirectRadarBlob(url);
  const head=new Uint8Array(await blob.slice(0,6).arrayBuffer());
  const sig=String.fromCharCode(...head);
  const isGif=/^GIF8[79]a/.test(sig)||/\.gif(?:$|[?&#])/i.test(url)||String(blob.type||'').includes('gif');
  const type=isGif?'image/gif':(blob.type||'image/png');
  let count=1;
  if(isGif&&'ImageDecoder' in window){
    const dec=new ImageDecoder({data:await blob.arrayBuffer(),type:'image/gif'});
    try{await dec.tracks.ready;count=Math.max(1,dec.tracks.selectedTrack?.frameCount||1)}finally{try{dec.close()}catch(_){}}
  }
  const out={url,blob,type,count,at:Date.now()};
  histBundles.set(url,out);
  return out;
}

async function decodeBundleFrame(bundle,index){
  if(bundle.count<=1||!('ImageDecoder' in window))return decodeRadarDrawable(bundle.blob);
  const dec=new ImageDecoder({data:await bundle.blob.arrayBuffer(),type:bundle.type});
  await dec.tracks.ready;
  const result=await dec.decode({frameIndex:Math.max(0,Math.min(bundle.count-1,index)),completeFramesOnly:true});
  return {drawable:result.image,width:result.image.displayWidth||result.image.codedWidth,height:result.image.displayHeight||result.image.codedHeight,close:()=>{try{result.image.close()}catch(_){}try{dec.close()}catch(_){}}};
}

async function processedBundleFrame(source,bundle,index){
  const key=[source.id,bundle.url,index,Math.floor(bundle.at/HIST_TTL)].join('|');
  if(histFrames.has(key))return histFrames.get(key);
  const d=await decodeBundleFrame(bundle,index);
  try{
    let sw=d.width,sh=d.height;
    if(source.cropSquareLeft&&sw>sh*1.08)sw=sh;
    const scale=Math.min(1,900/sw),w=Math.round(sw*scale),h=Math.round(sh*scale);
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d',{alpha:true,willReadFrequently:true});x.imageSmoothingEnabled=false;
    x.drawImage(d.drawable,0,0,sw,sh,0,0,w,h);
    const img=x.getImageData(0,0,w,h),p=img.data;
    for(let i=0;i<p.length;i+=4){
      if(!radarPixelLooksLikeEcho(p[i],p[i+1],p[i+2],p[i+3]))p[i+3]=0;
      else p[i+3]=Math.min(225,Math.max(145,p[i+3]));
    }
    x.putImageData(img,0,0);
    const dataUrl=c.toDataURL('image/png');histFrames.set(key,dataUrl);
    while(histFrames.size>44)histFrames.delete(histFrames.keys().next().value);
    return dataUrl;
  }finally{d.close()}
}

function indexForTime(count,latest,target,step){
  const back=Math.max(0,Math.round((latest-target)/step));
  return count-1-back;
}

async function ltHistory(source,target,force=false){
  const b=await animationBundle(source.url,force);
  const latest=await ltLatestUnix(force);
  const i=indexForTime(b.count,latest,target,LT_STEP);
  if(i<0)return null;
  return {dataUrl:await processedBundleFrame(source,b,i),time:latest-(b.count-1-i)*LT_STEP,mode:b.count>1?'official history':'latest only'};
}

function lvCandidate(raw,base){
  try{
    const u=new URL(String(raw||'').replaceAll('&amp;','&'),base);
    const host=u.hostname.toLowerCase();
    const official=host==='meteo.lv'||host.endsWith('.meteo.lv')||host==='lvgmc.lv'||host.endsWith('.lvgmc.lv');
    if(!official)return '';
    if(!/(radar|rix_250)/i.test(u.href)||!/\.gif(?:$|[?&#])/i.test(u.href))return '';
    return u.href;
  }catch(_){return ''}
}

async function discoverLvAnimation(force=false){
  if(!force&&lvDiscoveryCache&&Date.now()-lvDiscoveryCache.at<LV_DISCOVERY_TTL)return lvDiscoveryCache.url;
  const src=DIRECT_RADAR_SOURCES.find(s=>s.id==='lv');
  const urls=new Set(src?[src.url.replace(/\.png(?=$|&|\?)/i,'.gif')]:[]);
  for(const page of ['https://www.meteo.lv/radars/?nid=482','https://www.meteo.lv/public/28641.html','https://videscentrs.lvgmc.lv/']){
    try{
      const r=await radarText(page),doc=new DOMParser().parseFromString(r.text,'text/html');
      for(const el of doc.querySelectorAll('[src],[href]')){
        const u=lvCandidate(el.getAttribute('src')||el.getAttribute('href'),r.url||page);if(u)urls.add(u);
      }
      for(const m of r.text.matchAll(/(?:https?:\/\/[^\s"'<>]+|\/?[^\s"'<>]+?\.gif(?:\?[^\s"'<>]*)?)/gi)){
        const u=lvCandidate(m[0],r.url||page);if(u)urls.add(u);
      }
    }catch(e){console.warn('LV radar animation discovery',e)}
  }
  let found='';
  for(const u of [...urls].slice(0,10)){
    try{const b=await animationBundle(u,force);if(b.count>1){found=u;break}}catch(_){}
  }
  lvDiscoveryCache={at:Date.now(),url:found};return found;
}

function lvLocal(){
  try{
    const a=JSON.parse(localStorage.getItem(LV_LOCAL_KEY)||'[]');
    return a.filter(x=>x&&x.dataUrl&&x.time*1000>Date.now()-3*60*60*1000).slice(-14);
  }catch(_){return []}
}
function saveLvLocal(time,dataUrl){
  const a=lvLocal().filter(x=>x.time!==time);a.push({time,dataUrl});a.sort((x,y)=>x.time-y.time);
  try{localStorage.setItem(LV_LOCAL_KEY,JSON.stringify(a.slice(-14)))}catch(_){}
}
function nearestLvLocal(target){
  const a=lvLocal();if(!a.length)return null;let b=a[0];for(const x of a)if(Math.abs(x.time-target)<Math.abs(b.time-target))b=x;
  return Math.abs(b.time-target)<=LV_STEP*.75?b:null;
}

async function lvHistory(source,target,latestTimeline,force=false){
  const anim=await discoverLvAnimation(force);
  if(anim){
    try{
      const b=await animationBundle(anim,force),latest=Math.floor(Date.now()/1000/LV_STEP)*LV_STEP,i=indexForTime(b.count,latest,target,LV_STEP);
      if(i>=0)return {dataUrl:await processedBundleFrame(source,b,i),time:latest-(b.count-1-i)*LV_STEP,mode:'official history'};
    }catch(e){console.warn('LV official history decode',e)}
  }
  if(Math.abs(target-latestTimeline)<=360){
    const dataUrl=await nationalRadarImage(source,force);saveLvLocal(latestTimeline,dataUrl);
    return {dataUrl,time:latestTimeline,mode:'latest + local capture'};
  }
  const local=nearestLvLocal(target);return local?{dataUrl:local.dataUrl,time:local.time,mode:'local captured history'}:null;
}

const balticRadarPending=new Map();
function prepareBalticRadarFrame(source,unix,latest,force=false){
  const key=[source.id,unix,latest,force].join('|');
  if(balticRadarPending.has(key))return balticRadarPending.get(key);
  const promise=(source.id==='lt'?ltHistory(source,unix,force):lvHistory(source,unix,latest,force))
    .finally(()=>{if(balticRadarPending.get(key)===promise)balticRadarPending.delete(key);});
  balticRadarPending.set(key,promise);return promise;
}
function visibleBalticRadarSources(){return DIRECT_RADAR_SOURCES.filter(source=>map.getBounds().intersects(L.latLngBounds(source.bounds)));}
drawDirectNationalRadars=async function(unix,{force=false}={}){
  if(!$('radarOn').checked){clearDirectNationalRadars();return}
  const generation=++directRadarGeneration,latest=frames[frames.length-1]?.time||unix;
  const results=await Promise.allSettled(visibleBalticRadarSources().map(async source=>({source,frame:await prepareBalticRadarFrame(source,unix,latest,force)})));
  if(generation!==directRadarGeneration||!$('radarOn').checked)return;
  const next=L.layerGroup(),labels=[];let missing=0;
  for(const r of results){
    if(r.status!=='fulfilled'||!r.value.frame){labels.push((r.status==='fulfilled'?r.value.source.id.toUpperCase():'National')+' history unavailable');missing++;continue}
    const {source,frame}=r.value;next.addLayer(L.imageOverlay(frame.dataUrl,source.bounds,{opacity:source.opacity,interactive:false}));
    labels.push(source.id.toUpperCase()+' '+(frame.mode==='official history'?'official history '+fmt(frame.time):frame.mode==='local captured history'?'local history '+fmt(frame.time):'official latest'));
  }
  const old=balticRadarLayer;balticRadarLayer=next;next.addTo(map);if(old&&old!==next&&map.hasLayer(old))map.removeLayer(old);
  next.eachLayer(l=>l.bringToFront?.());radarLayer?.bringToFront?.();
  $('radarStatus').textContent=['Radar: EE official KAIA · '+fmt(unix),...labels].join(' · ');
  $('radarStatus').className=missing?'status warn':'status ok';weatherFront();next.eachLayer(l=>l.bringToFront?.());radarLayer?.bringToFront?.();
};
