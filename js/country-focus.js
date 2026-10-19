// One country selection shared by map imagery, observations, warnings and forecasts.
(function(root,factory){
  const core=factory();
  if(typeof module==='object'&&module.exports)module.exports=core;
  if(root.document)core.install(root);
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const normal=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const aliases={uk:'GB',greatbritain:'GB',britain:'GB',unitedkingdom:'GB',usa:'US',us:'US',unitedstatesofamerica:'US',czechrepublic:'CZ',holland:'NL',southkorea:'KR',northkorea:'KP',russia:'RU'};
  function parts(feature){const g=feature?.geometry;return g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];}
  function unwrap(ring){
    let last=null;
    return ring.map(([lon,lat])=>{if(last!==null){while(lon-last>180)lon-=360;while(lon-last< -180)lon+=360;}last=lon;return [lon,lat];});
  }
  function inRing(lat,lon,ring){
    const points=unwrap(ring);if(!points.length)return false;
    lon+=Math.round((points[0][0]-lon)/360)*360;let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const [x,y]=points[i],[a,b]=points[j],dx=a-x,dy=b-y;
      if(Math.abs((lon-x)*dy-(lat-y)*dx)<1e-9&&lon>=Math.min(x,a)-1e-9&&lon<=Math.max(x,a)+1e-9&&lat>=Math.min(y,b)-1e-9&&lat<=Math.max(y,b)+1e-9)return true;
      if((y>lat)!==(b>lat)&&lon<(a-x)*(lat-y)/(b-y)+x)inside=!inside;
    }
    return inside;
  }
  function contains(feature,lat,lon){return Number.isFinite(lat)&&Number.isFinite(lon)&&parts(feature).some(p=>inRing(lat,lon,p[0])&&!p.slice(1).some(r=>inRing(lat,lon,r)));}
  function bounds(feature){
    const polygons=parts(feature);let south=90,north=-90,west=Infinity,east=-Infinity;
    // Keep the main landmass in the initial view. All islands remain included
    // in the country mask, including Alaska/Hawaii and overseas territories.
    const area=ring=>{const r=unwrap(ring);return Math.abs(r.reduce((n,p,i)=>{const q=r[(i+1)%r.length];return n+p[0]*q[1]-q[0]*p[1];},0));};
    const main=polygons.reduce((a,p)=>!a||area(p[0])>area(a[0])?p:a,null);
    for(const [lon,lat] of unwrap(main?.[0]||[])){south=Math.min(south,lat);north=Math.max(north,lat);west=Math.min(west,lon);east=Math.max(east,lon);}
    return [[south,west],[north,east]];
  }
  function path(feature,project,centerLon=0){
    let d='';
    for(const polygon of parts(feature)){
      const outer=unwrap(polygon[0]);if(!outer.length)continue;
      const shift=360*Math.round((centerLon-outer[0][0])/360);
      for(const copy of [-360,0,360])for(const ring of polygon){
        const points=unwrap(ring);const align=360*Math.round((outer[0][0]-(points[0]?.[0]||0))/360);
        for(let i=0;i<points.length;i++){const [lon,lat]=points[i],p=project(lat,lon+shift+copy+align);d+=(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1);}
        d+='Z';
      }
    }
    return d;
  }
  function range(values,pixels){let min=Infinity,max=-Infinity;for(let i=0;i<values.length;i++)if(pixels[i*4+3]&&Number.isFinite(values[i])){min=Math.min(min,values[i]);max=Math.max(max,values[i]);}return {min,max};}
  const scopedPanes=['overlayPane','markerPane','shadowPane','warningPane','warningFillPane','officialWindPane','windPane','windHeatmapPane','snowPane','forecastModel','forecastPoint','rainAccumulationPane'];
  function install(root){
    const form=document.getElementById('countrySearchForm');if(!form||typeof map==='undefined')return;
    const input=document.getElementById('countrySearchInput'),results=document.getElementById('countrySearchResults'),status=document.getElementById('countrySearchStatus'),clear=document.getElementById('countrySearchClear');
    let current=null,catalogue=[],features=[],ready=null,generation=0,controller=null,timer=null,items=[],active=-1,clipRaf=null;
    const byIso=new Map(),byId=new Map();
    const key=()=>current?.id||'all';
    function matchesCountry(value){
      if(!current)return true;const n=normal(value),alias=aliases[n];
      return n===normal(current.iso2)||n===normal(current.id)||n===normal(current.name)||n===normal(current.feature.properties?.name)||alias===current.iso2;
    }
    const allowsPoint=(lat,lon)=>!current||contains(current.feature,Number(lat),Number(lon));
    const allowsStation=s=>!current||(s.country?matchesCountry(s.country):allowsPoint(s.lat,s.lon??s.lng));
    function message(s){status.textContent=s;}
    async function load(){
      if(ready)return ready;
      ready=Promise.all([fetch('assets/country-search.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw Error('Country list unavailable');return r.json();}),loadTemperatureCountryFeatures()]).then(([data,geo])=>{
        features=geo;for(const f of geo)byId.set(String(f.id).padStart(3,'0'),f);
        catalogue=data.countries.filter(c=>byId.has(c.id)).map(c=>({...c,feature:byId.get(c.id)}));
        for(const c of catalogue)byIso.set(c.iso2,c);return catalogue;
      }).catch(e=>{ready=null;throw e;});return ready;
    }
    const svgNS='http://www.w3.org/2000/svg',svg=document.createElementNS(svgNS,'svg'),defs=document.createElementNS(svgNS,'defs'),clip=document.createElementNS(svgNS,'clipPath'),shape=document.createElementNS(svgNS,'path');
    svg.setAttribute('class','country-focus-defs');svg.setAttribute('aria-hidden','true');clip.id='country-weather-clip';clip.setAttribute('clipPathUnits','userSpaceOnUse');shape.setAttribute('clip-rule','evenodd');shape.setAttribute('fill-rule','evenodd');clip.append(shape);defs.append(clip);svg.append(defs);map.getContainer().append(svg);
    function clipPanes(){
      clipRaf=null;
      if(current)shape.setAttribute('d',path(current.feature,(lat,lon)=>map.latLngToLayerPoint([lat,lon]),map.getCenter().lng));
      for(const name of scopedPanes){const pane=map.getPane(name);if(!pane)continue;pane.style.clipPath=current?'url(#country-weather-clip)':'';pane.style.webkitClipPath=current?'url(#country-weather-clip)':'';pane.dataset.countryFocus=current?.iso2||'';}
    }
    function scheduleClip(){if(clipRaf===null)clipRaf=requestAnimationFrame(clipPanes);}
    map.on('zoomend viewreset moveend resize layeradd',scheduleClip);
    // During animated zoom Leaflet transforms each renderer independently.
    // Hide scoped panes until their common geographic clip has been reprojected.
    map.on('zoomstart',()=>{if(current)for(const n of scopedPanes)map.getPane(n)?.classList.add('country-focus-zooming');});
    map.on('zoomend',()=>{clipPanes();for(const n of scopedPanes)map.getPane(n)?.classList.remove('country-focus-zooming');});
    function fit(){if(current)map.fitBounds(bounds(current.feature),{paddingTopLeft:[38,150],paddingBottomRight:[window.innerWidth>1000?450:38,120],maxZoom:10,animate:false});}
    function redraw(){
      if(typeof invalidateTemperatureHeatmapCache==='function')invalidateTemperatureHeatmapCache();
      if(typeof officialTemperatureSelectionCache!=='undefined')officialTemperatureSelectionCache.clear();
      if(typeof officialWindRenderKey!=='undefined')officialWindRenderKey='';
      if(typeof renderTemperatureLabels==='function')renderTemperatureLabels(selectedWindTime());
      if(temperatureEnabled())queueTemperatureRender(selectedWindTime(),0);
      if(typeof renderOfficialWind==='function')renderOfficialWind();
      windLayer?.scheduleReset();windHeatmapLayer?.scheduleReset();
      if(typeof renderSnowDepth==='function')renderSnowDepth();
      if(activeAccumulationHours())queueRainfallRender(0);
      if(document.getElementById('warningOn')?.checked)loadWarnings(true).catch(console.warn);
      document.dispatchEvent(new CustomEvent('country-focus-change',{detail:current?{id:current.id,iso2:current.iso2,name:current.name}:null}));
      clipPanes();
    }
    function hide(){items=[];active=-1;results.replaceChildren();results.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
    function cancel(){generation++;clearTimeout(timer);controller?.abort();controller=null;}
    async function select(item,{restore=false}={}){
      cancel();hide();input.value=item.label||item.name;
      try{
        const selection=generation;await load();if(selection!==generation)return;const country=byIso.get(item.iso2);if(!country)throw Error('Country boundary unavailable');
        current=country;clear.hidden=false;input.blur();
        try{localStorage.setItem('northWeatherCountryFocusV1',country.iso2);}catch(_){}
        document.body.classList.add('country-focused');map.closePopup();clipPanes();
        // Selecting a country always starts with its current temperatures.
        document.getElementById('clearLayers').click();fit();
        document.getElementById('latest').click();if(document.getElementById('tempMode'))document.getElementById('tempMode').value='temperature';document.getElementById('tempOn').checked=true;document.getElementById('heatmapOn').checked=true;
        redraw();updateCategoryIndicators();if(openedWeatherPanel!=='tempSection')openWeatherPanel('tempSection');
        message(country.name+' only · Clear to show all countries');
        positionWeatherPanel();updateTemperatureVisibility();
      }catch(error){message('Could not select this country. Please try again.');console.warn(error);if(restore)try{localStorage.removeItem('northWeatherCountryFocusV1');}catch(_){};}
    }
    function clearCountry(){
      cancel();hide();current=null;input.value='';clear.hidden=true;message('');document.body.classList.remove('country-focused');
      try{localStorage.removeItem('northWeatherCountryFocusV1');}catch(_){}
      map.closePopup();redraw();positionWeatherPanel();input.focus();
    }
    function show(found){
      hide();items=found;
      found.forEach((p,i)=>{const li=document.createElement('li');li.id='country-choice-'+i;li.setAttribute('role','option');li.setAttribute('aria-selected','false');
        const title=document.createElement('strong'),detail=document.createElement('span');title.textContent=p.label||p.name;detail.textContent=p.place?'Show weather in '+p.name:'Country · show weather within its borders';li.append(title,detail);li.addEventListener('mousedown',e=>e.preventDefault());li.addEventListener('click',()=>select(p));results.append(li);});
      results.hidden=!found.length;input.setAttribute('aria-expanded',String(!!found.length));
    }
    async function search(){
      cancel();const id=generation,q=input.value.trim();if(q.length<2){hide();message(current?current.name+' only':'');return;}
      message('Searching…');
      try{
        await load();if(id!==generation)return;const n=normal(q);
        const local=catalogue.filter(c=>normal(c.name).includes(n)||normal(c.feature.properties?.name).includes(n)||normal(c.iso2)===n||aliases[n]===c.iso2).sort((a,b)=>(normal(b.name)===n)-(normal(a.name)===n)||a.name.localeCompare(b.name)).slice(0,6);
        show(local);message(local.length?'Choose a country, or a place below.':'Searching places…');
        const abort=new AbortController();controller=abort;const timeout=setTimeout(()=>abort.abort(),10000);
        try{
          const params=new URLSearchParams({name:q,count:'6',language:'en',format:'json'}),response=await fetch('https://geocoding-api.open-meteo.com/v1/search?'+params,{signal:abort.signal});if(!response.ok)throw Error('Location search unavailable');
          const data=await response.json();if(id!==generation)return;
          const places=(data.results||[]).filter(p=>byIso.has(p.country_code)&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)).map(p=>{const c=byIso.get(p.country_code);return {...c,label:[p.name,p.admin1,c.name].filter((v,i,a)=>v&&a.indexOf(v)===i).join(', '),place:true};});
          show([...local,...places].slice(0,10));message(items.length?'Select a result to show its country.':'No matching country or place.');
        }catch(error){if(id===generation)message(local.length?'Choose a country above. Place search is unavailable.':'Search unavailable. Try a country name.');}
        finally{clearTimeout(timeout);if(controller===abort)controller=null;}
      }catch(error){if(id===generation){message('Country boundaries could not load. Try again.');console.warn('Country search:',error);}}
    }
    form.addEventListener('submit',e=>{e.preventDefault();if(items.length)select(items[active<0?0:active]);else search();});
    input.addEventListener('input',()=>{cancel();hide();message(current?current.name+' only':'');if(input.value.trim().length>=2)timer=setTimeout(search,350);});
    input.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.stopPropagation();cancel();hide();message(current?current.name+' only':'');}
      else if(items.length&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();active=active<0?(e.key==='ArrowDown'?0:items.length-1):(active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;[...results.children].forEach((li,i)=>li.setAttribute('aria-selected',String(i===active)));input.setAttribute('aria-activedescendant','country-choice-'+active);}
    });
    clear.addEventListener('click',clearCountry);
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('.country-search')){cancel();hide();}});
    // Country view buttons stay within the selected country. The cyclone and
    // space-weather panels intentionally retain their global view controls.
    document.addEventListener('click',e=>{const b=e.target.closest('button'),panel=b?.closest('.weather-panel');if(current&&panel&&!['cycloneSection','spaceWeatherSection'].includes(panel.id)&&/^View\b/i.test(b.textContent.trim())){e.preventDefault();e.stopImmediatePropagation();fit();}},true);
    root.NorthernCountryFocus={key,active:()=>!!current,current:()=>current,matchesCountry,allowsPoint,allowsStation,range,fit,clear:clearCountry};
    try{const saved=localStorage.getItem('northWeatherCountryFocusV1');if(saved)load().then(()=>{const c=byIso.get(saved);if(c)select(c,{restore:true});}).catch(()=>message('Saved country could not load. Search again.'));}catch(_){}
  }
  return {normal,parts,unwrap,inRing,contains,bounds,path,range,scopedPanes,install};
});
