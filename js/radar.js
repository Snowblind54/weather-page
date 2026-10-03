// Keep every radar observation; the cloud view selects only 10-minute slots.
let radarTimelineFrames=[],cloudTimelineMode=false;
function updateWeatherTimeline(tenMinutes=cloudTimelineMode){
  cloudTimelineMode=tenMinutes;
  if(!radarTimelineFrames.length)return;
  const selected=frames[Number($('timeline').value)]?.time;
  const next=tenMinutes?radarTimelineFrames.filter(f=>Math.floor(f.time/60)%10===0):radarTimelineFrames;
  if(!next.length)return;
  frames=next;
  $('timeline').max=frames.length-1;
  let index=frames.length-1;
  if(selected!=null)index=frames.reduce((best,f,i)=>Math.abs(f.time-selected)<Math.abs(frames[best].time-selected)?i:best,0);
  $('timeline').value=index;
  if(typeof renderTimelineTicks==='function')renderTimelineTicks();
}

// Radar fading belongs to the radar module; cloud tiles fade independently.
function fadeInRadarLayer(layer,targetOpacity=.86,duration=160){
  const el=layer.getElement?.();
  if(!el){layer.setOpacity(targetOpacity);return;}
  el.style.transition=`opacity ${duration}ms linear`;
  layer.setOpacity(0);
  requestAnimationFrame(()=>requestAnimationFrame(()=>layer.setOpacity(targetOpacity)));
}

function colorRate(v){
  if(!Number.isFinite(v) || v<0.05) return [0,0,0,0];
  if(v<0.10) return [156,221,255,155];
  if(v<0.30) return [54,170,255,175];
  if(v<0.50) return [0,216,154,185];
  if(v<1.0)  return [232,247,0,195];
  if(v<2.0)  return [255,196,0,205];
  if(v<4.0)  return [255,123,0,215];
  if(v<8.0)  return [255,42,42,225];
  if(v<16.0) return [211,0,215,235];
  if(v<50.0) return [150,0,190,240];
  return [90,0,145,245];
}

let h5wasm=null;

async function ensureH5(){
  if(!h5wasm){
    const module=await import(APP_CONFIG.H5WASM_URL);
    h5wasm=module.default;
  }
  if(!h5Ready) h5Ready=h5wasm.ready;
  return h5Ready;
}

function cacheSet(key,val){
  radarImageCache.set(key,val);
  while(radarImageCache.size>MAX_CACHE){
    const first=radarImageCache.keys().next().value;
    radarImageCache.delete(first);
  }
}

async function h5ToRadarImage(frame){
  if(radarImageCache.has(frame.id)) return radarImageCache.get(frame.id);

  $('radarStatus').textContent='Radar: downloading official KAIA frame '+fmt(frame.time)+'…';
  $('radarStatus').className='status';

  const r=await fetch(frame.url,{cache:'no-store'});
  if(!r.ok) throw new Error('radar file HTTP '+r.status);
  const ab=await r.arrayBuffer();

  const Module=await ensureH5();
  const {FS}=Module;
  const filename='/radar_'+frame.id+'.h5';
  try{FS.unlink(filename)}catch(e){}
  FS.writeFile(filename,new Uint8Array(ab));

  const f=new h5wasm.File(filename,'r');
  try{
    const ds=f.get('dataset1/data1/data');
    const vals=ds.value;
    const shape=ds.shape;
    if(!shape || shape.length<2) throw new Error('unexpected radar array shape');

    const h=shape[0], w=shape[1];

    const what=f.get('dataset1/what').attrs || {};
    const gain=what.gain?.value ?? 1;
    const offset=what.offset?.value ?? 0;
    const nodata=what.nodata?.value ?? 65535;
    const undetect=what.undetect?.value ?? 0;

    const targetW=Math.min(1000,w);
    const targetH=Math.round(h*(targetW/w));
    const scaleX=w/targetW, scaleY=h/targetH;

    const canvas=document.createElement('canvas');
    canvas.width=targetW; canvas.height=targetH;
    const ctx=canvas.getContext('2d',{alpha:true});
    const img=ctx.createImageData(targetW,targetH);
    const p=img.data;

    for(let y=0;y<targetH;y++){
      const sy=Math.min(h-1,Math.floor(y*scaleY));
      for(let x=0;x<targetW;x++){
        const sx=Math.min(w-1,Math.floor(x*scaleX));
        const raw=vals[sy*w+sx];
        const j=(y*targetW+x)*4;

        if(raw===nodata || raw>30000 || raw===undetect){
          p[j+3]=0;
          continue;
        }
        const rate=offset+gain*raw;
        const c=colorRate(rate);
        p[j]=c[0];p[j+1]=c[1];p[j+2]=c[2];p[j+3]=c[3];
      }
    }

    ctx.putImageData(img,0,0);
    const dataUrl=canvas.toDataURL('image/png');
    cacheSet(frame.id,dataUrl);
    return dataUrl;
  } finally {
    f.close();
    try{FS.unlink(filename)}catch(e){}
  }
}

async function drawRadar(frame){
  const myGeneration=++radarRenderGeneration;
  const mySwapGeneration=++radarSwapGeneration;

  if(!$('radarOn').checked || !frame?.url){
    if(radarLayer){
      map.removeLayer(radarLayer);
      radarLayer=null;
    }
    return;
  }

  const oldLayer=radarLayer;

  try{
    const dataUrl=await h5ToRadarImage(frame);

    if(myGeneration!==radarRenderGeneration ||
       mySwapGeneration!==radarSwapGeneration ||
       !$('radarOn').checked){
      return;
    }

    const nextLayer=L.imageOverlay(dataUrl,RADAR_BOUNDS,{
      opacity:0,
      interactive:false
    }).addTo(map);

    radarLayer=nextLayer;

    // Radar opacity is intentionally fixed now that the UI slider is gone.
    fadeInRadarLayer(nextLayer,0.86,160);

    setTimeout(()=>{
      if(oldLayer && oldLayer!==radarLayer && map.hasLayer(oldLayer)){
        map.removeLayer(oldLayer);
      }
    },170);

    $('radarStatus').textContent='Radar: EE official KAIA · '+fmt(frame.time);
    $('radarStatus').className='status ok';

    weatherFront();
  }catch(e){
    if(myGeneration!==radarRenderGeneration ||
       mySwapGeneration!==radarSwapGeneration){
      return;
    }

    console.error(e);
    $('radarStatus').textContent=
      'Radar: official KAIA frame could not be loaded — '+e.message;
    $('radarStatus').className='status bad';
  }
}

// -----------------------------------------------------------------------------
// Latvia + Lithuania direct national radar products
// -----------------------------------------------------------------------------

const DIRECT_RADAR_SOURCES=[
  {
    id:'lv',
    label:'LV official LVĢMC',
    url:'https://www.meteo.lv/dynamic-content/?type=RADAR_250&file=RIX_250.sri.png',
    // Rīga Airport radar: roughly 250 km product radius.
    bounds:[[54.67,19.84],[59.18,28.10]],
    cropSquareLeft:true,
    opacity:0.82
  },
  {
    id:'lt',
    label:'LT official Meteo.lt',
    url:'https://beta.meteo.lt/meteo-data/radar/radarlarge+36.gif',
    // National Laukuva + Trakų Vokė composite product extent.
    bounds:[[53.45,20.25],[56.90,27.45]],
    cropSquareLeft:false,
    opacity:0.82
  }
];

const DIRECT_RADAR_CACHE_MS=4*60*1000;
const directRadarImageCache=new Map();
let directRadarGeneration=0;

function directRadarProxyUrl(url){
  return 'https://proxy.cors.dev/'+url;
}

async function fetchDirectRadarBlob(url){
  const attempt=async target=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(target,{
        cache:'no-store',
        signal:controller.signal,
        headers:{'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'}
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      const blob=await response.blob();
      if(!blob.size) throw new Error('empty image');
      return blob;
    }finally{
      clearTimeout(timer);
    }
  };

  try{
    return await attempt(url);
  }catch(directError){
    return await attempt(directRadarProxyUrl(url));
  }
}

async function decodeRadarDrawable(blob){
  const type=blob.type||'image/png';

  // Chromium can decode the final frame of an animated GIF. This matters for
  // Meteo.lt, whose public radar product may be delivered as an animation.
  if(type.includes('gif') && 'ImageDecoder' in window){
    try{
      const bytes=await blob.arrayBuffer();
      const decoder=new ImageDecoder({data:bytes,type});
      await decoder.tracks.ready;
      const track=decoder.tracks.selectedTrack;
      const frameIndex=Math.max(0,(track?.frameCount||1)-1);
      const result=await decoder.decode({frameIndex,completeFramesOnly:true});
      return {
        drawable:result.image,
        width:result.image.displayWidth||result.image.codedWidth,
        height:result.image.displayHeight||result.image.codedHeight,
        close:()=>{
          try{result.image.close()}catch(_){}
          try{decoder.close()}catch(_){}
        }
      };
    }catch(e){
      console.warn('Animated radar decode fallback',e);
    }
  }

  const bitmap=await createImageBitmap(blob);
  return {
    drawable:bitmap,
    width:bitmap.width,
    height:bitmap.height,
    close:()=>{try{bitmap.close()}catch(_){}}
  };
}

function radarPixelLooksLikeEcho(r,g,b,a){
  if(a<20) return false;

  const max=Math.max(r,g,b);
  const min=Math.min(r,g,b);
  if(max<72) return false;

  // National products contain a pale cartographic basemap. Radar echoes use a
  // much more saturated blue/cyan/green/yellow/orange/red/magenta palette.
  const saturation=max===0?0:(max-min)/max;
  if(saturation<0.50) return false;

  // Suppress very dark labels/outlines and near-white map furniture.
  if(max<90 && min<40) return false;
  if(r>225 && g>225 && b>225) return false;

  return true;
}

async function nationalRadarImage(source,force=false){
  const cached=directRadarImageCache.get(source.id);
  if(!force && cached && Date.now()-cached.savedAt<DIRECT_RADAR_CACHE_MS){
    return cached.dataUrl;
  }

  const blob=await fetchDirectRadarBlob(source.url);
  const decoded=await decodeRadarDrawable(blob);

  try{
    let sx=0,sy=0,sw=decoded.width,sh=decoded.height;

    // LVĢMC products have historically attached product metadata/legend to the
    // right of the square radar map. Keep only the geographic square when so.
    if(source.cropSquareLeft && decoded.width>decoded.height*1.08){
      sw=decoded.height;
    }

    const maxW=900;
    const scale=Math.min(1,maxW/sw);
    const outW=Math.max(1,Math.round(sw*scale));
    const outH=Math.max(1,Math.round(sh*scale));

    const canvas=document.createElement('canvas');
    canvas.width=outW;
    canvas.height=outH;
    const ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:true});
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(decoded.drawable,sx,sy,sw,sh,0,0,outW,outH);

    const image=ctx.getImageData(0,0,outW,outH);
    const p=image.data;

    for(let i=0;i<p.length;i+=4){
      const r=p[i],g=p[i+1],b=p[i+2],a=p[i+3];
      if(!radarPixelLooksLikeEcho(r,g,b,a)){
        p[i+3]=0;
      }else{
        p[i+3]=Math.min(225,Math.max(145,a));
      }
    }

    ctx.putImageData(image,0,0);
    const dataUrl=canvas.toDataURL('image/png');
    directRadarImageCache.set(source.id,{savedAt:Date.now(),dataUrl});
    return dataUrl;
  }finally{
    decoded.close();
  }
}

function clearDirectNationalRadars(){
  directRadarGeneration++;
  if(balticRadarLayer){
    if(map.hasLayer(balticRadarLayer)) map.removeLayer(balticRadarLayer);
    balticRadarLayer=null;
  }
}

async function drawDirectNationalRadars(unix,{force=false}={}){
  if(!$('radarOn').checked){
    clearDirectNationalRadars();
    return;
  }

  const latest=frames[frames.length-1];
  const isLatest=!!latest && unix===latest.time;

  if(!isLatest){
    clearDirectNationalRadars();
    $('radarStatus').textContent=
      'Radar: EE official KAIA · '+fmt(unix)+' · LV/LT latest national frames hidden while viewing history';
    $('radarStatus').className='status ok';
    return;
  }

  const generation=++directRadarGeneration;
  const results=await Promise.allSettled(
    DIRECT_RADAR_SOURCES.map(async source=>({
      source,
      dataUrl:await nationalRadarImage(source,force)
    }))
  );

  if(generation!==directRadarGeneration || !$('radarOn').checked) return;

  const next=L.layerGroup();
  const loaded=[];
  const failed=[];

  for(const result of results){
    if(result.status==='fulfilled'){
      const {source,dataUrl}=result.value;
      const layer=L.imageOverlay(dataUrl,source.bounds,{
        opacity:source.opacity,
        interactive:false
      });
      next.addLayer(layer);
      loaded.push(source.label);
    }else{
      failed.push(result.reason?.message||'unavailable');
    }
  }

  const old=balticRadarLayer;
  balticRadarLayer=next;
  next.addTo(map);
  next.eachLayer(layer=>layer.bringToFront?.());
  radarLayer?.bringToFront?.();

  if(old && old!==next && map.hasLayer(old)) map.removeLayer(old);

  const parts=['Radar: EE official KAIA · '+fmt(unix)];
  if(loaded.length) parts.push(...loaded.map(x=>x+' latest'));
  if(failed.length) parts.push('some national radar source unavailable');
  $('radarStatus').textContent=parts.join(' · ');
  $('radarStatus').className=failed.length?'status warn':'status ok';

  weatherFront();
  radarLayer?.bringToFront?.();
}

async function applyFrame(options={}){
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(!frame)return;

  $('timeLabel').textContent=fmt(frame.time)+(i===frames.length-1?' · latest':'');
  if($('windOn').checked) renderWind(frame.time);
  if(typeof activeAccumulationHours==='function' && activeAccumulationHours()) queueRainfallRender(55);

  if(temperatureEnabled() && temperatureSeries.length){
    queueTemperatureRender(frame.time,55);
  }

  const cloudTask=options.skipCloud?Promise.resolve():drawCloud(frame,{readyOnly:!!options.cloudReadyOnly}).catch(console.error);
  if(options.awaitCloud) await cloudTask;
  // Every regional source starts independently; KAIA latency cannot block it.
  const nordicTask=drawNordicRadars(frame.time).catch(console.error);
  const balticTask=drawDirectNationalRadars(frame.time).catch(console.error);
  await drawRadar(frame);
  if(options.awaitRadar) await nordicTask;
  // Legacy Baltic animation discovery may be slow; it is generation guarded.
  if(!options.awaitRadar) await Promise.all([balticTask,nordicTask]);
}

async function loadKaiaRadarList(){
  $('radarStatus').textContent='Radar: requesting official KAIA frame list…';
  $('radarStatus').className='status';

  const cutoff=new Date(Date.now()-2*60*60*1000).toISOString();
  const body={
    filter:{
      and:{children:[
        {isEqual:{field:"$contentType",value:"0102FB01"}},
        {isEqual:{field:"Phenomenon",value:"COMP"}},
        {greaterThan:{field:"Timestamp",value:cutoff}}
      ]}
    },
    pageSize:50,
    includeFileMetadata:true,
    fields:["Timestamp","Radar","Phenomenon"]
  };

  const r=await fetch('https://avaandmed.keskkonnaportaal.ee/api/lists/active/items/query',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),
    cache:'no-store'
  });

  if(!r.ok) throw new Error('KAIA API HTTP '+r.status);
  const j=await r.json();
  const docs=(j.documents||[]);

  const fs=docs.map(d=>{
    const fm=(d.fileMetadata||[])[0];
    if(!fm) return null;
    const t=Date.parse(d.metadata?.Timestamp||'');
    if(!Number.isFinite(t)) return null;
    return {
      id:d.id+'_'+fm.id,
      time:Math.floor(t/1000),
      url:`https://avaandmed.keskkonnaportaal.ee/api/lists/active/items/${d.id}/files/${fm.id}`,
      name:fm.name||''
    };
  }).filter(Boolean).sort((a,b)=>a.time-b.time);

  if(!fs.length) throw new Error('KAIA returned no composite frames');

  radarTimelineFrames=fs.slice(-25);
  frames=radarTimelineFrames;
  $('timeline').min=0;
  $('timeline').max=frames.length-1;
  $('timeline').value=frames.length-1;
  updateWeatherTimeline();

  $('radarStatus').textContent=`Radar: ${frames.length} official 5-minute Estonian frames found.`;
  $('radarStatus').className='status ok';
  await applyFrame();
  if($('cloudOn').checked) scheduleCloudPrecache();
}

// The shared weather clock still works when Estonia's API is unavailable.
async function loadOfficialRadarList(){
  try{return await loadKaiaRadarList();}
  catch(error){
    console.warn('KAIA timeline unavailable; keeping other national radars operational',error);
    const end=Math.floor(Date.now()/1000/300)*300-300;
    radarTimelineFrames=Array.from({length:25},(_,i)=>({id:'clock-'+(end-(24-i)*300),time:end-(24-i)*300,url:null}));
    frames=radarTimelineFrames;$('timeline').min=0;$('timeline').max=24;$('timeline').value=24;updateWeatherTimeline();
    $('radarStatus').textContent='EE radar unavailable · other national radar feeds remain independent.';
    $('radarStatus').className='status warn';await applyFrame();
  }
}
