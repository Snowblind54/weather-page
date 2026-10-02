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

  if(!$('radarOn').checked || !frame){
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

    fadeInImageLayer(
      nextLayer,
      Number($('radarOpacity').value)/100,
      160
    );

    setTimeout(()=>{
      if(oldLayer && oldLayer!==radarLayer && map.hasLayer(oldLayer)){
        map.removeLayer(oldLayer);
      }
    },170);

    $('radarStatus').textContent='Radar: official Estonian composite · '+fmt(frame.time);
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

async function applyFrame(options={}){
  const i=Number($('timeline').value);
  const frame=frames[i];
  if(!frame)return;

  $('timeLabel').textContent=fmt(frame.time)+(i===frames.length-1?' · latest':'');

  if($('tempOn').checked && temperatureSeries.length){
    queueTemperatureRender(frame.time,55);
  }

  if(!options.skipCloud) drawCloud(frame,i).catch(console.error);
  await drawRadar(frame);
}

async function loadOfficialRadarList(){
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

  frames=fs.slice(-25);
  $('timeline').min=0;
  $('timeline').max=frames.length-1;
  $('timeline').value=frames.length-1;

  $('radarStatus').textContent=`Radar: ${frames.length} official 5-minute frames found.`;
  $('radarStatus').className='status ok';
  await applyFrame();
  if($('cloudOn').checked) scheduleCloudPrecache();
}
