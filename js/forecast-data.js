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
  function days(series,zone){
    const groups=new Map();let rainUntil=-Infinity;
    for(const row of series){
      const key=dayKey(row.time,zone);
      if(!groups.has(key))groups.set(key,{key,time:row.time,low:row.temp,high:row.temp,wind:null,gust:null,rain:0,rainHours:0,symbol:row.symbol,partial:false});
      const day=groups.get(key);
      day.low=Math.min(day.low,row.temp);day.high=Math.max(day.high,row.temp);
      if(row.wind!==null)day.wind=Math.max(day.wind??0,row.wind);
      if(row.gust!==null)day.gust=Math.max(day.gust??0,row.gust);
      // Never add overlapping 1h/6h amounts, or invent a split at midnight.
      if(row.rain!==null&&row.hours&&row.time>=rainUntil){
        const end=row.time+row.hours*3600000;rainUntil=end;
        if(dayKey(end-1,zone)===key){day.rain+=row.rain;day.rainHours+=row.hours;}
        else day.partial=true;
      }
    }
    return Array.from(groups.values()).slice(0,7).map(d=>({...d,partial:d.partial||d.rainHours<24}));
  }
  const api={rows,days,dayKey};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.MetForecastData=api;
})(typeof window==='undefined'?{}:window);
