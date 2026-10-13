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
  root.NorthernAuroraPlannerData={nearby,validateManifest,decodeGrid,cloudAt,kpAt,activity,rank,longitude};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.NorthernAuroraPlannerData;
})(typeof window!=='undefined'?window:globalThis);
