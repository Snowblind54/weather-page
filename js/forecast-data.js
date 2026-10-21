// MET Norway times are instants; precipitation belongs to the following period.
(function(root){
  const number=value=>typeof value==='number' && Number.isFinite(value)?value:null;
  function rows(payload,now=Date.now()){
    const series=payload?.properties?.timeseries;
    if(!Array.isArray(series))throw new Error('Invalid forecast response');
    const result=series.map(item=>{
      const time=Date.parse(item.time),d=item.data?.instant?.details||{};
      const hours=[1,6,12].find(h=>item.data?.['next_'+h+'_hours']);
      const period=hours?item.data['next_'+hours+'_hours']:null;
      return {time,temp:number(d.air_temperature),wind:number(d.wind_speed),gust:number(d.wind_speed_of_gust),direction:number(d.wind_from_direction),pressure:number(d.air_pressure_at_sea_level),cloud:number(d.cloud_area_fraction),hours:hours||null,rain:number(period?.details?.precipitation_amount),probability:number(period?.details?.probability_of_precipitation),symbol:period?.summary?.symbol_code||'',min:number(d.air_temperature_percentile_10),max:number(d.air_temperature_percentile_90)};
    }).filter(r=>Number.isFinite(r.time)&&r.temp!==null&&r.time>=Math.floor(now/3600000)*3600000).sort((a,b)=>a.time-b.time);
    if(!result.length)throw new Error('No current forecast times available');
    return result;
  }
  function dayKey(time,zone){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));
    return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');
  }
  async function prepareGustGrid(grid){
    if(grid?.encoding!=='uint16-le-gzip-base64')return grid;
    const count=grid.latitudes?.length*grid.longitudes?.length;
    if(!Number.isInteger(count)||count<4||count>100000||!Array.isArray(grid.samples)||grid.samples.length>40||grid.scale!==.01)throw Error('Invalid compressed gust grid');
    for(const sample of grid.samples){
      if(typeof sample.values!=='string'||sample.values.length>count*4+256)throw Error('Invalid compressed gust bytes');
      const bytes=Uint8Array.from(atob(sample.values),c=>c.charCodeAt(0));
      const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const raw=new Uint8Array(count*2);let length=0;
      try{
        while(true){const {value,done}=await reader.read();if(done)break;if(length+value.length>raw.length)throw Error('Oversized gust bytes');raw.set(value,length);length+=value.length;}
      }finally{await reader.cancel();}
      if(length!==raw.length)throw Error('Incomplete gust bytes');
      sample.values=Float32Array.from({length:count},(_,i)=>(raw[i*2]+256*raw[i*2+1])*.01);
    }
    grid.encoding='uint16-le-base64';return grid;
  }
  function validateGustGrid(grid,reference,region='Iceland'){
    if(!['Iceland','Canada','North America','Europe'].includes(region))throw Error('Invalid forecast gust region');
    const america=region==='North America',canada=region==='Canada',europe=region==='Europe';
    if(europe&&grid?.region!=='Europe')throw Error('Invalid Europe gust grid');
    if(america&&grid?.region!=='North America')throw Error('Invalid North America gust grid');
    if(canada&&grid?.region!=='Canada')throw Error('Invalid Canada gust grid');
    const ordered=(xs,min,max)=>Array.isArray(xs)&&xs.length>=2&&xs.length<=500&&xs.every((v,i)=>number(v)!==null&&v>=min&&v<=max&&(!i||v>xs[i-1]));
    const run=Date.parse(grid?.reference_time);
    if(!Number.isFinite(run)||run!==Date.parse(reference)||grid.units!=='m/s'||![.1,.25].includes(grid.grid_spacing_degrees)||!ordered(grid.latitudes,(america||europe)?18:canada?40:61,(america||canada||europe)?84:69)||!ordered(grid.longitudes,america?-190:canada?-142:europe?-30:-28,america?-30:canada?-50:europe?60:-12)||!Array.isArray(grid.samples)||!grid.samples.length||grid.samples.length>40)throw Error('Invalid Iceland gust grid');
    for(const xs of [grid.latitudes,grid.longitudes])if(xs.some((v,i)=>i&&Math.abs(v-xs[i-1]-grid.grid_spacing_degrees)>1e-8))throw Error('Invalid gust grid spacing');
    const count=grid.latitudes.length*grid.longitudes.length;
    if(count>((america||canada||europe)?100000:20000))throw Error('Oversized gust grid');
    let previous=-Infinity;
    for(const sample of grid.samples){
      if(grid.encoding==='uint16-le-base64'){
        if(grid.scale!==.01)throw Error('Invalid gust quantization');
        if(typeof sample.values==='string'){
          const raw=atob(sample.values);if(raw.length!==count*2)throw Error('Incomplete gust bytes');
          const values=new Float32Array(count);
          for(let i=0;i<count;i++)values[i]=(raw.charCodeAt(i*2)+256*raw.charCodeAt(i*2+1))*.01;
          sample.values=values;
        }
      }else if(grid.encoding!==undefined)throw Error('Invalid gust encoding');
      const time=Date.parse(sample.time),start=Date.parse(sample.start),end=Date.parse(sample.end);
      if(!Number.isFinite(time)||!Number.isFinite(start)||time<=previous||time!==end||start<run||start>=end||end-start>3*3600000||(time-run)%(3*3600000)!==0||time<=run||time-run>90*3600000||!(Array.isArray(sample.values)||(grid.encoding==='uint16-le-base64'&&sample.values instanceof Float32Array))||sample.values.length!==count||sample.values.some(v=>number(v)===null||v<0||v>150))throw Error('Invalid native gust sample');
      previous=time;
    }
    return grid;
  }
  function gustSample(grid,lat,lon,time){
    if(grid?.region==='North America'&&lon>=170&&lon<=180)lon-=360;
    if(!grid||!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(time)||lat<grid.latitudes[0]||lat>grid.latitudes.at(-1)||lon<grid.longitudes[0]||lon>grid.longitudes.at(-1))return null;
    const nearest=(xs,value)=>xs.reduce((best,x,i)=>Math.abs(x-value)<Math.abs(xs[best]-value)?i:best,0);
    const sample=grid.samples.reduce((best,s)=>Math.abs(Date.parse(s.time)-time)<Math.abs(Date.parse(best.time)-time)?s:best);
    if(Math.abs(Date.parse(sample.time)-time)>90*60000)return null;
    const y=nearest(grid.latitudes,lat),x=nearest(grid.longitudes,lon);
    return {value:sample.values[y*grid.longitudes.length+x],start:Date.parse(sample.start),end:Date.parse(sample.end),time:Date.parse(sample.time),run:Date.parse(grid.reference_time),resolution:grid.grid_spacing_degrees,lat:grid.latitudes[y],lon:grid.longitudes[x]};
  }
  function addGusts(series,grid,lat,lon){
    return series.map(row=>{
      if(row.gust!==null)return row;
      const sample=gustSample(grid,lat,lon,row.time);
      return sample?{...row,gust:sample.value,gustSource:'ECMWF IFS',gustStart:sample.start,gustEnd:sample.end,gustRun:sample.run,gustResolution:sample.resolution}:row;
    });
  }
  function days(series,zone){
    const groups=new Map();let rainUntil=-Infinity;
    for(const row of series){
      const key=dayKey(row.time,zone);
      if(!groups.has(key))groups.set(key,{key,time:row.time,low:row.temp,high:row.temp,wind:null,gust:null,rain:0,rainHours:0,symbol:row.symbol,partial:false});
      const day=groups.get(key);
      day.low=Math.min(day.low,row.temp);day.high=Math.max(day.high,row.temp);
      if(row.wind!==null)day.wind=Math.max(day.wind??0,row.wind);
      if(row.gust!==null)day.gust=Math.max(day.gust??0,row.gust);
      if(row.gustSource)day.ecmwfGusts=true;
      // Never add overlapping 1h/6h amounts, or invent a split at midnight.
      if(row.rain!==null&&row.hours&&row.time>=rainUntil){
        const end=row.time+row.hours*3600000;rainUntil=end;
        if(dayKey(end-1,zone)===key){day.rain+=row.rain;day.rainHours+=row.hours;}
        else day.partial=true;
      }
    }
    return Array.from(groups.values()).slice(0,7).map(d=>({...d,partial:d.partial||d.rainHours<24}));
  }
  const api={rows,days,dayKey,prepareGustGrid,validateGustGrid,gustSample,addGusts};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.MetForecastData=api;
})(typeof window==='undefined'?{}:window);



