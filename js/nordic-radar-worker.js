// Decoding, reprojection and colour conversion stay off the map's UI thread.
import {radarRate,radarColour,mercatorY,latitudeAtY,polarIndex,cartesianIndex,makeRayLookup,makeRaySampling,polarInterpolation,polarReflectivity,radarProjection} from './radar-grid.mjs?v=8.80';
let libraries=null,hdf=null,hdfFs=null,sequence=Promise.resolve();
const mappings=new Map();
function scalar(value){return Array.isArray(value)||ArrayBuffer.isView(value)?value[0]:value;}
function attributes(group){return Object.fromEntries(Object.entries(group?.attrs||{}).map(([key,attr])=>[key,attr.value]));}
async function dependencies(){
  if(!libraries)libraries=Promise.all([
    import('https://cdn.jsdelivr.net/npm/proj4@2.15.0/+esm'),
    import('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm')
  ]).then(([projection,tiff])=>({proj4:projection.default,tiff}));
  return libraries;
}
async function decodeHdf(buffer,proj4){
  if(!hdf){const module=await import('https://cdn.jsdelivr.net/npm/h5wasm@0.10.1/dist/esm/hdf5_hl.js');hdf=module.default;hdfFs=(await hdf.ready).FS;}
  const filename='/national-radar.h5';try{hdfFs.unlink(filename);}catch(_){}
  hdfFs.writeFile(filename,new Uint8Array(buffer));const file=new hdf.File(filename,'r');
  try{
    const root=attributes(file.get('what')),where=attributes(file.get('where'));
    const polar=String(scalar(root.object))==='PVOL';
    let dataset='dataset1';
    if(polar){
      const names=file.keys().filter(n=>/^dataset\d+$/.test(n));
      dataset=names.reduce((best,n)=>Number(scalar(attributes(file.get(n+'/where')).elangle))<Number(scalar(attributes(file.get(best+'/where')).elangle))?n:best,names[0]);
    }
    const group=file.get(dataset),ds=group.get('data1/data');
    const what={...root,...attributes(group.get('what')),...attributes(group.get('data1')),...attributes(group.get('data1/what'))};
    const quantity=String(scalar(what.quantity||what.product));
    if(!['DBZH','DBZ','RATE'].includes(quantity))throw new Error('Unsupported radar quantity '+quantity);
    const values=ds.value.slice(),[height,width]=ds.shape;
    const how=attributes(file.get('how'));
    const grid={values,width,height,quantity,gain:Number(scalar(what.gain??1)),offset:Number(scalar(what.offset??0)),nodata:Number(scalar(what.nodata)),undetect:Number(scalar(what.undetect)),zrA:Number(scalar(how['zr-a']||200)),zrB:Number(scalar(how['zr-b']||1.6)),polar};
    if(polar){
      const w=attributes(group.get('where')),h=attributes(group.get('how'));
      const lat=Number(scalar(where.lat)),lon=Number(scalar(where.lon));
      Object.assign(grid,{projection:`+proj=aeqd +lat_0=${lat} +lon_0=${lon} +datum=WGS84 +units=m +x_0=0 +y_0=0`,rscale:Number(scalar(w.rscale)),rstart:Number(scalar(w.rstart))*1000,elevation:Number(scalar(w.elangle))});
      if(h.startazA?.length===height&&h.stopazA?.length===height){
        grid.rayLookup=makeRayLookup(h.startazA,h.stopazA);grid.raySampling=makeRaySampling(h.startazA,h.stopazA);
        grid.reflectivity=Float32Array.from({length:256},(_,value)=>Math.pow(10,(value*grid.gain+grid.offset)/10));
      }
      else if(Number(scalar(w.a1gate)))throw new Error('Polar scan lacks azimuth coordinates');
      const range=width*grid.rscale;Object.assign(grid,{left:-range,top:range,dx:range*2/width,dy:range*2/height});
    }else{
      const projection=String(scalar(where.projdef));
      const origin=proj4('EPSG:4326',projection,[Number(scalar(where.UL_lon)),Number(scalar(where.UL_lat))]);
      Object.assign(grid,{projection,left:origin[0],top:origin[1],dx:Number(scalar(where.xscale)),dy:Number(scalar(where.yscale))});
    }
    if(![grid.left,grid.top,grid.dx,grid.dy,grid.gain,grid.offset].every(Number.isFinite)||grid.dx<=0||grid.dy<=0)throw new Error('Invalid radar grid metadata');
    return grid;
  }finally{file.close();hdfFs.unlink(filename);}
}
async function decodeTiff(buffer,descriptor,tiff){
  const file=await tiff.fromArrayBuffer(buffer),image=await file.getImage();
  const values=(await image.readRasters({samples:[0]}))[0],box=image.getBoundingBox(),keys=image.getGeoKeys();
  const projection=radarProjection(descriptor.projection)||(keys.ProjectedCSTypeGeoKey===3067?'+proj=utm +zone=35 +ellps=GRS80 +units=m +no_defs':keys.ProjectedCSTypeGeoKey===3857?'EPSG:3857':null);
  if(!projection)throw new Error('Unsupported radar GeoTIFF projection');
  return {values,width:image.getWidth(),height:image.getHeight(),left:box[0],top:box[3],dx:(box[2]-box[0])/image.getWidth(),dy:(box[3]-box[1])/image.getHeight(),projection,quantity:descriptor.quantity,gain:descriptor.gain??1,offset:descriptor.offset??0,nodata:descriptor.nodata??Number(image.getGDALNoData()),undetect:descriptor.undetect};
}
function mappingFor(grid,edge,proj4){
  const key=JSON.stringify([grid.width,grid.height,grid.projection,grid.left,grid.top,grid.dx,grid.dy,grid.polar,edge,grid.rstart,grid.rscale,grid.elevation,grid.rayLookup&&Array.from(grid.rayLookup),grid.raySampling&&Array.from(grid.raySampling.fraction)]);
  if(mappings.has(key))return mappings.get(key);
  const inverse=proj4(grid.projection,'EPSG:4326'),forward=proj4('EPSG:4326',grid.projection);
  let west=180,east=-180,south=85,north=-85;
  for(let t=0;t<=32;t++)for(const [x,y] of [[grid.left+grid.dx*grid.width*t/32,grid.top],[grid.left+grid.dx*grid.width*t/32,grid.top-grid.dy*grid.height],[grid.left,grid.top-grid.dy*grid.height*t/32],[grid.left+grid.dx*grid.width,grid.top-grid.dy*grid.height*t/32]]){
    const [lon,lat]=inverse.forward([x,y]);west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);
  }
  south=Math.max(-80,south);north=Math.min(80,north);
  if(![west,east,south,north].every(Number.isFinite)||east<=west||north<=south)throw new Error('Invalid radar geographic extent');
  const top=mercatorY(north),bottom=mercatorY(south),aspect=((east-west)*Math.PI/180)/(top-bottom);
  const width=Math.round(aspect>1?edge:edge*aspect),height=Math.round(aspect>1?edge/aspect:edge);
  const cols=32,rows=32,cells=new Uint8Array(cols*rows);
  const indices=new Int32Array(width*height),weights=grid.raySampling?new Uint16Array(width*height):null;
  for(let row=0;row<height;row++){
    const lat=latitudeAtY(top-(row+.5)/height*(top-bottom));
    for(let col=0;col<width;col++){
      const [x,y]=forward.forward([west+(col+.5)/width*(east-west),lat]);
      const i=row*width+col;
      if(weights){const sample=polarInterpolation(x,y,grid);indices[i]=sample?.index??-1;weights[i]=sample?.weights??0;}
      else indices[i]=grid.polar?polarIndex(x,y,grid):cartesianIndex(x,y,grid);
      if(indices[i]>=0)cells[Math.min(rows-1,Math.floor(row/height*rows))*cols+Math.min(cols-1,Math.floor(col/width*cols))]=1;
    }
  }
  const bounds=[[south,west],[north,east]];
  const result={indices,weights,width,height,bounds,coverage:{bounds,cols,rows,cells:Array.from(cells)}};mappings.set(key,result);
  while(mappings.size>6||([...mappings.values()].reduce((n,m)=>n+m.indices.byteLength+(m.weights?.byteLength||0),0)>64*1024*1024&&mappings.size>1))mappings.delete(mappings.keys().next().value);
  return result;
}
async function render(message){
  const {proj4,tiff}=await dependencies();
  const grid=message.descriptor.format==='h5'?await decodeHdf(message.buffer,proj4):await decodeTiff(message.buffer,message.descriptor,tiff);
  const mapping=mappingFor(grid,message.edge,proj4),pixels=new Uint8ClampedArray(mapping.indices.length*4);
  for(let i=0;i<mapping.indices.length;i++){
    const index=mapping.indices[i];if(index<0)continue;
    const rate=mapping.weights?polarReflectivity(index,mapping.weights[i],grid):radarRate(grid.values[index],grid);
    pixels.set(radarColour(rate),i*4);
  }
  const canvas=new OffscreenCanvas(mapping.width,mapping.height);canvas.getContext('2d').putImageData(new ImageData(pixels,mapping.width,mapping.height),0,0);
  return {blob:await canvas.convertToBlob({type:'image/png'}),bounds:mapping.bounds,coverage:mapping.coverage,pixels:mapping.indices.length};
}
self.onmessage=event=>{
  const message=event.data;
  if(message.warmup){dependencies().catch(()=>{});return;}
  sequence=sequence.then(async()=>{
    try{self.postMessage({id:message.id,...await render(message)});}
    catch(error){self.postMessage({id:message.id,error:error?.message||String(error)});}
  });
};

