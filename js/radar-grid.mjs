// Shared numeric radar rendering. No-data always remains transparent.
export function radarRate(value,grid){
  if(!Number.isFinite(value)||value===grid.nodata||value===grid.undetect)return NaN;
  const measured=value*(grid.gain??1)+(grid.offset??0);
  return grid.quantity==='RATE'?measured:Math.pow(Math.pow(10,measured/10)/(grid.zrA||200),1/(grid.zrB||1.6));
}
export function radarColour(rate){
  if(!Number.isFinite(rate)||rate<.05)return [0,0,0,0];
  const stops=[[.1,156,221,255],[.3,54,170,255],[.5,0,216,154],[1,232,247,0],[2,255,196,0],[4,255,123,0],[8,255,42,42],[16,211,0,215],[50,150,0,190],[Infinity,90,0,145]];
  const s=stops.find(s=>rate<s[0]);return [s[1],s[2],s[3],210];
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

export function radarProjection(wkt){
  if(!wkt?.startsWith('PROJCRS['))return wkt;
  if(!wkt.includes('Lambert Conic Conformal (2SP)')||!wkt.includes('WGS 84'))throw new Error('Unsupported STAC radar projection');
  const names=['Latitude of false origin','Longitude of false origin','Latitude of 1st standard parallel','Latitude of 2nd standard parallel','Easting at false origin','Northing at false origin'];
  const values=names.map(name=>Number(wkt.match(new RegExp('PARAMETER\\["'+name+'",([+-]?[0-9.eE]+)'))?.[1]));
  if(!values.every(Number.isFinite))throw new Error('Incomplete STAC radar projection');
  return `+proj=lcc +lat_0=${values[0]} +lon_0=${values[1]} +lat_1=${values[2]} +lat_2=${values[3]} +x_0=${values[4]} +y_0=${values[5]} +datum=WGS84 +units=m`;
}
