function replaceWeatherFrames(next,options={}){
  if(options.automatic && playing)return false;
  const selected=frames[Number($('timeline').value)]?.time;
  const latest=!frames.length || Number($('timeline').value)===Number($('timeline').max);
  radarTimelineFrames=next;frames=next;
  $('timeline').min=0;$('timeline').max=frames.length-1;$('timeline').value=frames.length-1;
  updateWeatherTimeline();
  if(options.preserveSelection && !latest && selected!=null){
    let index=0;
    frames.forEach((f,i)=>{if(f.time<=selected)index=i;});
    $('timeline').value=index;
  }
  return true;
}

// Keep every radar observation internally, but the shared 2-hour weather
// timeline always exposes 10-minute steps for every layer.
let radarTimelineFrames=[];
function updateWeatherTimeline(){
  if(!radarTimelineFrames.length)return;
  const selected=frames[Number($('timeline').value)]?.time;
  const next=radarTimelineFrames.filter(f=>Math.floor(f.time/60)%10===0);
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
  radarImageCache.delete(key);radarImageCache.set(key,val);
  while(radarImageCache.size>MAX_CACHE || [...radarImageCache.values()].reduce((bytes,image)=>bytes+image.length*2,0)>16*1024*1024){
    const first=radarImageCache.keys().next().value;
    radarImageCache.delete(first);
  }
}

const radarImagePending=new Map();
function h5ToRadarImage(frame,options={}){
  if(radarImageCache.has(frame.id)){const image=radarImageCache.get(frame.id);cacheSet(frame.id,image);return Promise.resolve(image);}
  if(radarImagePending.has(frame.id))return radarImagePending.get(frame.id);
  const promise=prepareKaiaRadarImage(frame,options).finally(()=>{if(radarImagePending.get(frame.id)===promise)radarImagePending.delete(frame.id);});
  radarImagePending.set(frame.id,promise);return promise;
}
async function prepareKaiaRadarImage(frame,{quiet=false}={}){
  if(radarImageCache.has(frame.id)) return radarImageCache.get(frame.id);

  if(!quiet){
    $('radarStatus').textContent='Radar: downloading official KAIA frame '+fmt(frame.time)+'…';
    $('radarStatus').className='status';
  }

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

  if(!$('radarOn').checked || !frame || !map.getBounds().intersects(L.latLngBounds(RADAR_BOUNDS))){
    if(radarLayer){
      map.removeLayer(radarLayer);
      radarLayer=null;
    }
    return;
  }

  const oldLayer=radarLayer;

  try{
    const prepared=typeof preparedRadarFrame==='function'?await preparedRadarFrame('ee',frame.time):null;
    const dataUrl=prepared?null:frame.url?await h5ToRadarImage(frame):null;
    if(!prepared&&!dataUrl)throw new Error('No official observation at the selected time');

    if(myGeneration!==radarRenderGeneration ||
       mySwapGeneration!==radarSwapGeneration ||
       !$('radarOn').checked){
      return;
    }

    const nextLayer=(prepared?preparedRadarCanvasLayer(prepared,0):L.imageOverlay(dataUrl,RADAR_BOUNDS,{
      opacity:0,
      interactive:false
    })).addTo(map);

    radarLayer=nextLayer;nextLayer.radarTime=prepared?.time??frame.time;nextLayer.radarPrepared=!!prepared;

    // Radar opacity is intentionally fixed now that the UI slider is gone.
    fadeInRadarLayer(nextLayer,0.86,160);

    setTimeout(()=>{
      if(oldLayer && oldLayer!==radarLayer && map.hasLayer(oldLayer)){
        map.removeLayer(oldLayer);
      }
    },170);

    $('radarStatus').textContent='Radar: EE official KAIA · '+fmt(prepared?.time??frame.time)+(prepared?' · prepared tiles':'');
    $('radarStatus').className='status ok';

    weatherFront();
  }catch(e){
    if(myGeneration!==radarRenderGeneration ||
       mySwapGeneration!==radarSwapGeneration){
      return;
    }

    console.error(e);
    $('radarStatus').textContent=
      'Radar: official KAIA frame could not be loaded — '+e.message+(oldLayer&&Number.isFinite(oldLayer.radarTime)?' · keeping '+fmt(oldLayer.radarTime):'');
    $('radarStatus').className='status bad';
  }
}

// -----------------------------------------------------------------------------
// Latvia + Lithuania direct national radar products
// -----------------------------------------------------------------------------

const DIRECT_RADAR_SOURCES=[
  {id:'lv',label:'LV official LVĢMC',bounds:[[54.5934155033868,19.8278947347231],[59.0900395033868,28.0663127347231]],opacity:.82},
  {id:'lt',label:'LT official Meteo.lt',bounds:[[49.876389,15.618611],[59.701667,34.313611]],opacity:.82}
];
const directRadarImageCache=new Map();
let directRadarGeneration=0;
function directRadarProxyUrl(url){return 'https://proxy.cors.dev/'+url;}
function clearDirectNationalRadars(){
  directRadarGeneration++;
  if(balticRadarLayer){if(map.hasLayer(balticRadarLayer))map.removeLayer(balticRadarLayer);balticRadarLayer=null;}
  if(typeof directRadarLayers!=='undefined')directRadarLayers.clear();
}

async function applyFrame(options={}){
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(!frame)return;

  $('timeLabel').textContent=fmt(frame.time)+(i===frames.length-1?' · latest':'');
  if($('windOn').checked) renderWind(frame.time);
  if(typeof renderOfficialWind==='function')renderOfficialWind();
  if(typeof activeAccumulationHours==='function' && activeAccumulationHours()) queueRainfallRender(55);

  if(temperatureEnabled() && temperatureSeries.length){
    queueTemperatureRender(frame.time,55);
  }

  const cloudTask=options.skipCloud?Promise.resolve():drawCloud(frame,{readyOnly:!!options.cloudReadyOnly}).catch(console.error);
  if(options.awaitCloud) await cloudTask;
  const radarSelection=typeof beginRadarSelectedFrame==='function'&&$('radarOn').checked?beginRadarSelectedFrame(frame.time):null;
  // Every regional source starts independently; KAIA latency cannot block it.
  const nordicTask=drawNordicRadars(frame.time).catch(console.error);
  const balticTask=drawDirectNationalRadars(frame.time).catch(console.error);
  const estoniaTask=drawRadar(frame);
  Promise.allSettled([nordicTask,balticTask,estoniaTask]).then(()=>{
    if(radarSelection!==null&&typeof finishRadarSelectedFrame==='function')finishRadarSelectedFrame(frame.time,radarSelection);
  });
  await estoniaTask;
  if(options.awaitRadar) await nordicTask;
  // Legacy Baltic animation discovery may be slow; it is generation guarded.
  if(!options.awaitRadar) await Promise.all([balticTask,nordicTask]);
}

async function loadKaiaRadarList(options={}){
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

  if(!replaceWeatherFrames(fs.slice(-25),options))return;

  $('radarStatus').textContent=`Radar: ${frames.length} official Estonian frames · 10-minute timeline.`;
  $('radarStatus').className='status ok';
  await applyFrame({skipCloud:!!options.skipCloud});
  if($('cloudOn').checked) scheduleCloudPrecache();
}

// The shared weather clock still works when Estonia's API is unavailable.
async function loadOfficialRadarList(options={}){
  try{return await loadKaiaRadarList(options);}
  catch(error){
    console.warn('KAIA timeline unavailable; keeping other national radars operational',error);
    const end=Math.floor(Date.now()/1000/600)*600-600;
    const next=Array.from({length:13},(_,i)=>({id:'clock-'+(end-(12-i)*600),time:end-(12-i)*600,url:null}));
    if(!replaceWeatherFrames(next,options))return;
    $('radarStatus').textContent='EE radar unavailable · other national radar feeds remain independent.';
    $('radarStatus').className='status warn';await applyFrame({skipCloud:!!options.skipCloud});
  }
}

