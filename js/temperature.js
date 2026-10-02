const TEMP_BOUNDS=[[53.70,20.40],[59.90,28.50]];
const TEMP_REGIONS=[
  {id:'baltics',bounds:[[53.70,20.40],[59.90,28.50]],w:260,h:205},
  {id:'scandinavia',bounds:[[54.40,4.00],[71.60,32.20]],w:330,h:245},
  {id:'iceland',bounds:[[62.70,-25.20],[67.20,-12.40]],w:230,h:150}
];

function makeGrid(south,north,west,east,latStep,lonStep){
  const pts=[];
  for(let lat=south;lat<=north+0.001;lat+=latStep){
    for(let lon=west;lon<=east+0.001;lon+=lonStep){
      pts.push([+lat.toFixed(2),+lon.toFixed(2)]);
    }
  }
  return pts;
}

// Regional grids are intentionally separate so Iceland does not force a huge
// raster across the North Atlantic.
const SCANDI_TEMP_GRID=makeGrid(54.8,71.2,4.8,31.6,1.35,2.2);
const ICELAND_TEMP_GRID=makeGrid(63.0,67.0,-24.8,-13.0,0.8,1.8);

// Extra exact sampling points for Nordic temperature readouts.
// Keeping these as direct Open-Meteo points means each displayed city uses
// its own model value instead of extrapolating from the Baltic grid.
const NORDIC_TEMP_POINTS=[
  // Finland
  [60.17,24.94],[61.50,23.76],[60.45,22.27],[65.01,25.47],
  [66.50,25.73],[62.89,27.68],[63.10,21.62],[62.24,25.75],

  // Sweden
  [59.33,18.07],[57.71,11.97],[55.60,13.00],[63.83,20.26],
  [65.58,22.15],[60.67,17.14],[67.85,20.23],

  // Norway
  [59.91,10.75],[60.39,5.32],[63.43,10.39],[69.65,18.96],
  [58.97,5.73],[68.44,17.43],[70.98,25.97],

  // Iceland
  [64.15,-21.94],[65.68,-18.09],[65.26,-14.40],
  [66.07,-23.12],[64.25,-15.21],[63.75,-20.22]
];

function tempColor(t){
  const stops=[
    [-20,[75,60,167]],[-10,[40,95,201]],[0,[49,167,223]],
    [10,[87,198,106]],[20,[240,218,59]],[30,[246,139,44]],[40,[220,61,61]]
  ];
  if(t<=stops[0][0]) return stops[0][1];
  if(t>=stops.at(-1)[0]) return stops.at(-1)[1];
  for(let i=0;i<stops.length-1;i++){
    const [a,ca]=stops[i], [b,cb]=stops[i+1];
    if(t>=a && t<=b){
      const f=(t-a)/(b-a);
      return ca.map((v,j)=>Math.round(v+(cb[j]-v)*f));
    }
  }
  return [255,255,255];
}

function sampleTemperatureAt(series, unix){
  const times=series.times;
  const temps=series.temps;
  if(!times.length) return NaN;

  if(unix<=times[0]) return temps[0];
  if(unix>=times[times.length-1]) return temps[temps.length-1];

  for(let i=0;i<times.length-1;i++){
    const a=times[i], b=times[i+1];
    if(unix>=a && unix<=b){
      const ta=temps[i], tb=temps[i+1];
      if(!Number.isFinite(ta)) return tb;
      if(!Number.isFinite(tb)) return ta;
      const f=(unix-a)/(b-a);
      return ta+(tb-ta)*f;
    }
  }
  return NaN;
}

function interpolateTemp(lat,lon,unix){
  let num=0,den=0;
  for(const s of temperatureSeries){
    const sv=sampleTemperatureAt(s,unix);
    if(!Number.isFinite(sv)) continue;

    const dx=(lon-s.lon)*Math.cos(lat*Math.PI/180);
    const dy=(lat-s.lat);
    const d2=dx*dx+dy*dy;

    if(d2<1e-8) return sv;

    const w=1/Math.pow(d2,1.35);
    num+=w*sv;
    den+=w;
  }
  return den?num/den:NaN;
}

function nearestQuarterHour(unix){
  return Math.round(unix/900)*900;
}

function setTempCache(key,dataUrl,minT,maxT){
  temperatureImageCache.set(key,dataUrl);
  temperatureStatsCache.set(key,{minT,maxT});

  while(temperatureImageCache.size>TEMP_CACHE_LIMIT){
    const oldest=temperatureImageCache.keys().next().value;
    temperatureImageCache.delete(oldest);
    temperatureStatsCache.delete(oldest);
  }
}

function renderTemperatureLabels(unix){
  if(map.hasLayer(temperatureLabels)) map.removeLayer(temperatureLabels);
  temperatureLabels.clearLayers();

  if(!$('tempOn').checked || !temperatureSeries.length) return;

  // Major locations across the Baltics and Nordics.
  // At lower zooms use capitals/major hubs to keep labels readable.
  const labelPts = map.getZoom()<=6 ? [
    [59.44,24.75], // Tallinn
    [56.95,24.11], // Riga
    [54.69,25.28], // Vilnius
    [60.17,24.94], // Helsinki
    [59.33,18.07], // Stockholm
    [59.91,10.75], // Oslo
    [64.15,-21.94], // Reykjavik
    [65.01,25.47], // Oulu
    [69.65,18.96]  // Tromso
  ] : [
    // Estonia
    [59.44,24.75], // Tallinn
    [58.38,26.72], // Tartu
    [58.25,22.49], // Kuressaare
    [58.94,23.54], // Haapsalu
    [59.38,28.19], // Narva
    [58.88,25.56], // Paide
    [57.78,26.04], // Valga
    [58.36,24.50], // Parnu
    [59.18,27.28], // Johvi
    [58.00,25.93], // Viljandi

    // Latvia
    [56.95,24.11], // Riga
    [56.51,21.01], // Liepaja
    [57.39,21.56], // Ventspils
    [56.65,23.72], // Jelgava
    [55.87,26.52], // Daugavpils
    [57.54,25.43], // Valmiera
    [56.65,27.72], // Rezekne

    // Lithuania
    [54.69,25.28], // Vilnius
    [54.90,23.90], // Kaunas
    [55.70,21.14], // Klaipeda
    [55.93,23.32], // Siauliai
    [55.73,24.36], // Panevezys
    [54.40,24.04], // Alytus
    [55.29,23.97], // Kedainiai

    // Finland
    [60.17,24.94], // Helsinki
    [61.50,23.76], // Tampere
    [60.45,22.27], // Turku
    [65.01,25.47], // Oulu
    [66.50,25.73], // Rovaniemi
    [62.89,27.68], // Kuopio
    [63.10,21.62], // Vaasa
    [62.24,25.75], // Jyvaskyla

    // Sweden
    [59.33,18.07], // Stockholm
    [57.71,11.97], // Gothenburg
    [55.60,13.00], // Malmo
    [63.83,20.26], // Umea
    [65.58,22.15], // Lulea
    [60.67,17.14], // Gavle
    [67.85,20.23], // Kiruna

    // Norway
    [59.91,10.75], // Oslo
    [60.39,5.32], // Bergen
    [63.43,10.39], // Trondheim
    [69.65,18.96], // Tromso
    [58.97,5.73], // Stavanger
    [68.44,17.43], // Narvik
    [70.98,25.97], // Honningsvag

    // Iceland
    [64.15,-21.94], // Reykjavik
    [65.68,-18.09], // Akureyri
    [65.26,-14.40], // Egilsstadir
    [66.07,-23.12], // Isafjordur
    [64.25,-15.21], // Hofn
    [63.75,-20.22]  // Selfoss
  ];

  for(const [lat,lon] of labelPts){
    const t=interpolateTemp(lat,lon,unix);
    if(!Number.isFinite(t)) continue;

    L.marker([lat,lon],{
      interactive:false,
      icon:L.divIcon({
        className:'',
        html:`<div class="temp-label">${Math.round(t)}°C</div>`,
        iconSize:[46,22],
        iconAnchor:[23,11]
      })
    }).addTo(temperatureLabels);
  }

  temperatureLabels.addTo(map);
}

async function createTemperatureImage(unix, token){
  const cacheKey=nearestQuarterHour(unix);

  if(temperatureImageCache.has(cacheKey)){
    const cached=temperatureImageCache.get(cacheKey);
    const stats=temperatureStatsCache.get(cacheKey);
    return {key:cacheKey,regions:cached,minT:stats.minT,maxT:stats.maxT};
  }

  const rendered=[];
  let globalMin=Infinity,globalMax=-Infinity;

  for(const region of TEMP_REGIONS){
    const W=region.w,H=region.h;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d',{alpha:true});
    const img=ctx.createImageData(W,H);
    const d=img.data;

    const south=region.bounds[0][0], west=region.bounds[0][1];
    const north=region.bounds[1][0], east=region.bounds[1][1];

    for(let y=0;y<H;y++){
      if(token!==temperatureRenderToken) return null;
      const lat=north-(y/(H-1))*(north-south);

      for(let x=0;x<W;x++){
        const lon=west+(x/(W-1))*(east-west);
        const value=interpolateTemp(lat,lon,cacheKey);
        const i=(y*W+x)*4;

        if(!Number.isFinite(value)){
          d[i+3]=0;
          continue;
        }

        globalMin=Math.min(globalMin,value);
        globalMax=Math.max(globalMax,value);
        const c=tempColor(value);
        d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; d[i+3]=205;
      }
      if(y%10===0) await new Promise(requestAnimationFrame);
    }

    ctx.putImageData(img,0,0);
    rendered.push({id:region.id,bounds:region.bounds,dataUrl:canvas.toDataURL('image/png')});
  }

  if(token!==temperatureRenderToken) return null;
  temperatureImageCache.set(cacheKey,rendered);
  temperatureStatsCache.set(cacheKey,{minT:globalMin,maxT:globalMax});
  while(temperatureImageCache.size>TEMP_CACHE_LIMIT){
    const oldest=temperatureImageCache.keys().next().value;
    temperatureImageCache.delete(oldest);
    temperatureStatsCache.delete(oldest);
  }
  return {key:cacheKey,regions:rendered,minT:globalMin,maxT:globalMax};
}

async function buildTemperatureOverlay(unix,{precache=false}={}){
  if(!$('tempOn').checked || !temperatureSeries.length) return;

  const token=temperatureRenderToken;
  const result=await createTemperatureImage(unix,token);
  if(!result || token!==temperatureRenderToken || !$('tempOn').checked) return;
  if(precache) return;

  if(temperatureLayer){
    map.removeLayer(temperatureLayer);
    temperatureLayer=null;
  }

  if($('heatmapOn')?.checked){
    const opacity=Number($('tempOpacity').value)/100;
    const layers=result.regions.map(region=>L.imageOverlay(region.dataUrl,region.bounds,{
      opacity,
      interactive:false
    }));
    temperatureLayer=L.layerGroup(layers).addTo(map);
    temperatureLayer.setOpacity=value=>temperatureLayer.eachLayer(layer=>layer.setOpacity(value));
  }

  // Numeric readings stay visible even when the heatmap is switched off.
  renderTemperatureLabels(unix);

  $('tempStatus').textContent=
    `Temperature: Baltic + Nordic readings${$('heatmapOn')?.checked?' + heatmap':''} · ${result.minT.toFixed(1)} to ${result.maxT.toFixed(1)} °C · ${fmt(unix)} · cached`;
  $('tempStatus').className='status ok';
  weatherFront();
}

function queueTemperatureRender(unix,delay=90){
  if(temperatureDebounceTimer) clearTimeout(temperatureDebounceTimer);

  temperatureDebounceTimer=setTimeout(async()=>{
    temperatureRenderToken++;
    const myToken=temperatureRenderToken;

    try{
      await buildTemperatureOverlay(unix);
      if(myToken===temperatureRenderToken) scheduleTemperaturePrecache(unix);
    }catch(e){
      if(myToken!==temperatureRenderToken) return;
      console.error(e);
      $('tempStatus').textContent='Temperature render failed: '+e.message;
      $('tempStatus').className='status bad';
    }
  },delay);
}

function scheduleTemperaturePrecache(centerUnix){
  if(temperaturePrecacheTimer) clearTimeout(temperaturePrecacheTimer);

  temperaturePrecacheTimer=setTimeout(async()=>{
    if(!$('tempOn').checked || !temperatureSeries.length) return;

    const center=nearestQuarterHour(centerUnix);
    const candidates=[
      center-900,
      center+900,
      center-1800,
      center+1800,
      center-2700,
      center+2700
    ];

    for(const t of candidates){
      if(!$('tempOn').checked) break;
      if(temperatureImageCache.has(t)) continue;

      // Give the UI a moment between background frames.
      await new Promise(resolve=>setTimeout(resolve,40));
      const token=temperatureRenderToken;
      await buildTemperatureOverlay(t,{precache:true});
      if(token!==temperatureRenderToken) break;
    }
  },250);
}

async function fetchTemperatureSeries(points){
  const lats=points.map(p=>p[0]).join(',');
  const lons=points.map(p=>p[1]).join(',');

  const url='https://api.open-meteo.com/v1/forecast?latitude='+encodeURIComponent(lats)+
            '&longitude='+encodeURIComponent(lons)+
            '&minutely_15=temperature_2m'+
            '&past_minutely_15=12'+
            '&forecast_minutely_15=4'+
            '&timezone=UTC';

  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok) throw new Error('temperature API HTTP '+r.status);

  const j=await r.json();
  const arr=Array.isArray(j)?j:[j];

  return arr.map((v,i)=>{
    const point=points[i];
    if(!point) return null;

    const times=(v.minutely_15?.time||[]).map(s=>Math.floor(Date.parse(s+'Z')/1000));
    const temps=(v.minutely_15?.temperature_2m||[]).map(Number);

    return {
      lat:point[0],
      lon:point[1],
      times,
      temps
    };
  }).filter(v=>v && v.times.length && v.temps.some(Number.isFinite));
}

async function loadTemperatures(force=false){
  const now=Date.now();

  if(!force && temperatureSeries.length && now-temperatureLoadedAt<10*60*1000){
    const i=Number($('timeline').value);
    const frame=frames[i];
    if(frame) queueTemperatureRender(frame.time,0);
    return;
  }

  $('tempStatus').textContent='Temperature: loading Baltic + Nordic heatmap data…';
  $('tempStatus').className='status';

  const balticPts=[];
  for(let lat=53.85;lat<=59.85;lat+=0.55){
    for(let lon=20.55;lon<=28.45;lon+=0.95){
      balticPts.push([+lat.toFixed(2),+lon.toFixed(2)]);
    }
  }

  // Open-Meteo multi-location calls are kept moderate in size for reliability.
  const fetchChunks=async points=>{
    const out=[];
    for(let i=0;i<points.length;i+=80){
      out.push(...await fetchTemperatureSeries(points.slice(i,i+80)));
    }
    return out;
  };

  const [balticSeries,scandiSeries,icelandSeries,nordicCitySeries]=await Promise.all([
    fetchChunks(balticPts),
    fetchChunks(SCANDI_TEMP_GRID),
    fetchChunks(ICELAND_TEMP_GRID),
    fetchTemperatureSeries(NORDIC_TEMP_POINTS)
  ]);

  temperatureSeries=[
    ...balticSeries,
    ...scandiSeries,
    ...icelandSeries,
    ...nordicCitySeries
  ];

  if(!balticSeries.length) throw new Error('no Baltic temperature timeline returned');
  if(!scandiSeries.length) throw new Error('no Scandinavian temperature grid returned');
  if(!icelandSeries.length) throw new Error('no Iceland temperature grid returned');

  temperatureLoadedAt=Date.now();
  temperatureImageCache.clear();
  temperatureStatsCache.clear();

  const i=Number($('timeline').value);
  const frame=frames[i];
  if(frame) queueTemperatureRender(frame.time,0);
}
