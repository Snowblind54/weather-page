// Shared satellite pixel processing, used by the worker and compatibility fallback.
const cloudSolarPositions=new Map();
function solarElevationDegrees(unix,lat=57.1,lon=24.9){
  if(cloudSolarPositions.has(unix)){
    const {dec,angle}=cloudSolarPositions.get(unix),phi=lat*Math.PI/180;
    return Math.asin(Math.sin(phi)*Math.sin(dec)+Math.cos(phi)*Math.cos(dec)*Math.cos((angle+lon)*Math.PI/180))*180/Math.PI;
  }
  const rad=Math.PI/180;
  const deg=180/Math.PI;
  const jd=unix/86400 + 2440587.5;
  const n=jd-2451545.0;

  let L=(280.460 + 0.9856474*n)%360;
  if(L<0) L+=360;
  let g=(357.528 + 0.9856003*n)%360;
  if(g<0) g+=360;

  const lambda=(L + 1.915*Math.sin(g*rad) + 0.020*Math.sin(2*g*rad))*rad;
  const epsilon=(23.439 - 0.0000004*n)*rad;

  const ra=Math.atan2(Math.cos(epsilon)*Math.sin(lambda),Math.cos(lambda))*deg;
  const dec=Math.asin(Math.sin(epsilon)*Math.sin(lambda));

  let gmst=(18.697374558 + 24.06570982441908*n)%24;
  if(gmst<0) gmst+=24;

  const angle=gmst*15-ra;
  cloudSolarPositions.set(unix,{dec,angle});
  if(cloudSolarPositions.size>64)cloudSolarPositions.delete(cloudSolarPositions.keys().next().value);
  let H=angle+lon;
  H=((H+180)%360+360)%360-180;
  H*=rad;

  const phi=lat*rad;
  const elev=Math.asin(
    Math.sin(phi)*Math.sin(dec) +
    Math.cos(phi)*Math.cos(dec)*Math.cos(H)
  );

  return elev*deg;
}

function smoothstep(a,b,x){
  if(a===b) return x<a?0:1;
  let t=(x-a)/(b-a);
  t=Math.max(0,Math.min(1,t));
  return t*t*(3-2*t);
}

function blurAlpha(src,w,h,radius=5){
  if(radius<=0) return src;
  const tmp=new Float32Array(src.length);
  const out=new Float32Array(src.length);
  const size=radius*2+1;

  for(let y=0;y<h;y++){
    let sum=0;
    const row=y*w;
    for(let k=-radius;k<=radius;k++) sum+=src[row+Math.max(0,Math.min(w-1,k))];
    for(let x=0;x<w;x++){
      tmp[row+x]=sum/size;
      const oldX=Math.max(0,x-radius);
      const newX=Math.min(w-1,x+radius+1);
      sum+=src[row+newX]-src[row+oldX];
    }
  }

  for(let x=0;x<w;x++){
    let sum=0;
    for(let k=-radius;k<=radius;k++) sum+=tmp[Math.max(0,Math.min(h-1,k))*w+x];
    for(let y=0;y<h;y++){
      out[y*w+x]=sum/size;
      const oldY=Math.max(0,y-radius);
      const newY=Math.min(h-1,y+radius+1);
      sum+=tmp[newY*w+x]-tmp[oldY*w+x];
    }
  }
  return out;
}

function visualCloudScore(r,g,b){
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  const chroma=max-min;
  const lum=0.2126*r+0.7152*g+0.0722*b;
  const bright=smoothstep(62,205,lum);
  const neutral=1-smoothstep(22,105,chroma);
  return Math.max(0,Math.min(1,bright*(0.58+0.42*neutral)));
}


// NASA GIBS Band 13 palette converted to cold-cloud luminance (official colour map).
const CLOUD_GOES_IR_PALETTE=[[255,255,255,255],[127,0,127,255],[140,13,135,255],[153,25,142,255],[165,38,150,255],[178,51,157,255],[191,64,165,255],[204,76,173,255],[217,89,180,255],[229,102,188,255],[242,114,195,255],[255,127,203,255],[230,230,230,254],[204,204,204,252],[177,177,177,250],[155,155,155,247],[129,129,129,245],[102,102,102,243],[76,76,76,241],[54,54,54,239],[27,27,27,236],[5,5,5,234],[26,0,0,232],[51,0,0,230],[77,0,0,228],[102,0,0,225],[128,0,0,223],[153,0,0,221],[179,0,0,219],[204,0,0,216],[230,0,0,214],[255,0,0,212],[255,26,0,210],[255,51,0,208],[255,77,0,205],[255,102,0,203],[255,128,0,201],[255,153,0,199],[255,179,0,196],[255,204,0,194],[255,230,0,192],[255,255,0,190],[230,255,0,188],[204,255,0,185],[179,255,0,183],[153,255,0,181],[128,255,0,179],[102,255,0,177],[77,255,0,174],[51,255,0,172],[26,255,0,170],[0,255,0,168],[0,234,10,165],[0,212,19,163],[0,191,29,161],[0,170,38,159],[0,149,48,157],[0,128,58,154],[0,106,67,152],[0,85,77,150],[0,64,86,148],[0,42,96,146],[0,21,105,145],[0,0,115,144],[0,0,125,143],[0,13,122,142],[0,26,129,140],[0,38,136,139],[0,51,143,138],[0,64,150,137],[0,76,157,136],[0,89,164,135],[0,102,171,134],[0,115,178,133],[0,128,185,132],[0,140,192,130],[0,153,199,129],[0,166,206,128],[0,178,213,127],[0,191,220,126],[0,204,227,125],[0,217,234,124],[0,230,241,123],[0,242,248,122],[0,255,255,121],[197,197,197,119],[196,196,196,118],[194,194,194,117],[193,193,193,116],[192,192,192,115],[191,191,191,114],[189,189,189,113],[188,188,188,112],[187,187,187,111],[185,185,185,109],[184,184,184,108],[183,183,183,107],[181,181,181,106],[180,180,180,105],[179,179,179,104],[178,178,178,103],[176,176,176,102],[175,175,175,101],[174,174,174,99],[172,172,172,98],[171,171,171,97],[170,170,170,96],[169,169,169,95],[167,167,167,94],[166,166,166,93],[165,165,165,92],[163,163,163,91],[162,162,162,89],[161,161,161,88],[159,159,159,87],[158,158,158,86],[157,157,157,85],[156,156,156,84],[154,154,154,83],[153,153,153,82],[152,152,152,81],[150,150,150,79],[149,149,149,78],[148,148,148,77],[147,147,147,76],[145,145,145,75],[144,144,144,74],[143,143,143,73],[141,141,141,72],[140,140,140,71],[139,139,139,70],[138,138,138,68],[136,136,136,67],[135,135,135,66],[134,134,134,65],[132,132,132,64],[131,131,131,63],[130,130,130,62],[128,128,128,61],[127,127,127,60],[126,126,126,58],[125,125,125,57],[123,123,123,56],[122,122,122,55],[121,121,121,54],[119,119,119,53],[118,118,118,52],[117,117,117,51],[116,116,116,50],[114,114,114,48],[113,113,113,47],[112,112,112,46],[110,110,110,45],[109,109,109,44],[108,108,108,43],[106,106,106,42],[105,105,105,41],[104,104,104,40],[103,103,103,38],[101,101,101,37],[100,100,100,36],[99,99,99,35],[97,97,97,34],[96,96,96,33],[95,95,95,32],[94,94,94,31],[92,92,92,30],[91,91,91,28],[90,90,90,27],[88,88,88,26],[87,87,87,25],[86,86,86,24],[84,84,84,23],[83,83,83,22],[82,82,82,21],[81,81,81,20],[79,79,79,19],[78,78,78,17],[77,77,77,16],[75,75,75,15],[74,74,74,14],[73,73,73,13],[72,72,72,12],[70,70,70,11],[69,69,69,10],[68,68,68,9],[66,66,66,7],[65,65,65,6],[64,64,64,5],[62,62,62,4],[61,61,61,3],[60,60,60,2],[59,59,59,1],[57,57,57,0],[56,56,56,0],[55,55,55,0],[53,53,53,0],[52,52,52,0],[51,51,51,0],[50,50,50,0],[48,48,48,0],[47,47,47,0],[46,46,46,0],[44,44,44,0],[43,43,43,0],[42,42,42,0],[41,41,41,0],[39,39,39,0],[38,38,38,0],[37,37,37,0],[35,35,35,0],[34,34,34,0],[33,33,33,0],[31,31,31,0],[30,30,30,0],[29,29,29,0],[28,28,28,0],[26,26,26,0],[25,25,25,0],[24,24,24,0],[22,22,22,0],[21,21,21,0],[20,20,20,0],[19,19,19,0],[17,17,17,0],[16,16,16,0],[15,15,15,0],[13,13,13,0],[12,12,12,0],[11,11,11,0],[9,9,9,0],[8,8,8,0],[7,7,7,0],[6,6,6,0],[4,4,4,0],[3,3,3,0],[2,2,2,0],[1,1,1,0]];
const cloudIRColours=new Map();
function cloudInfraredLuminance(r,g,b){
  const key=(r>>3)*1024+(g>>3)*32+(b>>3);
  if(cloudIRColours.has(key)) return cloudIRColours.get(key);
  let distance=Infinity, lum=0;
  for(const c of CLOUD_GOES_IR_PALETTE){
    const d=(r-c[0])**2+(g-c[1])**2+(b-c[2])**2;
    if(d<distance){distance=d;lum=c[3];}
  }
  cloudIRColours.set(key,lum);
  return lum;
}
function cloudSolarMix(unix,lat,lon){
  const elevation=solarElevationDegrees(unix,lat,lon);
  const dayMix=smoothstep(0,5,elevation);
  return {elevation,dayMix,mode:dayMix<=.001?'night':dayMix>=.999?'day':'twilight'};
}
function cloudTileLocation(coords,x=128,y=128){
  const n=2**coords.z;
  return {lon:(coords.x+x/256)/n*360-180,
    lat:Math.atan(Math.sinh(Math.PI*(1-2*(coords.y+y/256)/n)))*180/Math.PI};
}
function cloudSourceWeights(lat,lon){
  if(lat<25 || lat>85 || lon< -170 || lon>42) return {eumet:0,noaa:0,gibs:0,west:0};
  const east=smoothstep(-56,-51,lon), north=smoothstep(49,50.3,lat);
  // Fade at the limb; geostationary satellites cannot see the poles.
  const limb=(satLon)=>smoothstep(.151,.22,
    Math.cos(lat*Math.PI/180)*Math.cos((lon-satLon)*Math.PI/180));
  const western=1-smoothstep(-115,-100,lon);
  const eumet=east*limb(0), gibs=(1-east)*north*(1-western)*limb(-75);
  const west=(1-east)*north*western*limb(-137);
  const noaa=(1-east)*(1-north);
  return {eumet,noaa,gibs,west};
}
function cloudExtractPixel(source,index,p,lat,lon){
  if(source.id==='metop'){
    // AVHRR IR is thermal imagery at every local time, never true colour.
    const a=source.night||source.day;
    if(!a)return {alpha:0,tone:190};
    const lum=.2126*a[index]+.7152*a[index+1]+.0722*a[index+2];
    return {alpha:smoothstep(52,205,lum)**1.35*.78*a[index+3]/255,
      tone:Math.max(138,Math.min(255,142+113*smoothstep(18,235,lum)))};
  }
  const solarTime=source.day?source.dayTime:source.nightTime;
  const mix=cloudSolarMix(solarTime,lat,lon).dayMix;
  let dayAlpha=0,nightAlpha=0,dayTone=190,nightTone=190;
  if(source.day && mix>.001){
    const a=source.day,lum=.2126*a[index]+.7152*a[index+1]+.0722*a[index+2];
    const visual=visualCloudScore(a[index],a[index+1],a[index+2]);
    if(source.guide){
      const g=source.guide[p];
      dayAlpha=Math.max(smoothstep(.035,.80,g)*(.32+.68*smoothstep(38,220,lum)),visual*smoothstep(.015,.30,g)*.22);
    }else dayAlpha=visual**1.45*.86;
    dayAlpha*=a[index+3]/255;
    dayTone=Math.max(145,Math.min(255,150+105*smoothstep(28,235,lum)));
  }
  if(source.night && mix<.999){
    const a=source.night;
    const lum=['gibs','west'].includes(source.id)?cloudInfraredLuminance(a[index],a[index+1],a[index+2]):.2126*a[index]+.7152*a[index+1]+.0722*a[index+2];
    nightAlpha=source.guide?smoothstep(.055,.74,source.guide[p])*(.58+.42*smoothstep(16,225,lum)):smoothstep(52,205,lum)**1.35*.78;
    nightAlpha*=a[index+3]/255;
    nightTone=Math.max(138,Math.min(255,142+113*smoothstep(18,235,lum)));
  }
  const da=Math.min(.95,dayAlpha)*mix,na=Math.min(.95,nightAlpha)*(1-mix);
  return {alpha:da+na,tone:(dayTone*da+nightTone*na)/Math.max(.0001,da+na)};
}
function cloudProcessPixels(coords,sources,size){
  const padding=size/32,side=size+padding*2;
  for(const source of sources){
    if(source.mask){
      const alpha=new Float32Array(side*side);
      for(let p=0;p<alpha.length;p++)alpha[p]=source.mask[p*4+3]/255;
      source.guide=blurAlpha(alpha,side,side,Math.max(1,Math.round(6*size/256)));
    }
  }
  const out=new Uint8ClampedArray(size*size*4);
  const latitudes=Array.from({length:size},(_,y)=>cloudTileLocation(coords,0,(y+.5)*256/size).lat);
  const longitudes=Array.from({length:size},(_,x)=>cloudTileLocation(coords,(x+.5)*256/size,0).lon);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const weights=cloudSourceWeights(latitudes[y],longitudes[x]);
    const p=(y+padding)*side+x+padding,index=p*4;
    let alpha=0,tone=0;
    for(const source of sources){
      const weight=weights[source.id];if(!weight)continue;
      const pixel=cloudExtractPixel(source,index,p,latitudes[y],longitudes[x]);
      alpha+=pixel.alpha*weight;tone+=pixel.tone*pixel.alpha*weight;
    }
    const i=(y*size+x)*4;
    if(alpha<.014)continue;
    tone/=alpha;
    out[i]=Math.min(255,Math.round(tone+2));out[i+1]=Math.min(255,Math.round(tone+4));
    out[i+2]=Math.min(255,Math.round(tone+7));out[i+3]=Math.round(255*Math.min(.94,alpha));
  }
  return out;
}
