// Relative viewing guidance, not a calibrated probability of seeing aurora.
(function(root){
  'use strict';
  const HOUR=3600000,rad=Math.PI/180;
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const longitude=lon=>((lon+180)%360+360)%360-180;
  function nearby(point,radius=50){
    if(!finite(point.lat)||!finite(point.lon)||Math.abs(point.lat)>90||![0,25,50,100].includes(radius))throw Error('Invalid viewing location');
    const base={lat:point.lat,lon:longitude(point.lon),distance:0,direction:'Selected location'};
    if(!radius)return [base];
    const phi=point.lat*rad,lambda=point.lon*rad,d=radius/6371;
    return [base,...['N','NE','E','SE','S','SW','W','NW'].map((direction,i)=>{
      const bearing=i*Math.PI/4;
      const lat=Math.asin(Math.sin(phi)*Math.cos(d)+Math.cos(phi)*Math.sin(d)*Math.cos(bearing));
      const lon=lambda+Math.atan2(Math.sin(bearing)*Math.sin(d)*Math.cos(phi),Math.cos(d)-Math.sin(phi)*Math.sin(lat));
      return {lat:lat/rad,lon:longitude(lon/rad),distance:radius,direction};
    })];
  }
  function validateManifest(meta){
    if(meta?.version!==1||meta.asset_version!=='cloud-v1'||!finite(Date.parse(meta.reference_time))||meta.resolution!==.25||!Array.isArray(meta.grids)||meta.grids.length!==12)throw Error('Shared cloud forecast unavailable');
    const cycle=new Date(meta.reference_time).toISOString().replace(/[-:]/g,'').slice(0,11)+'Z-cloud-v1';
    meta.grids.forEach((g,i)=>{
      if(g.path!==`data/aurora-planner-cloud/${cycle}/cloud-${i}-v1.json`||JSON.stringify(g.bounds)!==JSON.stringify([-180+i*30,35,-150+i*30,90])||g.width!==121||g.height!==221)throw Error('Invalid cloud forecast tile');
    });
    return meta;
  }
  function decodeGrid(grid,meta,band){
    const spec=meta.grids[band];
    if(grid?.version!==1||grid.reference_time!==meta.reference_time||grid.resolution!==.25||grid.encoding!=='uint8-base64'||grid.missing!==255||grid.width!==121||grid.height!==221||JSON.stringify(grid.bounds)!==JSON.stringify(spec.bounds)||!Array.isArray(grid.samples)||grid.samples.length!==25)throw Error('Invalid planner cloud grid');
    const run=Date.parse(meta.reference_time);
    const samples=grid.samples.map((sample,i)=>{
      const time=Date.parse(sample.time);
      if(time!==run+i*3*HOUR||typeof sample.values!=='string')throw Error('Invalid cloud forecast time');
      const raw=atob(sample.values);
      if(raw.length!==121*221)throw Error('Incomplete cloud forecast tile');
      const values=Uint8Array.from(raw,c=>c.charCodeAt(0));
      if(values.some(v=>v>100&&v!==255))throw Error('Invalid cloud percentage');
      return {time,values};
    });
    return {...grid,samples};
  }
  function cloudAt(grid,point,time){
    if(!grid||point.lat<grid.bounds[1]||point.lat>grid.bounds[3]||point.lon<grid.bounds[0]||point.lon>grid.bounds[2])return null;
    const x=Math.round((point.lon-grid.bounds[0])/.25),y=Math.round((point.lat-grid.bounds[1])/.25),index=y*grid.width+x;
    const upper=grid.samples.findIndex(s=>s.time>=time);
    if(upper<0||time<grid.samples[0].time)return null;
    const b=grid.samples[upper],a=grid.samples[Math.max(0,upper-1)],av=a.values[index],bv=b.values[index];
    if(av===255||bv===255||!finite(av)||!finite(bv))return null;
    return b.time===a.time?bv:av+(bv-av)*(time-a.time)/(b.time-a.time);
  }
  function kpAt(snapshot,time,now){
    const forecast=snapshot?.kpForecast;
    if(!finite(forecast?.fetchedAt)||now-forecast.fetchedAt*1000>12*HOUR||forecast.fetchedAt*1000>now+5*60000)return null;
    const bin=forecast.bins?.find(b=>Date.parse(b.start)<=time&&time<Date.parse(b.end));
    return bin&&finite(bin.value)&&bin.value>=0&&bin.value<=9&&['estimated','predicted'].includes(bin.kind)&&Date.parse(bin.end)-Date.parse(bin.start)===3*HOUR?bin.value:null;
  }
  function activity(point,kp){
    // Centred-dipole magnetic latitude: approximate geometry for relative ranking.
    // Kp is planetary; this is deliberately not presented as local sighting odds.
    const magnetic=Math.asin(Math.sin(point.lat*rad)*Math.sin(80.65*rad)+Math.cos(point.lat*rad)*Math.cos(80.65*rad)*Math.cos((point.lon+72.68)*rad))/rad;
    const offset=magnetic-(65-2*kp);
    return Math.max(.01,Math.min(1,(offset+8)/14));
  }
  function rank({points,grids,snapshot,now=Date.now(),altitude}){
    const start=Math.ceil(now/HOUR)*HOUR,end=now+48*HOUR,candidates=[];
    const diagnostics={darkHours:0,cloudHours:0,activityHours:0};
    for(const point of points){
      const band=Math.min(11,Math.floor((longitude(point.lon)+180)/30)),grid=grids.get(band);
      if(!grid||now-Date.parse(grid.reference_time)>24*HOUR)continue;
      const hours=[];
      for(let t=start;t+HOUR<=end;t+=HOUR){
        const sun=Math.max(altitude(t,point),altitude(t+HOUR/2,point),altitude(t+HOUR,point));
        if(!finite(sun)||sun>=-12){hours.push(null);continue;}
        diagnostics.darkHours++;
        const cloud=cloudAt(grid,point,t+HOUR/2);
        if(cloud===null){hours.push(null);continue;}
        diagnostics.cloudHours++;
        const kp=kpAt(snapshot,t+HOUR/2,now);
        if(kp===null){hours.push(null);continue;}
        diagnostics.activityHours++;
        const signal=activity(point,kp),dark=Math.min(1,(-sun-12)/6);
        hours.push({time:t,cloud,kp,signal,sun,score:100*signal*Math.max(0,1-cloud/100)*(.7+.3*dark)});
      }
      for(let i=0;i<hours.length-1;i++){
        const a=hours[i],b=hours[i+1];if(!a||!b||b.time-a.time!==HOUR)continue;
        const cloud=(a.cloud+b.cloud)/2,signal=(a.signal+b.signal)/2,score=(a.score+b.score)/2;
        candidates.push({point,start:a.time,end:b.time+HOUR,cloud,kp:Math.max(a.kp,b.kp),signal,score,
          label:signal<.35?'Weak activity signal':cloud>=75?'Mostly cloudy':score>=55?'Promising':score>=25?'Fair conditions':'Limited conditions'});
      }
    }
    candidates.sort((a,b)=>b.score-a.score||a.start-b.start||a.point.distance-b.point.distance);
    const windows=[];
    for(const window of candidates){
      if(windows.every(w=>window.end<=w.start||window.start>=w.end))windows.push(window);
      if(windows.length===3)break;
    }
    return {windows,diagnostics};
  }
  function planningConfidence({grid,point,time,snapshot,now=Date.now()}){
    const run=Date.parse(grid?.reference_time),cloud=cloudAt(grid,point,time),kp=kpAt(snapshot,time,now);
    if(!finite(run)||cloud===null||kp===null)return {label:'Limited',reason:'Missing or stale forecast inputs; single cloud model.'};
    const lead=Math.max(0,(time-run)/HOUR),age=Math.max(0,(now-run)/HOUR);
    const probes=[cloud,cloudAt(grid,point,time-3*HOUR),cloudAt(grid,point,time+3*HOUR),
      ...[[.25,0],[-.25,0],[0,.25],[0,-.25]].map(([lat,lon])=>cloudAt(grid,{lat:point.lat+lat,lon:point.lon+lon},time))].filter(finite);
    const spread=Math.max(...probes)-Math.min(...probes);
    const limited=lead>30||age>18||spread>35;
    const reason=lead>30?'Longer forecast lead time':age>18?'Older cloud model run':spread>35?'Cloud cover varies strongly nearby or through time':'Shorter lead time and reasonably stable modelled clouds';
    return {label:limited?'Limited':'Moderate',reason:reason+'; single cloud model, no independent model agreement check.',spread};
  }
  function cloudTimeline({grid,point,snapshot,now=Date.now(),altitude}){
    const start=Math.floor(now/HOUR)*HOUR;
    return Array.from({length:49},(_,i)=>{
      const time=start+i*HOUR,cloud=cloudAt(grid,point,time),kp=kpAt(snapshot,time,now);
      return {time,cloud,kp,dark:altitude(time,point)<-12};
    });
  }
  function stamp(value){
    if(finite(value))return value>1e12?value:value*1000;
    if(typeof value!=='string')return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value)?value:value.replace(' ','T')+'Z');
  }
  function auroraAt(snapshot,point){
    const a=snapshot?.aurora;
    if(!a||!Number.isInteger(a.width)||!Number.isInteger(a.height)||!finite(a.latMin)||!finite(a.latMax)||!Array.isArray(a.values)||a.values.length!==a.width*a.height||point.lat<a.latMin||point.lat>a.latMax)return null;
    const x=((point.lon%360)+360)%360,y=point.lat-a.latMin;
    const x0=Math.floor(x)%a.width,x1=(x0+1)%a.width,y0=Math.min(a.height-1,Math.max(0,Math.floor(y))),y1=Math.min(a.height-1,y0+1),fx=x-Math.floor(x),fy=y-Math.floor(y);
    const values=[a.values[y0*a.width+x0],a.values[y0*a.width+x1],a.values[y1*a.width+x0],a.values[y1*a.width+x1]];
    if(values.some(v=>!finite(v)||v<0||v>100))return null;
    return (values[0]*(1-fx)+values[1]*fx)*(1-fy)+(values[2]*(1-fx)+values[3]*fx)*fy;
  }
  function bzTrend(history,now){
    if(!Array.isArray(history))return 'Trend unavailable';
    const rows=history.filter(r=>Array.isArray(r)&&finite(r[1])&&stamp(r[0])<=now+60000&&stamp(r[0])>=now-30*60000).sort((a,b)=>stamp(a[0])-stamp(b[0]));
    if(rows.length<4||now-stamp(rows.at(-1)[0])>30*60000)return 'Trend unavailable';
    const early=rows.slice(0,Math.floor(rows.length/2)),late=rows.slice(Math.floor(rows.length/2));
    const mean=xs=>xs.reduce((v,r)=>v+r[1],0)/xs.length,diff=mean(late)-mean(early);
    return diff<=-2?'Turning more southward':diff>=2?'Turning more northward':'Little recent change';
  }
  function goNow({point,grid,snapshot,now=Date.now(),altitude}){
    const wind=snapshot?.solarWind,aurora=snapshot?.aurora;
    const age=(value,max)=>finite(stamp(value))&&now-stamp(value)>=-5*60000&&now-stamp(value)<=max;
    const currentSun=altitude(now,point),sun=Math.max(currentSun,altitude(now+HOUR/2,point),altitude(now+HOUR,point));
    const cloud=cloudAt(grid,point,now),cloudNext=cloudAt(grid,point,now+HOUR);
    const cloudFresh=age(grid?.reference_time,18*HOUR)&&cloud!==null&&cloudNext!==null;
    const spaceFresh=age(snapshot?.generatedAt,15*60000)&&age(aurora?.observationTime,90*60000)&&finite(stamp(aurora?.forecastTime))&&stamp(aurora.forecastTime)>=now-20*60000&&stamp(aurora.forecastTime)<=now+90*60000;
    const windFresh=age(wind?.speedTime,30*60000)&&age(wind?.magTime,30*60000)&&finite(wind?.speed)&&finite(wind?.bz);
    let signal=auroraAt(snapshot,point);
    // Aurora can be visible on the horizon. Use a regional signal, never call
    // the weighted neighbouring intensity a calibrated local probability.
    if(signal!==null){
      for(const distance of [200,400,600]){
        const sample={lat:Math.min(90,point.lat+distance/111.2),lon:point.lon};
        const v=auroraAt(snapshot,sample);if(v!==null)signal=Math.max(signal,v*(1-distance/900));
      }
    }
    const fresh=cloudFresh&&spaceFresh&&windFresh&&signal!==null;
    const average=cloudFresh?(cloud+cloudNext)/2:null;
    const score=fresh&&sun<-12?signal*Math.max(0,1-average/100):0;
    let label,reason;
    if(!finite(currentSun)){label='Conditions unavailable';reason='Solar geometry is unavailable.';}
    else if(currentSun>=-12){label='Not dark enough yet';reason='Wait until the sky is darker. The 48-hour planner can find a later window.';}
    else if(sun>=-12){label='Darkness is ending';reason='The sky will brighten during the next hour.';}
    else if(!fresh){label='Wait for fresh live data';reason=!cloudFresh?'The current cloud forecast is missing or older than 18 hours.':!spaceFresh?'The short-term aurora forecast is missing or stale.':'Solar-wind speed or Bz is missing or older than 30 minutes.';}
    else if(average>=75){label='Clouds limit viewing';reason='Most of the sky is forecast to be covered during the next hour.';}
    else if(signal<10){label='Activity looks weak';reason='NOAA shows a weak regional aurora signal, even with a dark sky.';}
    else if(score>=20&&wind.bz<0){label='Worth heading out now';reason='Darkness, clearer forecast skies and a fresh aurora signal align. Southward Bz supports activity.';}
    else{label='Watch conditions closely';reason=wind.bz>=0?'Aurora is modelled nearby, but northward Bz is less favourable.':'Conditions are mixed; check the sky and the live aurora layer before leaving.';}
    return {point,label,reason,score,fresh,cloud:average,currentCloud:cloud,sun:currentSun,signal,windFresh,spaceFresh,cloudFresh,bz:windFresh?wind.bz:null,speed:windFresh?wind.speed:null,trend:windFresh?bzTrend(wind.bzHistory,now):'Trend unavailable'};
  }
  root.NorthernAuroraPlannerData={nearby,validateManifest,decodeGrid,cloudAt,kpAt,activity,rank,longitude,planningConfidence,cloudTimeline,goNow,auroraAt,bzTrend};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.NorthernAuroraPlannerData;
})(typeof window!=='undefined'?window:globalThis);
