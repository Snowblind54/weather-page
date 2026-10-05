// Shared numeric radar rendering. No-data always remains transparent.
export function radarRate(value,grid){
  if(!Number.isFinite(value)||value===grid.nodata||value===grid.undetect)return NaN;
  const measured=value*(grid.gain??1)+(grid.offset??0);
  return grid.quantity==='RATE'?measured:Math.pow(Math.pow(10,measured/10)/(grid.zrA||200),1/(grid.zrB||1.6));
}
const radarColourStops=[.1,.3,.5,1,2,4,8,16,50,Infinity];
const radarColours=[[156,221,255,210],[54,170,255,210],[0,216,154,210],[232,247,0,210],[255,196,0,210],[255,123,0,210],[255,42,42,210],[211,0,215,210],[150,0,190,210],[255,79,195,220]],radarTransparent=[0,0,0,0];
export function radarColour(rate){
  if(!Number.isFinite(rate)||rate<.05)return radarTransparent;
  for(let i=0;i<radarColourStops.length;i++)if(rate<radarColourStops[i])return radarColours[i];
  return radarTransparent;
}
export function mercatorY(lat){return Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));}
export function latitudeAtY(y){return (2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;}
export function polarIndex(east,north,grid){
  const slant=Math.hypot(east,north)/Math.cos((grid.elevation||0)*Math.PI/180);
  const col=Math.floor((slant-grid.rstart)/grid.rscale);
  if(col<0||col>=grid.width)return -1;
  const az=(Math.atan2(east,north)*180/Math.PI+360)%360;
  const row=grid.rayLookup?grid.rayLookup[Math.floor(az*10)%3600]:Math.floor(az/360*grid.height);
  return row<0?-1:row*grid.width+col;
}
export function cartesianIndex(x,y,grid){
  const col=Math.floor((x-grid.left)/grid.dx),row=Math.floor((grid.top-y)/grid.dy);
  return col<0||row<0||col>=grid.width||row>=grid.height?-1:row*grid.width+col;
}
export function makeRayLookup(starts,ends){
  const out=new Int32Array(3600);out.fill(-1);
  for(let ray=0;ray<starts.length;ray++){
    const start=(starts[ray]%360+360)%360;
    const span=(ends[ray]-starts[ray]+360)%360;
    for(let t=Math.floor(start*10);t<Math.ceil((start+span)*10);t++)out[(t+3600)%3600]=ray;
  }
  return out;
}

// Interpolate linear reflectivity Z between measured ray/range centres. Undetect
// is known zero echo; nodata is unknown and must never become invented rain.
export function makeRaySampling(starts,ends){
  const rays=Array.from(starts,(start,row)=>({row,angle:((start+((ends[row]-start+360)%360)/2)%360+360)%360,span:(ends[row]-start+360)%360})).sort((a,b)=>a.angle-b.angle);
  const lower=new Int16Array(3600),fraction=new Float32Array(3600),step=new Float32Array(3600),next=new Int16Array(rays.length);
  lower.fill(-1);
  for(let i=0;i<rays.length;i++){
    const a=rays[i],b=rays[(i+1)%rays.length],end=b.angle+(i===rays.length-1?360:0),span=end-a.angle;next[a.row]=b.row;
    if(span<=0||span>2*Math.max(a.span,b.span))continue;
    for(let t=Math.ceil(a.angle*10);t<Math.ceil(end*10);t++){
      const bin=t%3600;lower[bin]=a.row;fraction[bin]=(t/10-a.angle)/span;step[bin]=1/span;
    }
  }
  return {lower,fraction,step,next};
}
export function polarInterpolation(east,north,grid){
  const range=(Math.hypot(east,north)/Math.cos((grid.elevation||0)*Math.PI/180)-grid.rstart)/grid.rscale;
  if(range<0||range>=grid.width)return null;
  const az=(Math.atan2(east,north)*180/Math.PI+360)%360,bin=Math.floor(az*10)%3600,s=grid.raySampling,row=s.lower[bin];
  if(row<0||grid.rayLookup?.[bin]<0)return null;
  const centred=Math.max(0,Math.min(grid.width-1,range-.5)),col=Math.floor(centred);
  const angular=Math.min(1,Math.max(0,s.fraction[bin]+(az-bin/10)*s.step[bin]));
  return {index:row*grid.width+col,weights:(Math.round(angular*255)<<8)|Math.round((centred-col)*255)};
}
export function polarReflectivity(index,packed,grid){
  const row=Math.floor(index/grid.width),col=index%grid.width,next=grid.raySampling.next[row],right=Math.min(col+1,grid.width-1);
  const a=(packed>>>8)/255,r=(packed&255)/255;
  const z=weightedEcho(grid.values[index],(1-a)*(1-r),grid)+weightedEcho(grid.values[row*grid.width+right],(1-a)*r,grid)+weightedEcho(grid.values[next*grid.width+col],a*(1-r),grid)+weightedEcho(grid.values[next*grid.width+right],a*r,grid);
  return Math.pow(z/(grid.zrA||200),1/(grid.zrB||1.6));
}
function weightedEcho(value,weight,grid){
  if(weight===0||value===grid.undetect)return 0;
  if(!Number.isFinite(value)||value===grid.nodata)return NaN;
  return weight*grid.reflectivity[value];
}

export function radarProjection(wkt){
  if(!wkt?.startsWith('PROJCRS['))return wkt;
  if(!wkt.includes('Lambert Conic Conformal (2SP)')||!wkt.includes('WGS 84'))throw new Error('Unsupported STAC radar projection');
  const names=['Latitude of false origin','Longitude of false origin','Latitude of 1st standard parallel','Latitude of 2nd standard parallel','Easting at false origin','Northing at false origin'];
  const values=names.map(name=>Number(wkt.match(new RegExp('PARAMETER\\["'+name+'",([+-]?[0-9.eE]+)'))?.[1]));
  if(!values.every(Number.isFinite))throw new Error('Incomplete STAC radar projection');
  return `+proj=lcc +lat_0=${values[0]} +lon_0=${values[1]} +lat_1=${values[2]} +lat_2=${values[3]} +x_0=${values[4]} +y_0=${values[5]} +datum=WGS84 +units=m`;
}
