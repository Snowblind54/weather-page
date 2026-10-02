function cloudGuideSld(){
  // The Cloud Mask is never shown. It is only a soft guide for photographic extraction.
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
 xmlns="http://www.opengis.net/sld"
 xmlns:ogc="http://www.opengis.net/ogc"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <NamedLayer>
    <Name>msg_fes:clm</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="values">
              <ColorMapEntry color="#000000" quantity="0" opacity="0.0"/>
              <ColorMapEntry color="#000000" quantity="1" opacity="0.0"/>
              <ColorMapEntry color="#FFFFFF" quantity="2" opacity="1.0"/>
              <ColorMapEntry color="#000000" quantity="3" opacity="0.0"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;
}

const CLOUD_W=1200;
const CLOUD_H=920;
function cloud10Slot(unix){
  return Math.floor(unix/600)*600;
}

function geocolourUrl(unix){
  const base='https://view.eumetsat.int/geoserver/wms';
  const q=new URLSearchParams({
    service:'WMS',
    version:'1.1.1',
    request:'GetMap',
    layers:'mtg_fd:rgb_geocolour',
    styles:'',
    format:'image/png',
    srs:'EPSG:4326',
    bbox:'20.0,53.35,29.75,60.85',
    width:String(CLOUD_W),
    height:String(CLOUD_H),
    time:iso10(unix)
  });

  // Every request, including the newest frame, now carries an explicit TIME.
  // This prevents GeoServer from falling back to an untimed/default rendering.
  return base+'?'+q.toString();
}

function infrared105Url(unix){
  const base='https://view.eumetsat.int/geoserver/wms';
  const q=new URLSearchParams({
    service:'WMS',
    version:'1.1.1',
    request:'GetMap',
    layers:'mtg_fd:ir105_hrfi',
    styles:'',
    format:'image/png',
    srs:'EPSG:4326',
    bbox:'20.0,53.35,29.75,60.85',
    width:String(CLOUD_W),
    height:String(CLOUD_H),
    time:iso10(unix)
  });

  return base+'?'+q.toString();
}

// Approximate astronomical solar elevation for the centre of the Baltic cloud area.
// This removes the old brightness-based day/night guess completely.
function solarElevationDegrees(unix,lat=57.1,lon=24.9){
  const rad=Math.PI/180;
  const deg=180/Math.PI;
  const jd=unix/86400 + 2440587.5;
  const n=jd-2451545.0;

  let L=(280.460 + 0.9856474*n)%360;
  if(L<0) L+=360;
  let g=(357.528 + 0.9856003*n)%360;
  if(g<0) g+=360;

  const lambda=(L + 1.915*Math.sin(g*rad) + 0.020*Math.sin(2*g*rad))*rad;
  const epsilon=(23.439 - 0.0000004*n)*rad;

  const ra=Math.atan2(Math.cos(epsilon)*Math.sin(lambda),Math.cos(lambda))*deg;
  const dec=Math.asin(Math.sin(epsilon)*Math.sin(lambda));

  let gmst=(18.697374558 + 24.06570982441908*n)%24;
  if(gmst<0) gmst+=24;

  let H=gmst*15 + lon - ra;
  H=((H+180)%360+360)%360-180;
  H*=rad;

  const phi=lat*rad;
  const elev=Math.asin(
    Math.sin(phi)*Math.sin(dec) +
    Math.cos(phi)*Math.cos(dec)*Math.cos(H)
  );

  return elev*deg;
}

function cloudSolarMix(unix){
  const elevation=solarElevationDegrees(unix);

  // Important: GeoColour is completely excluded once the Sun is at/below
  // the horizon, so its Black Marble city lights cannot leak into night clouds.
  //
  //  <= 0°  : 100% IR10.5
  //   0–5°  : gradual twilight transition
  //  >= 5°  : 100% GeoColour
  const dayMix=smoothstep(0.0,5.0,elevation);

  let mode='twilight';
  if(dayMix<=0.001) mode='night';
  else if(dayMix>=0.999) mode='day';

  return {elevation,dayMix,mode};
}


function cloudGuideUrl(unix){
  const base='https://view.eumetsat.int/geoserver/wms';
  const q=new URLSearchParams({
    service:'WMS',
    version:'1.1.1',
    request:'GetMap',
    layers:'msg_fes:clm',
    styles:'',
    format:'image/png',
    transparent:'true',
    srs:'EPSG:4326',
    bbox:'20.0,53.35,29.75,60.85',
    width:String(CLOUD_W),
    height:String(CLOUD_H),
    SLD_BODY:cloudGuideSld(),
    time:iso15(unix)
  });

  return base+'?'+q.toString();
}

function corsRelayUrl(url){
  return 'https://proxy.cors.dev/'+url;
}

async function fetchCloudBlob(url,timeoutMs=14000){
  const attempts=[url,corsRelayUrl(url)];
  let lastError=null;

  for(const candidate of attempts){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeoutMs);

    try{
      const r=await fetch(candidate,{cache:'no-store',signal:ctrl.signal});
      if(!r.ok) throw new Error('HTTP '+r.status);

      const blob=await r.blob();
      if(!blob.type.startsWith('image/')){
        throw new Error('satellite service returned '+(blob.type||'non-image data'));
      }
      return blob;
    }catch(e){
      lastError=e;
    }finally{
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('satellite image download failed');
}

async function blobToDrawable(blob){
  if('createImageBitmap' in window) return await createImageBitmap(blob);

  const url=URL.createObjectURL(blob);
  try{
    const img=new Image();
    img.decoding='async';
    await new Promise((resolve,reject)=>{
      img.onload=resolve;
      img.onerror=()=>reject(new Error('could not decode satellite image'));
      img.src=url;
    });
    return img;
  }finally{
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}

function smoothstep(a,b,x){
  if(a===b) return x<a?0:1;
  let t=(x-a)/(b-a);
  t=Math.max(0,Math.min(1,t));
  return t*t*(3-2*t);
}

function blurAlpha(src,w,h,radius=5){
  if(radius<=0) return src;
  const tmp=new Float32Array(src.length);
  const out=new Float32Array(src.length);
  const size=radius*2+1;

  for(let y=0;y<h;y++){
    let sum=0;
    const row=y*w;
    for(let k=-radius;k<=radius;k++) sum+=src[row+Math.max(0,Math.min(w-1,k))];
    for(let x=0;x<w;x++){
      tmp[row+x]=sum/size;
      const oldX=Math.max(0,x-radius);
      const newX=Math.min(w-1,x+radius+1);
      sum+=src[row+newX]-src[row+oldX];
    }
  }

  for(let x=0;x<w;x++){
    let sum=0;
    for(let k=-radius;k<=radius;k++) sum+=tmp[Math.max(0,Math.min(h-1,k))*w+x];
    for(let y=0;y<h;y++){
      out[y*w+x]=sum/size;
      const oldY=Math.max(0,y-radius);
      const newY=Math.min(h-1,y+radius+1);
      sum+=tmp[newY*w+x]-tmp[oldY*w+x];
    }
  }
  return out;
}

function visualCloudScore(r,g,b){
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  const chroma=max-min;
  const lum=0.2126*r+0.7152*g+0.0722*b;
  const bright=smoothstep(62,205,lum);
  const neutral=1-smoothstep(22,105,chroma);
  return Math.max(0,Math.min(1,bright*(0.58+0.42*neutral)));
}

async function processHybridClouds(slot,geoBlob,irBlob,guideBlob){
  const solar=cloudSolarMix(slot);

  let geoSrc=null;
  let irSrc=null;

  if(geoBlob){
    const geo=await blobToDrawable(geoBlob);
    const c=document.createElement('canvas');
    c.width=CLOUD_W; c.height=CLOUD_H;
    const x=c.getContext('2d',{alpha:true,willReadFrequently:true});
    x.imageSmoothingEnabled=true;
    x.imageSmoothingQuality='high';
    x.drawImage(geo,0,0,CLOUD_W,CLOUD_H);
    geoSrc=x.getImageData(0,0,CLOUD_W,CLOUD_H).data;
  }

  if(irBlob){
    const ir=await blobToDrawable(irBlob);
    const c=document.createElement('canvas');
    c.width=CLOUD_W; c.height=CLOUD_H;
    const x=c.getContext('2d',{alpha:true,willReadFrequently:true});
    x.imageSmoothingEnabled=true;
    x.imageSmoothingQuality='high';
    x.drawImage(ir,0,0,CLOUD_W,CLOUD_H);
    irSrc=x.getImageData(0,0,CLOUD_W,CLOUD_H).data;
  }

  let guide=null;
  let usedGuide=false;

  if(guideBlob){
    try{
      const guideImg=await blobToDrawable(guideBlob);
      const guideCanvas=document.createElement('canvas');
      guideCanvas.width=CLOUD_W;
      guideCanvas.height=CLOUD_H;

      const gctx=guideCanvas.getContext('2d',{alpha:true,willReadFrequently:true});
      gctx.imageSmoothingEnabled=true;
      gctx.imageSmoothingQuality='high';
      gctx.drawImage(guideImg,0,0,CLOUD_W,CLOUD_H);

      const gd=gctx.getImageData(0,0,CLOUD_W,CLOUD_H).data;
      const raw=new Float32Array(CLOUD_W*CLOUD_H);
      for(let p=0,j=3;p<raw.length;p++,j+=4) raw[p]=gd[j]/255;

      // Soft guide only. It controls transparency, never supplies visible pixels.
      guide=blurAlpha(raw,CLOUD_W,CLOUD_H,6);
      usedGuide=true;
    }catch(e){
      console.warn('Cloud guide decode failed.',e);
    }
  }

  if(solar.dayMix>=0.999 && !geoSrc){
    throw new Error('daytime GeoColour frame unavailable');
  }
  if(solar.dayMix<=0.001 && !irSrc){
    throw new Error('night-time IR10.5 frame unavailable');
  }
  if(!geoSrc && !irSrc){
    throw new Error('no satellite image available');
  }

  const canvas=document.createElement('canvas');
  canvas.width=CLOUD_W;
  canvas.height=CLOUD_H;
  const ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:true});
  const out=ctx.createImageData(CLOUD_W,CLOUD_H);
  const dst=out.data;

  const dm=geoSrc ? solar.dayMix : 0;
  const nm=irSrc ? 1-solar.dayMix : 0;
  const mixTotal=Math.max(0.0001,dm+nm);
  const dayWeight=dm/mixTotal;
  const nightWeight=nm/mixTotal;

  for(let p=0,i=0;p<CLOUD_W*CLOUD_H;p++,i+=4){
    let dayAlpha=0, dayTone=190;
    let nightAlpha=0, nightTone=190;

    if(geoSrc){
      const r=geoSrc[i], g=geoSrc[i+1], b=geoSrc[i+2];
      const lum=0.2126*r+0.7152*g+0.0722*b;
      const visual=visualCloudScore(r,g,b);

      if(guide){
        const gate=smoothstep(0.035,0.80,guide[p]);
        const photoDetail=0.32+0.68*smoothstep(38,220,lum);
        const edgeDetail=visual*smoothstep(0.015,0.30,guide[p])*0.22;
        dayAlpha=Math.max(gate*photoDetail,edgeDetail);
      }else{
        dayAlpha=Math.pow(visual,1.45)*0.86;
      }

      const d=smoothstep(28,235,lum);
      dayTone=Math.round(Math.max(145,Math.min(255,150+105*d)));
    }

    if(irSrc){
      const r=irSrc[i], g=irSrc[i+1], b=irSrc[i+2];
      const lum=0.2126*r+0.7152*g+0.0722*b;

      // IR10.5 has no city-light basemap. The cloud mask defines where clouds
      // are allowed; IR luminance supplies real satellite cloud structure.
      if(guide){
        const gate=smoothstep(0.055,0.74,guide[p]);
        const texture=0.58+0.42*smoothstep(16,225,lum);
        nightAlpha=gate*texture;
      }else{
        // Safe fallback: still uses IR only, never GeoColour at night.
        nightAlpha=Math.pow(smoothstep(52,205,lum),1.35)*0.78;
      }

      // Preserve colder/high-cloud brightness while keeping lower cloud visible.
      const d=smoothstep(18,235,lum);
      nightTone=Math.round(Math.max(138,Math.min(255,142+113*d)));
    }

    const aDay=Math.max(0,Math.min(0.95,dayAlpha))*dayWeight;
    const aNight=Math.max(0,Math.min(0.95,nightAlpha))*nightWeight;
    const alpha=aDay+aNight;

    if(alpha < 0.014){
      dst[i+3]=0;
      continue;
    }

    // Premultiplied visual blend between daytime photographic texture
    // and night-time IR texture.
    const tone=(dayTone*aDay + nightTone*aNight)/Math.max(alpha,0.0001);

    dst[i]=Math.min(255,Math.round(tone+2));
    dst[i+1]=Math.min(255,Math.round(tone+4));
    dst[i+2]=Math.min(255,Math.round(tone+7));
    dst[i+3]=Math.round(255*Math.min(0.94,alpha));
  }

  ctx.putImageData(out,0,0);

  let dataUrl='';
  try{
    dataUrl=canvas.toDataURL('image/png');
  }catch(e){
    throw new Error('could not encode processed cloud image: '+e.message);
  }

  if(!dataUrl || !dataUrl.startsWith('data:image/png')){
    throw new Error('processed cloud image encoding failed');
  }

  return {
    url:dataUrl,
    usedGuide,
    mode:solar.mode,
    solarElevation:solar.elevation,
    dayMix:solar.dayMix
  };
}

function setCloudCache(key,item){
  if(cloudImageCache.has(key)) cloudImageCache.delete(key);
  cloudImageCache.set(key,item);

  while(cloudImageCache.size>CLOUD_CACHE_LIMIT){
    const oldestKey=cloudImageCache.keys().next().value;
    cloudImageCache.delete(oldestKey);
  }
}

async function createProcessedCloudSlot(requestedSlot,allowFallback=false){
  requestedSlot=cloud10Slot(requestedSlot);
  const key='slot-'+requestedSlot+(allowFallback?'-fallback':'');

  if(cloudImageCache.has(key)){
    const hit=cloudImageCache.get(key);
    cloudImageCache.delete(key);
    cloudImageCache.set(key,hit);
    return hit;
  }

  if(cloudFramePromises.has(key)) return await cloudFramePromises.get(key);

  const promise=(async()=>{
    const candidates=allowFallback
      ? [requestedSlot,requestedSlot-600,requestedSlot-1200,requestedSlot-1800]
      : [requestedSlot];
    let lastError=null;

    for(const slot of candidates){
      try{
        const solar=cloudSolarMix(slot);

        let geoBlob=null;
        let irBlob=null;

        // Do not even request GeoColour at night. This guarantees that the
        // Black Marble city-light background cannot enter the processing path.
        if(solar.dayMix>0.001){
          geoBlob=await fetchCloudBlob(geocolourUrl(slot));
        }

        // IR10.5 is used through the entire night and also during twilight
        // so the transition remains smooth.
        if(solar.dayMix<0.999){
          irBlob=await fetchCloudBlob(infrared105Url(slot));
        }

        let guideBlob=null;
        try{
          guideBlob=await fetchCloudBlob(cloudGuideUrl(slot),10000);
        }catch(e){
          console.warn('Cloud guide unavailable for '+iso15(slot),e);
        }

        const processed=await processHybridClouds(slot,geoBlob,irBlob,guideBlob);
        const item={...processed,time:slot,requestedTime:requestedSlot};
        setCloudCache(key,item);
        return item;
      }catch(e){
        lastError=e;
        console.warn('Satellite slot unavailable '+iso10(slot),e);
      }
    }
    throw lastError || new Error('no satellite frame available');
  })();

  cloudFramePromises.set(key,promise);
  try{
    return await promise;
  }finally{
    cloudFramePromises.delete(key);
  }
}

function fadeInImageLayer(layer,targetOpacity=1,duration=180){
  const el=layer.getElement?.();
  if(!el){
    layer.setOpacity(targetOpacity);
    return;
  }

  el.classList.add('weather-fade');
  layer.setOpacity(0);

  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      layer.setOpacity(targetOpacity);
    });
  });
}

function removeCloudOverlay(layer){
  if(layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function createCloudOverlay(item){
  const layer=L.imageOverlay(item.url,CLOUD_BOUNDS,{
    opacity:0,
    interactive:false,
    crossOrigin:false,
    errorOverlayUrl:''
  });
  layer.addTo(map);
  const el=layer.getElement?.();
  if(el) el.classList.add('weather-fade');
  return layer;
}

function waitLayerImage(layer,timeoutMs=3500){
  const el=layer.getElement?.();
  if(el?.complete && el.naturalWidth>0) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(ok)=>{
      if(done) return;
      done=true;
      clearTimeout(timer);
      layer.off('load',onLoad);
      layer.off('error',onError);
      ok?resolve():reject(new Error('browser rejected processed cloud PNG'));
    };
    const onLoad=()=>finish(true);
    const onError=()=>finish(false);
    const timer=setTimeout(()=>finish(false),timeoutMs);
    layer.once('load',onLoad);
    layer.once('error',onError);
  });
}

async function ensureCloudRole(role,item,myGen){
  const isLow=role==='low';
  const currentLayer=isLow?cloudLayerLow:cloudLayerHigh;
  const currentSlot=isLow?cloudLayerLowSlot:cloudLayerHighSlot;

  if(currentLayer && currentSlot===item.time && map.hasLayer(currentLayer)) return currentLayer;

  const next=createCloudOverlay(item);
  try{
    await waitLayerImage(next);
  }catch(e){
    removeCloudOverlay(next);
    throw e;
  }

  if(myGen!==cloudRenderGeneration || !$('cloudOn').checked){
    removeCloudOverlay(next);
    return null;
  }

  if(currentLayer && currentLayer!==next) removeCloudOverlay(currentLayer);

  if(isLow){
    cloudLayerLow=next;
    cloudLayerLowSlot=item.time;
  }else{
    cloudLayerHigh=next;
    cloudLayerHighSlot=item.time;
  }
  return next;
}

function updateCloudBlendOpacity(){
  const base=Number($('cloudOpacity').value)/100;
  const f=Math.max(0,Math.min(1,cloudBlendFraction));

  if(cloudLayerLow && map.hasLayer(cloudLayerLow)){
    cloudLayerLow.setOpacity(base*(cloudLayerHigh?1-f:1));
  }
  if(cloudLayerHigh && map.hasLayer(cloudLayerHigh)){
    cloudLayerHigh.setOpacity(base*f);
  }

  cloudLayer=cloudLayerHigh && f>=0.5 ? cloudLayerHigh : cloudLayerLow;
}

function clearCloudLayers(){
  removeCloudOverlay(cloudLayerLow);
  removeCloudOverlay(cloudLayerHigh);
  cloudLayerLow=null;
  cloudLayerHigh=null;
  cloudLayerLowSlot=null;
  cloudLayerHighSlot=null;
  cloudLayer=null;
  cloudBlendFraction=0;
}

function cloudBlendTargets(unix,index){
  const low=cloud10Slot(unix);
  const newest=frames.length ? cloud10Slot(frames[frames.length-1].time) : low;
  let high=Math.min(low+600,newest);
  let fraction=high===low ? 0 : (unix-low)/(high-low);
  fraction=Math.max(0,Math.min(1,fraction));

  // The last timeline position should show the newest explicit satellite slot,
  // not an untimed/default WMS image.
  if(index===frames.length-1){
    high=low;
    fraction=0;
  }
  return {low,high,fraction};
}

async function drawCloud(frame,index){
  if(!$('cloudOn').checked || !frame){
    cloudRenderGeneration++;
    cloudPrecacheGeneration++;
    if(cloudPrecacheTimer) clearTimeout(cloudPrecacheTimer);
    clearCloudLayers();
    $('cloudStatus').textContent='Cloud layer is off.';
    $('cloudStatus').className='status';
    return;
  }

  const myGen=++cloudRenderGeneration;
  const {low,high,fraction}=cloudBlendTargets(frame.time,index);
  const latest=index===frames.length-1;

  try{
    $('cloudStatus').textContent='Satellite clouds: loading '+fmt(low)+'…';
    $('cloudStatus').className='status';

    const lowPromise=createProcessedCloudSlot(low,latest);
    const highPromise=high!==low ? createProcessedCloudSlot(high,false) : null;

    const lowItem=await lowPromise;
    if(myGen!==cloudRenderGeneration || !$('cloudOn').checked) return;

    let highItem=null;
    if(highPromise){
      try{ highItem=await highPromise; }
      catch(e){ console.warn('Next cloud frame unavailable; using current frame only.',e); }
    }

    if(myGen!==cloudRenderGeneration || !$('cloudOn').checked) return;

    const lowLayer=await ensureCloudRole('low',lowItem,myGen);
    if(!lowLayer || myGen!==cloudRenderGeneration) return;

    if(highItem && highItem.time!==lowItem.time){
      const highLayer=await ensureCloudRole('high',highItem,myGen);
      if(!highLayer || myGen!==cloudRenderGeneration) return;
      cloudBlendFraction=fraction;
    }else{
      removeCloudOverlay(cloudLayerHigh);
      cloudLayerHigh=null;
      cloudLayerHighSlot=null;
      cloudBlendFraction=0;
    }

    updateCloudBlendOpacity();
    weatherFront();

    const actual=fmt(lowItem.time);
    const suffix=latest && lowItem.time!==low
      ? ' · newest available ('+actual+')'
      : (latest?' · latest explicit satellite frame':'');
    const blend=highItem && highItem.time!==lowItem.time
      ? ' · interpolated between satellite frames'
      : '';
    const elev=Number.isFinite(lowItem.solarElevation)
      ? lowItem.solarElevation.toFixed(1)+'° sun'
      : '';
    const modeText=lowItem.mode==='night'
      ? ' · night IR10.5'
      : (lowItem.mode==='day' ? ' · daylight GeoColour' : ' · twilight GeoColour ↔ IR10.5');
    const guideText=lowItem.usedGuide
      ? ' · cloud-mask assisted'
      : ' · no cloud-mask guide';

    $('cloudStatus').textContent='Satellite clouds: '+actual+suffix+blend+modeText+(elev?' · '+elev:'')+guideText;
    $('cloudStatus').className='status ok';
  }catch(e){
    if(myGen!==cloudRenderGeneration) return;
    console.error(e);
    $('cloudStatus').textContent='Satellite clouds unavailable: '+e.message;
    $('cloudStatus').className='status bad';
  }
}

function scheduleCloudPrecache(){
  cloudPrecacheGeneration++;
  const myGen=cloudPrecacheGeneration;
  if(cloudPrecacheTimer) clearTimeout(cloudPrecacheTimer);
  if(!$('cloudOn').checked || !frames.length) return;

  cloudPrecacheTimer=setTimeout(async()=>{
    const currentIndex=Number($('timeline').value);
    const currentTime=frames[currentIndex]?.time ?? frames[frames.length-1].time;
    const slots=[...new Set(frames.map(f=>cloud10Slot(f.time)))];
    slots.sort((a,b)=>Math.abs(a-currentTime)-Math.abs(b-currentTime));

    for(const slot of slots){
      if(myGen!==cloudPrecacheGeneration || !$('cloudOn').checked) return;
      const key='slot-'+slot;
      if(cloudImageCache.has(key)) continue;
      try{
        await createProcessedCloudSlot(slot,false);
      }catch(e){
        // A missing acquisition should not stop the rest of the 2-hour cache.
        console.warn('Cloud precache skipped '+iso10(slot),e);
      }
      await new Promise(r=>setTimeout(r,45));
    }
  },250);
}
