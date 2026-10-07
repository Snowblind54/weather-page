// Model-derived warm/cold fronts matched to the cyclone GFS cycle.
(function(){
  'use strict';

  if(typeof map==='undefined' || typeof L==='undefined')return;
  const FRONT_URL='data/fronts.json';
  const REFRESH_MS=15*60*1000;
  let frontData=null,frontLoadedAt=0,frontLoadPromise=null,frontRetryAt=0;
  let frontGroup=null,frontRenderTimer=null;

  if(!map.getPane('frontPane')){
    map.createPane('frontPane');
    map.getPane('frontPane').style.zIndex='604';
    map.getPane('frontPane').style.pointerEvents='none';
  }

  function $(id){return document.getElementById(id);}

  function validFrontData(data){
    if(data?.version!==1 || !Number.isFinite(data.modelRun) || !Number.isFinite(data.generatedAt) ||
      !Number.isFinite(data.forecastEnd) || !Array.isArray(data.frames) || data.frames.length>30)throw new Error('Invalid fronts snapshot');
    let previous=-Infinity,total=0;
    for(const frame of data.frames){
      if(!Number.isFinite(frame.time) || frame.time<=previous || frame.time<data.modelRun || frame.time>data.forecastEnd ||
        !Array.isArray(frame.lines) || frame.lines.length>60)throw new Error('Invalid fronts frame');
      previous=frame.time;
      for(const line of frame.lines){
        if(!['cold','warm'].includes(line.type) || !Array.isArray(line.points) || line.points.length<2 || line.points.length>1200)throw new Error('Invalid front line');
        total+=line.points.length;if(total>120000)throw new Error('Front snapshot too large');
        for(const point of line.points){
          if(!Array.isArray(point)||point.length!==2||!Number.isFinite(point[0])||!Number.isFinite(point[1])||point[0]<-85||point[0]>45||point[1]<20||point[1]>82)throw new Error('Invalid front coordinate');
        }
      }
    }
    return data;
  }

  function hideFronts(){
    if(frontGroup)map.removeLayer(frontGroup);
    frontGroup=null;
  }

  function selectedFrame(){
    const frames=frontData?.frames||[];
    if(!frames.length || typeof cycloneSelectedTime!=='function')return null;
    const selected=cycloneSelectedTime();
    let best=null,bestDistance=Infinity;
    for(const frame of frames){
      const distance=Math.abs(frame.time-selected);
      if(distance<bestDistance){best=frame;bestDistance=distance;}
    }
    return bestDistance<=2*3600?best:null;
  }

  function symbolIcon(kind,angle){
    const colour=kind==='cold'?'#51a9ff':'#ff6875';
    const shape=kind==='cold'
      ?'<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2 16 15H2Z" fill="currentColor"/></svg>'
      :'<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 14a7 7 0 0 1 14 0Z" fill="currentColor"/></svg>';
    return L.divIcon({className:'front-symbol-marker',iconSize:[18,18],iconAnchor:[9,9],html:'<span class="front-symbol '+kind+'" style="color:'+colour+';transform:rotate('+angle.toFixed(1)+'deg)">'+shape+'</span>'});
  }

  function decorate(points,kind,layers){
    if(points.length<3)return;
    let lastPixel=null;
    for(let i=1;i<points.length-1;i++){
      const current=map.latLngToLayerPoint(points[i]);
      if(lastPixel && current.distanceTo(lastPixel)<72)continue;
      const before=map.latLngToLayerPoint(points[i-1]),after=map.latLngToLayerPoint(points[i+1]);
      const tangent=Math.atan2(after.y-before.y,after.x-before.x)*180/Math.PI;
      layers.push(L.marker(points[i],{pane:'frontPane',interactive:false,keyboard:false,icon:symbolIcon(kind,tangent+90)}));
      lastPixel=current;
    }
  }

  function renderFronts(){
    hideFronts();
    const toggle=$('cycloneFrontsOn'),status=$('cycloneFrontsStatus');
    if(!toggle?.checked || !$('cycloneOn')?.checked){
      if(status)status.textContent='Model-derived fronts are off.';
      return;
    }
    if(!frontData){if(status)status.textContent='Loading GFS frontal analysis…';return;}
    if(typeof cycloneData!=='undefined' && cycloneData && frontData.modelRun!==cycloneData.modelRun){
      if(status)status.textContent='Fronts are waiting for the matching cyclone model run.';
      return;
    }
    const frame=selectedFrame();
    if(!frame){if(status)status.textContent='Fronts are unavailable for this forecast time.';return;}
    const layers=[];
    let cold=0,warm=0;
    for(const line of frame.lines){
      const points=line.points.map(point=>[point[1],point[0]]);
      const colour=line.type==='cold'?'#51a9ff':'#ff6875';
      layers.push(L.polyline(points,{pane:'frontPane',color:colour,weight:3.2,opacity:.95,interactive:false,smoothFactor:1.2,lineCap:'round',lineJoin:'round'}));
      decorate(points,line.type,layers);
      if(line.type==='cold')cold++;else warm++;
    }
    frontGroup=L.layerGroup(layers).addTo(map);
    if(status)status.textContent=`${cold} cold · ${warm} warm · ${fmt(frame.time)} · NOAA GFS model-derived fronts`;
  }

  async function loadFronts(force=false){
    const status=$('cycloneFrontsStatus');
    if(!$('cycloneFrontsOn')?.checked || !$('cycloneOn')?.checked)return;
    if(!force&&frontData&&Date.now()-frontLoadedAt<REFRESH_MS){renderFronts();return;}
    if(Date.now()<frontRetryAt){renderFronts();return;}
    if(!frontLoadPromise){
      if(status)status.textContent='Loading GFS frontal analysis…';
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
      frontLoadPromise=(async()=>{
        try{
          const response=await fetch(FRONT_URL+'?v='+Math.floor(Date.now()/REFRESH_MS),{cache:'no-store',signal:controller.signal});
          if(!response.ok)throw new Error('fronts HTTP '+response.status);
          frontData=validFrontData(await response.json());
          frontLoadedAt=Date.now();frontRetryAt=0;
        }catch(error){
          frontRetryAt=Date.now()+60000;
          if(!frontData){
            if(status)status.textContent='Front data could not load: '+error.message;
            throw error;
          }
          console.warn('Front refresh failed',error.message);
        }finally{clearTimeout(timer);}
      })().finally(()=>{frontLoadPromise=null;});
    }
    await frontLoadPromise;renderFronts();
  }

  $('cycloneFrontsOn')?.addEventListener('change',()=>{
    if($('cycloneFrontsOn').checked)loadFronts().catch(()=>{});else hideFronts();
    if(!$('cycloneFrontsOn').checked && $('cycloneFrontsStatus'))$('cycloneFrontsStatus').textContent='Model-derived fronts are off.';
  });

  const originalRender=window.renderCyclones;
  if(typeof originalRender==='function'){
    window.renderCyclones=function(){
      const result=originalRender.apply(this,arguments);
      if($('cycloneFrontsOn')?.checked)loadFronts().catch(()=>{});else hideFronts();
      return result;
    };
  }
  const originalHide=window.hideCycloneLayers;
  if(typeof originalHide==='function'){
    window.hideCycloneLayers=function(){
      const result=originalHide.apply(this,arguments);hideFronts();return result;
    };
  }

  map.on('zoomend moveend',()=>{
    if(!$('cycloneFrontsOn')?.checked || !$('cycloneOn')?.checked)return;
    clearTimeout(frontRenderTimer);frontRenderTimer=setTimeout(renderFronts,100);
  });
  setInterval(()=>{if($('cycloneFrontsOn')?.checked&&$('cycloneOn')?.checked)loadFronts().catch(()=>{});},5*60*1000);
})();
