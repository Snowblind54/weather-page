(function(root){
  const HOUR=3600000;
  const layers=Object.freeze({
    temperature:{name:'air_temperature_2m',label:'Temperature',unit:'°C',range:[213.15,333.15],ticks:['−60','−40','−20','0','20','40','60+'],palette:'metnoredblue'},
    rain:{name:'precipitation_amount',label:'Precipitation',unit:'mm / hour',range:[0.1,10],ticks:['0.1','2.1','4.1','6.0','8.0','10+'],palette:'metnoprecipitation',offset:HOUR},
    wind:{name:'wind_speed_10m',label:'Sustained wind',unit:'m/s',range:[0,30],ticks:['0','6','12','18','24','30+'],palette:'rainbow'},
    gusts:{name:'wind_speed_of_gust',label:'Wind gusts',unit:'m/s',range:[0,40],ticks:['0','8','16','24','32','40+'],palette:'rainbow'},
    clouds:{name:'cloud_area_fraction',label:'Cloud cover',unit:'%',range:[0,1],ticks:['0','20','40','60','80','100'],palette:'greyscale'}
  });
  function expandTimes(value){
    const times=[];
    for(const token of value.trim().split(',')){
      const parts=token.trim().split('/');
      if(parts.length===1){const t=Date.parse(parts[0]);if(Number.isFinite(t))times.push(t);continue;}
      const match=/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(parts[2]||'');
      const step=match?(Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0))*1000:0;
      const start=Date.parse(parts[0]),end=Date.parse(parts[1]);
      if(!step||!Number.isFinite(start)||!Number.isFinite(end)||end<start||(end-start)/step>500)continue;
      for(let t=start;t<=end;t+=step)times.push(t);
    }
    return [...new Set(times)].sort((a,b)=>a-b);
  }
  function runs(paths){return [...new Set(paths.filter(p=>/^metpplatest\/met_forecast_1_0km_nordic_\d{8}T\d{2}Z\.nc$/.test(p)))].sort().reverse();}
  function reference(path){const m=/(\d{4})(\d{2})(\d{2})T(\d{2})Z\.nc$/.exec(path);return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4]):NaN;}
  function availableTimes(raw,now=Date.now()){
    const start=Math.floor(now/HOUR)*HOUR,last=raw.at(-1)-HOUR;
    // Leave one ending hour for rain, so every layer shares the same timeline.
    return raw.filter(t=>t>=start&&t<=last);
  }
  function params(kind,time){
    const l=layers[kind];if(!l||!Number.isFinite(time))throw new Error('Invalid forecast map selection');
    return {layers:l.name,styles:'raster/'+l.palette,time:new Date(time+(l.offset||0)).toISOString(),colorscalerange:l.range.join(','),numcolorbands:64,logscale:false,belowmincolor:kind==='rain'?'transparent':'extend',abovemaxcolor:'extend',nodatacolor:'transparent'};
  }
  function assetUrl(manifest,kind,time){
    if(!layers[kind]||manifest.delivery!=='static-regional-images')throw Error('Shared forecast images unavailable');
    const name=time===undefined?kind+'-legend.webp':kind+'-'+new Date(time).toISOString().replace(/[-:]/g,'').slice(0,11)+'Z.webp';
    const path=time===undefined?manifest.legends?.[kind]:manifest.images?.[kind]?.[new Date(time).toISOString()];
    let cycle=new Date(manifest.reference_time).toISOString().replace(/[-:]/g,'').slice(0,11)+'Z';
    if(manifest.asset_version!==undefined){if(!((manifest.asset_root==='forecast-iceland-cache'&&['atlantic-v1','euroatlantic-v2','euroatlantic-v3','euroatlantic-v4','euroatlantic-v5'].includes(manifest.asset_version))||(manifest.asset_root==='forecast-canada-cache'&&['canada-v1','northamerica-v2','northamerica-v3','northamerica-v4','northamerica-v5'].includes(manifest.asset_version))||((manifest.asset_root||'forecast-cache')==='forecast-cache'&&['temperature-v1','precipitation-v2'].includes(manifest.asset_version))))throw Error('Invalid forecast asset version');cycle+='-'+manifest.asset_version;}
    const assetRoot=manifest.asset_root||'forecast-cache';
    if(!['forecast-cache','forecast-iceland-cache','forecast-canada-cache'].includes(assetRoot))throw Error('Invalid forecast asset root');
    if(typeof path!=='string'||!path.startsWith('data/'+assetRoot+'/'+cycle+'/')||path.split('/').length!==4||path.split('/').at(-1)!==name)throw Error('Invalid shared forecast image');
    return typeof root.weatherDataUrl==='function'?root.weatherDataUrl(path):path;
  }
  function cachedTimes(manifest,now=Date.now()){
    const raw=expandTimes((manifest.cached_times||[]).join(','));
    const start=Math.floor(now/HOUR)*HOUR;
    return raw.filter(t=>t>=start&&Object.keys(manifest.layers||{}).every(kind=>{
      try{assetUrl(manifest,kind,t);return true;}catch{return false;}
    }));
  }
  function regionalTimes(regions,now=Date.now()){
    const end=Math.floor(now/HOUR)*HOUR+72*HOUR;
    return [...new Set(regions.flatMap(region=>cachedTimes(region,now)))].filter(t=>t<=end).sort((a,b)=>a-b);
  }
  function regionLabel(region){
    if(region.region==='Iceland')return ['euroatlantic-v2','euroatlantic-v3','euroatlantic-v4','euroatlantic-v5'].includes(region.asset_version)?'Europe / Arctic':'Iceland / Atlantic';
    if(region.region==='Canada'&&['northamerica-v2','northamerica-v3','northamerica-v4','northamerica-v5'].includes(region.asset_version))return 'North America / Atlantic';
    return region.region;
  }
  function visibleRegions(regions,bounds,kind,time){
    const visible=[],west=bounds.getWest(),east=bounds.getEast();
    for(const region of regions){
      if(bounds.getNorth()<=region.bounds[1]||bounds.getSouth()>=region.bounds[3])continue;
      try{assetUrl(region,kind,time);}catch{continue;}
      // The same immutable image can be placed in adjacent world copies.
      // This includes western Aleutian islands whose canonical longitude is +170°.
      const first=Math.floor((west-region.bounds[2])/360)+1,last=Math.ceil((east-region.bounds[0])/360)-1;
      for(let copy=first;copy<=last&&copy<first+4;copy++){
        const shift=copy*360;
        visible.push(shift===0?region:{...region,bounds:[region.bounds[0]+shift,region.bounds[1],region.bounds[2]+shift,region.bounds[3]],longitude_shift:shift});
      }
    }
    return visible;
  }
  function temperatureTicks(manifest){return manifest?.temperature_range_celsius?.[0]===-60&&manifest?.temperature_range_celsius?.[1]===60?layers.temperature.ticks:['−20','−10','0','10','20','30+'];}
  const api={temperatureTicks,layers,expandTimes,runs,reference,availableTimes,params,assetUrl,cachedTimes,regionalTimes,regionLabel,visibleRegions};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ForecastMapData=api;
})(typeof window==='undefined'?{}:window);




