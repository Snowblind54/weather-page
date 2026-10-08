(function(root){
  const HOUR=3600000;
  const layers=Object.freeze({
    temperature:{name:'air_temperature_2m',label:'Temperature',unit:'°C',range:[253.15,303.15],ticks:['−20','−10','0','10','20','30+'],palette:'metnoredblue'},
    rain:{name:'precipitation_amount',label:'Rain / snow',unit:'mm / hour',range:[0.1,10],ticks:['0.1','2.1','4.1','6.0','8.0','10+'],palette:'metnoprecipitation',offset:HOUR},
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
    if(manifest.asset_version!==undefined){if(manifest.asset_root!=='forecast-iceland-cache'||manifest.asset_version!=='atlantic-v1')throw Error('Invalid forecast asset version');cycle+='-'+manifest.asset_version;}
    const assetRoot=manifest.asset_root||'forecast-cache';
    if(!['forecast-cache','forecast-iceland-cache'].includes(assetRoot))throw Error('Invalid forecast asset root');
    if(typeof path!=='string'||!path.startsWith('data/'+assetRoot+'/'+cycle+'/')||path.split('/').length!==4||path.split('/').at(-1)!==name)throw Error('Invalid shared forecast image');
    return path;
  }
  function cachedTimes(manifest,now=Date.now()){
    const raw=expandTimes((manifest.cached_times||[]).join(','));
    const start=Math.floor(now/HOUR)*HOUR;
    return raw.filter(t=>t>=start&&Object.keys(manifest.layers||{}).every(kind=>{
      try{assetUrl(manifest,kind,t);return true;}catch{return false;}
    }));
  }
  function visibleRegions(regions,bounds,kind,time){
    return regions.filter(region=>!(bounds.getEast()<region.bounds[0]||bounds.getWest()>region.bounds[2]||bounds.getNorth()<region.bounds[1]||bounds.getSouth()>region.bounds[3])).filter(region=>{
      try{assetUrl(region,kind,time);return true;}catch{return false;}
    });
  }
  const api={layers,expandTimes,runs,reference,availableTimes,params,assetUrl,cachedTimes,visibleRegions};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ForecastMapData=api;
})(typeof window==='undefined'?{}:window);
