// Space Weather — NOAA SWPC aurora forecast + viewing conditions.
// The browser reads one compact GitHub-generated snapshot; it never queries
// NOAA directly. Viewing conditions reuse the existing satellite-cloud engine.
(function(){
  'use strict';

  const SNAPSHOT_URL='data/space-weather.json';
  const REFRESH_MS=5*60*1000;
  const TILE_STEP=4;
  let spaceWeatherData=null;
  let spaceWeatherLoadedAt=0;
  let spaceWeatherLoadPromise=null;
  let auroraLayer=null;
  let viewingLayer=null;
  let viewingCloudTime=null;

  if(typeof map==='undefined' || typeof L==='undefined')return;

  if(!map.getPane('spaceWeatherPane')){
    map.createPane('spaceWeatherPane');
    map.getPane('spaceWeatherPane').style.zIndex='470';
    map.getPane('spaceWeatherPane').style.pointerEvents='none';
  }

  function parseProviderTime(value){
    if(!value)return null;
    let text=String(value).trim();
    if(!/[zZ]|[+-]\d\d:?\d\d$/.test(text))text=text.replace(' ','T')+'Z';
    const ms=Date.parse(text);
    return Number.isFinite(ms)?ms/1000:null;
  }

  function shortTime(value){
    const unix=parseProviderTime(value);
    if(!unix)return '—';
    return new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'}).format(new Date(unix*1000));
  }

  function validSnapshot(data){
    const a=data?.aurora;
    return data?.version===1 && Number.isFinite(data.generatedAt) &&
      Number.isFinite(a?.latMin) && Number.isFinite(a?.latMax) &&
      Number.isInteger(a?.width) && Number.isInteger(a?.height) &&
      Array.isArray(a?.values) && a.values.length===a.width*a.height;
  }

  async function fetchSpaceWeather(force=false){
    if(!force && spaceWeatherData && Date.now()-spaceWeatherLoadedAt<REFRESH_MS)return spaceWeatherData;
    if(spaceWeatherLoadPromise)return spaceWeatherLoadPromise;
    spaceWeatherLoadPromise=(async()=>{
      const bucket=Math.floor(Date.now()/REFRESH_MS);
      const response=await fetch(`${SNAPSHOT_URL}?v=${bucket}`,{cache:'no-store'});
      if(!response.ok)throw new Error(`Space-weather snapshot HTTP ${response.status}`);
      const data=await response.json();
      if(!validSnapshot(data))throw new Error('Space-weather snapshot is invalid');
      spaceWeatherData=data;
      spaceWeatherLoadedAt=Date.now();
      updateDashboard();
      auroraLayer?.redraw();
      viewingLayer?.redraw();
      return data;
    })().finally(()=>{spaceWeatherLoadPromise=null;});
    return spaceWeatherLoadPromise;
  }

  function gridValue(lat,lon){
    const a=spaceWeatherData?.aurora;
    if(!a || lat<a.latMin || lat>a.latMax)return 0;
    const x=((lon%360)+360)%360;
    const y=lat-a.latMin;
    const x0=Math.floor(x)%a.width,x1=(x0+1)%a.width;
    const y0=Math.max(0,Math.min(a.height-1,Math.floor(y)));
    const y1=Math.max(0,Math.min(a.height-1,y0+1));
    const fx=x-Math.floor(x),fy=Math.max(0,Math.min(1,y-Math.floor(y)));
    const at=(xx,yy)=>Number(a.values[yy*a.width+xx])||0;
    const top=at(x0,y0)*(1-fx)+at(x1,y0)*fx;
    const bottom=at(x0,y1)*(1-fx)+at(x1,y1)*fx;
    return top*(1-fy)+bottom*fy;
  }

  function solarElevation(unix,lat,lon){
    // NOAA-style compact solar-position approximation; accurate enough for
    // separating daylight, twilight and astronomical darkness on a map layer.
    const date=new Date(unix*1000);
    const start=Date.UTC(date.getUTCFullYear(),0,1);
    const day=(date.getTime()-start)/86400000+1;
    const hour=date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600;
    const gamma=2*Math.PI/365*(day-1+(hour-12)/24);
    const eqtime=229.18*(0.000075+0.001868*Math.cos(gamma)-0.032077*Math.sin(gamma)-0.014615*Math.cos(2*gamma)-0.040849*Math.sin(2*gamma));
    const decl=0.006918-0.399912*Math.cos(gamma)+0.070257*Math.sin(gamma)-0.006758*Math.cos(2*gamma)+0.000907*Math.sin(2*gamma)-0.002697*Math.cos(3*gamma)+0.00148*Math.sin(3*gamma);
    let minutes=hour*60+eqtime+4*lon;
    minutes=((minutes%1440)+1440)%1440;
    const ha=(minutes/4<0?minutes/4+180:minutes/4-180)*Math.PI/180;
    const phi=lat*Math.PI/180;
    const cosZenith=Math.sin(phi)*Math.sin(decl)+Math.cos(phi)*Math.cos(decl)*Math.cos(ha);
    return 90-Math.acos(Math.max(-1,Math.min(1,cosZenith)))*180/Math.PI;
  }

  function darknessFactor(unix,lat,lon){
    const elevation=solarElevation(unix,lat,lon);
    if(elevation>=-6)return 0;
    if(elevation>=-12)return (-6-elevation)/6*0.45;
    if(elevation>=-18)return 0.45+(-12-elevation)/6*0.55;
    return 1;
  }

  function auroraColor(value){
    const stops=[
      [0,[30,220,120]],
      [15,[70,255,105]],
      [35,[210,255,70]],
      [60,[255,196,55]],
      [80,[255,90,80]],
      [100,[255,210,240]]
    ];
    const v=Math.max(0,Math.min(100,value));
    for(let i=1;i<stops.length;i++){
      if(v<=stops[i][0]){
        const [a,ca]=stops[i-1],[b,cb]=stops[i];
        const f=(v-a)/(b-a||1);
        return ca.map((c,n)=>Math.round(c+(cb[n]-c)*f));
      }
    }
    return stops.at(-1)[1];
  }

  function forecastUnix(){
    return parseProviderTime(spaceWeatherData?.aurora?.forecastTime) || Date.now()/1000;
  }

  function tileLatLon(coords,x,y){
    const point=L.point(coords.x*256+x,coords.y*256+y);
    return map.unproject(point,coords.z);
  }

  function cloudPixels(result){
    if(!result?.canvas)return null;
    try{
      const c=document.createElement('canvas');c.width=c.height=256;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(result.canvas,0,0,256,256);
      return ctx.getImageData(0,0,256,256).data;
    }catch(e){return null;}
  }

  function cloudClearFactor(pixels,x,y){
    if(!pixels)return 1;
    const ix=Math.max(0,Math.min(255,Math.round(x)));
    const iy=Math.max(0,Math.min(255,Math.round(y)));
    const i=(iy*256+ix)*4;
    const alpha=pixels[i+3]/255;
    // Satellite extraction is transparent in clear sky and increasingly opaque
    // over cloud. Keep a little residual visibility under thin/translucent cloud.
    return Math.max(0.06,1-alpha*0.94);
  }

  async function getViewingCloudTile(coords){
    if(typeof cloudGetTile!=='function')return null;
    try{
      const time=viewingCloudTime || frames?.at?.(-1)?.time || Math.floor(Date.now()/1000);
      return await cloudGetTile(coords,time,0);
    }catch(e){return null;}
  }

  const AuroraTiles=L.GridLayer.extend({
    initialize(options={}){L.GridLayer.prototype.initialize.call(this,options);this.mode=options.mode||'aurora';},
    createTile(coords,done){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
      canvas.className='space-weather-tile';
      const ctx=canvas.getContext('2d');
      const render=async()=>{
        if(!spaceWeatherData){done(null,canvas);return;}
        const cloud=this.mode==='viewing'?cloudPixels(await getViewingCloudTile(coords)):null;
        const unix=forecastUnix();
        for(let y=0;y<256;y+=TILE_STEP){
          for(let x=0;x<256;x+=TILE_STEP){
            const ll=tileLatLon(coords,x+TILE_STEP/2,y+TILE_STEP/2);
            let value=gridValue(ll.lat,ll.lng);
            if(value<0.6)continue;
            let factor=1;
            if(this.mode==='viewing'){
              factor=darknessFactor(unix,ll.lat,ll.lng)*cloudClearFactor(cloud,x,y);
              if(factor<0.035)continue;
            }
            const score=value*factor;
            if(score<0.45)continue;
            const [r,g,b]=auroraColor(this.mode==='viewing'?score:value);
            const base=Math.min(0.82,0.10+Math.sqrt(Math.min(100,value)/100)*0.72);
            const alpha=this.mode==='viewing'?base*Math.pow(factor,0.72):base;
            ctx.fillStyle=`rgba(${r},${g},${b},${alpha.toFixed(3)})`;
            ctx.fillRect(x,y,TILE_STEP+1,TILE_STEP+1);
          }
        }
        done(null,canvas);
      };
      render().catch(()=>done(null,canvas));
      return canvas;
    }
  });

  function layerOptions(mode){
    return {tileSize:256,minZoom:2,maxNativeZoom:6,maxZoom:18,noWrap:false,keepBuffer:1,
      updateWhenIdle:true,pane:'spaceWeatherPane',opacity:Number($('auroraOpacity')?.value||68)/100,
      mode,attribution:'Aurora forecast © NOAA SWPC OVATION'};
  }

  function removeLayer(ref){if(ref && map.hasLayer(ref))map.removeLayer(ref);}

  async function renderLayers(){
    const auroraOn=$('auroraOn')?.checked;
    const viewingOn=$('auroraViewingOn')?.checked;
    if(!auroraOn){removeLayer(auroraLayer);auroraLayer=null;}
    if(!viewingOn){removeLayer(viewingLayer);viewingLayer=null;}
    if(!auroraOn && !viewingOn){
      setStatus('Space weather layers are off.');
      return;
    }
    try{
      setStatus('Loading NOAA space weather…');
      await fetchSpaceWeather();
      if(viewingOn && typeof cloudEnsureMetadata==='function'){
        setStatus('Loading satellite cloud guidance for aurora viewing…');
        viewingCloudTime=frames?.at?.(-1)?.time || Math.floor(Date.now()/1000);
        await cloudEnsureMetadata().catch(()=>{});
      }
      if(auroraOn && !auroraLayer){auroraLayer=new AuroraTiles(layerOptions('aurora'));auroraLayer.addTo(map);}
      if(viewingOn && !viewingLayer){viewingLayer=new AuroraTiles(layerOptions('viewing'));viewingLayer.addTo(map);}
      setStatus(viewingOn?
        'Viewing conditions combine NOAA aurora forecast, astronomical darkness and satellite cloud transparency.':
        'NOAA OVATION aurora forecast is displayed for the forecast time shown below.','ok');
    }catch(error){
      setStatus('Space weather could not load: '+error.message,'bad');
    }
  }

  function setStatus(text,kind=''){
    const el=$('spaceWeatherStatus');if(!el)return;
    el.textContent=text;el.className='status'+(kind?' '+kind:'');
  }

  function kpLabel(value){
    if(!Number.isFinite(value))return '—';
    if(value>=9)return 'G5 · Extreme';
    if(value>=8)return 'G4 · Severe';
    if(value>=7)return 'G3 · Strong';
    if(value>=6)return 'G2 · Moderate';
    if(value>=5)return 'G1 · Minor storm';
    if(value>=4)return 'Active';
    return 'Quiet / unsettled';
  }

  function bzLabel(value){
    if(!Number.isFinite(value))return '—';
    if(value<=-10)return 'Strongly southward';
    if(value<=-5)return 'Southward · favorable';
    if(value<0)return 'Slightly southward';
    if(value>=5)return 'Northward · less favorable';
    return 'Near neutral';
  }

  function updateDashboard(){
    if(!spaceWeatherData)return;
    const kp=Number(spaceWeatherData.kp?.value);
    const speed=Number(spaceWeatherData.solarWind?.speed);
    const bz=Number(spaceWeatherData.solarWind?.bz);
    const bt=Number(spaceWeatherData.solarWind?.bt);
    if($('spaceKpValue'))$('spaceKpValue').textContent=Number.isFinite(kp)?kp.toFixed(1):'—';
    if($('spaceKpMeta'))$('spaceKpMeta').textContent=kpLabel(kp);
    if($('spaceWindValue'))$('spaceWindValue').textContent=Number.isFinite(speed)?Math.round(speed)+' km/s':'—';
    if($('spaceBzValue'))$('spaceBzValue').textContent=Number.isFinite(bz)?`${bz>0?'+':''}${bz.toFixed(1)} nT`:'—';
    if($('spaceBzMeta'))$('spaceBzMeta').textContent=bzLabel(bz)+(Number.isFinite(bt)?` · Bt ${bt.toFixed(1)} nT`:'');
    if($('spaceForecastTime'))$('spaceForecastTime').textContent=shortTime(spaceWeatherData.aurora?.forecastTime);
    if($('spaceObservationTime'))$('spaceObservationTime').textContent='OVATION input '+shortTime(spaceWeatherData.aurora?.observationTime);
  }

  function bindControls(){
    const aurora=$('auroraOn'),viewing=$('auroraViewingOn'),opacity=$('auroraOpacity');
    if(!aurora || !viewing || !opacity)return;
    aurora.addEventListener('change',()=>{
      if(aurora.checked && viewing.checked){viewing.checked=false;viewing.dispatchEvent(new Event('change',{bubbles:true}));}
      renderLayers();
    });
    viewing.addEventListener('change',()=>{
      if(viewing.checked && aurora.checked){aurora.checked=false;aurora.dispatchEvent(new Event('change',{bubbles:true}));}
      renderLayers();
    });
    opacity.addEventListener('input',()=>{
      $('auroraOpacityVal').textContent=opacity.value+'%';
      const value=Number(opacity.value)/100;
      auroraLayer?.setOpacity(value);viewingLayer?.setOpacity(value);
    });
    $('spaceWeatherRefresh')?.addEventListener('click',async()=>{
      spaceWeatherLoadedAt=0;
      try{await fetchSpaceWeather(true);setStatus('Space weather refreshed.','ok');}
      catch(e){setStatus('Space weather refresh failed: '+e.message,'bad');}
    });
    map.on('moveend zoomend',()=>{if(viewingLayer && map.hasLayer(viewingLayer))viewingLayer.redraw();});
  }

  bindControls();
  fetchSpaceWeather().catch(error=>setStatus('Space weather snapshot is not available yet: '+error.message,'warn'));
  setInterval(()=>{
    if($('auroraOn')?.checked || $('auroraViewingOn')?.checked || !document.hidden)fetchSpaceWeather(true).catch(()=>{});
  },REFRESH_MS);
})();
