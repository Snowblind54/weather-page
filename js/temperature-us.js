// Station shading estimates temperatures between official US, Atlantic and Western European stations, without a model
// download. Each station touches only pixels within 125 km; gaps stay clear.
(function(root){
  'use strict';
  const radiusKm=125;
  const measuredCountries=new Set(['US','GB','IE','FO','DE','NL','BE','CZ','SK','LU','FR','AD','ES','PT','AT','CH','IT','HU','HR','SI','UA','RO','MD','BY','BA','RS','BG','MK','AL','XK','ME','GR','MT','CY','TR']);
  const regions=[
    {id:'usa',bounds:[[24,-125],[50,-66]],w:450,h:260,stationBased:true},
    {id:'usa-alaska',bounds:[[50,-180],[72,-129]],w:350,h:240,stationBased:true},
    {id:'usa-hawaii',bounds:[[18,-161],[23,-154]],w:150,h:130,stationBased:true},
    {id:'usa-aleutians',bounds:[[50,170],[55,180]],w:90,h:120,stationBased:true},
    {id:'british-isles',countries:['GB','IE'],bounds:[[49,-11],[61,3]],w:240,h:310,stationBased:true},
    {id:'faroes',countries:['FO'],bounds:[[61.3,-7.8],[62.5,-6.1]],w:130,h:170,stationBased:true},
    {id:'western-europe',countries:['DE','NL','BE','LU'],bounds:[[47,2.4],[55.2,15.6]],w:340,h:330,stationBased:true},
    {id:'france',countries:['FR'],bounds:[[41,-5.5],[51.5,10]],w:360,h:350,stationBased:true},
    {id:'italy',countries:['IT'],bounds:[[35.3,6.3],[47.2,19]],w:340,h:400,stationBased:true},
    {id:'ukraine',countries:['UA'],bounds:[[44,22],[52.5,40.5]],w:380,h:280,stationBased:true},
    {id:'bosnia-herzegovina',countries:['BA'],bounds:[[42.5,15.6],[45.4,19.7]],w:230,h:220,stationBased:true},
    {id:'malta',countries:['MT'],bounds:[[35.75,14.15],[36.15,14.65]],w:130,h:130,stationBased:true},
    {id:'cyprus',countries:['CY'],bounds:[[34.5,32.1],[35.8,34.7]],w:220,h:160,stationBased:true},
    {id:'turkey',countries:['TR'],bounds:[[35.8,25.6],[42.2,45]],w:480,h:260,stationBased:true},
    {id:'montenegro',countries:['ME'],bounds:[[41.8,18.4],[43.6,20.5]],w:190,h:190,stationBased:true},
    {id:'greece',countries:['GR'],bounds:[[34.7,19.3],[41.8,29.8]],w:340,h:290,stationBased:true},
    {id:'bulgaria',countries:['BG'],bounds:[[41.2,22.2],[44.3,28.8]],w:300,h:220,stationBased:true},
    {id:'north-macedonia',countries:['MK'],bounds:[[40.8,20.4],[42.4,23.1]],w:220,h:170,stationBased:true},
    {id:'albania',countries:['AL'],bounds:[[39.6,19.2],[42.7,21.1]],w:160,h:260,stationBased:true},
    {id:'kosovo',countries:['XK'],bounds:[[41.8,20],[43.3,21.9]],w:180,h:180,stationBased:true},
    {id:'serbia',countries:['RS'],bounds:[[42.2,18.8],[46.3,23.1]],w:230,h:280,stationBased:true},
    {id:'moldova',countries:['MD'],bounds:[[45.4,26.5],[48.6,30.3]],w:200,h:240,stationBased:true},
    {id:'belarus',countries:['BY'],bounds:[[51.2,23],[56.3,33]],w:300,h:240,stationBased:true},
    {id:'romania',countries:['RO'],bounds:[[43.5,20],[48.5,30]],w:300,h:240,stationBased:true},
    {id:'adriatic',countries:['HR','SI'],bounds:[[42.2,13.1],[46.95,19.5]],w:260,h:280,stationBased:true},
    {id:'hungary',countries:['HU'],bounds:[[45.7,16],[48.7,23]],w:300,h:200,stationBased:true},
    {id:'austria',countries:['AT'],bounds:[[46.3,9.4],[49.1,17.2]],w:340,h:200,stationBased:true},
    {id:'switzerland',countries:['CH'],bounds:[[45.7,5.9],[47.9,10.6]],w:280,h:200,stationBased:true},
    {id:'andorra',countries:['AD'],bounds:[[42.4,1.4],[42.7,1.8]],w:200,h:200,stationBased:true},
    {id:'iberia',countries:['ES','PT'],bounds:[[35.5,-10],[44.5,5]],w:380,h:290,stationBased:true},
    {id:'spain-canaries',countries:['ES'],bounds:[[27,-19],[30,-13]],w:240,h:160,stationBased:true},
    {id:'portugal-azores',countries:['PT'],bounds:[[36,-32],[40,-24.5]],w:240,h:170,stationBased:true},
    {id:'portugal-madeira',countries:['PT'],bounds:[[30,-18],[34,-15]],w:160,h:190,stationBased:true},
    {id:'central-europe',countries:['CZ','SK'],bounds:[[47.6,12],[51.1,22.7]],w:350,h:200,stationBased:true}
  ];
  const rad=Math.PI/180;
  const mercator=lat=>Math.log(Math.tan(Math.PI/4+lat*rad/2));
  const observationMaxAge=s=>['ME','GR'].includes(s.country)&&String(s.code||'').startsWith('SYNOP-')?7*3600:['FR','UA','BY','AL'].includes(s.country)?4*3600:['ES','PT','IT'].includes(s.country)?2*3600:95*60;
  function stations(unix){
    return typeof officialStationsNearTime==='function'?officialStationsNearTime(unix,{crossBorder:true}).filter(s=>
      Number.isFinite(s.temp)&&Number.isFinite(s.time)&&
      Math.abs(s.time-unix)<=observationMaxAge(s)):[];
  }
  function nearby(region,observations){
    const [[south,west],[north,east]]=region.bounds,pad=radiusKm/111.195;
    return observations.filter(s=>{
      const lonPad=pad/Math.max(.18,Math.cos(s.lat*rad));let lon=s.lon;
      while(lon-(west+east)/2>180)lon-=360;
      while(lon-(west+east)/2< -180)lon+=360;
      return s.lat+pad>=south&&s.lat-pad<=north&&lon+lonPad>=west&&lon-lonPad<=east;
    });
  }
  const geometryCache=new Map();
  const maxNeighbours=8;
  function positionKey(s){return (s.country||'')+'/'+(s.code||'')+'/'+s.lat+'/'+s.lon;}
  async function geometry(region,observations,valid,yieldFrame){
    const W=Math.min(region.w,Math.max(3,Math.ceil(region.w/3))),H=Math.min(region.h,Math.max(3,Math.ceil(region.h/3)));
    const key=[region.bounds.flat().join(','),W,H,globalThis.NorthernTerrain?.available||false,observations.map(positionKey).join(';')].join('|');
    if(geometryCache.has(key)){
      const value=geometryCache.get(key);geometryCache.delete(key);geometryCache.set(key,value);return value;
    }
    const [south,west]=region.bounds[0],[north,east]=region.bounds[1],northY=mercator(north),southY=mercator(south);
    const lats=Array.from({length:H},(_,y)=>Math.atan(Math.sinh(northY+y/(H-1)*(southY-northY)))/rad);
    const lons=Array.from({length:W},(_,x)=>west+x/(W-1)*(east-west));
    const terrain=globalThis.NorthernTerrain,buckets=new Map();
    const sources=observations.map((s,index)=>{
      let lon=s.lon;while(lon-(west+east)/2>180)lon-=360;while(lon-(west+east)/2< -180)lon+=360;
      const item={...s,lon,index,height:terrain?.elevation(s.lat,lon),relief:terrain?.influence(s.lat,lon,'temperature')};
      const k=Math.floor(s.lat)+','+Math.floor(lon);if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(item);return item;
    });
    const size=W*H*maxNeighbours,indices=new Int32Array(size).fill(-1),weights=new Float32Array(size),offsets=new Float32Array(size),alpha=new Uint8Array(W*H);
    for(let y=0;y<H;y++){
      if(!valid())return null;
      const lat=lats[y],cos=Math.max(.18,Math.cos(lat*rad)),padLat=radiusKm/111.195,padLon=padLat/cos;
      for(let x=0;x<W;x++){
        const lon=lons[x],candidates=[];
        for(let by=Math.floor(lat-padLat);by<=Math.floor(lat+padLat);by++)for(let bx=Math.floor(lon-padLon);bx<=Math.floor(lon+padLon);bx++){
          for(const s of buckets.get(by+','+bx)||[]){
            const dy=(lat-s.lat)*111.195,dx=(lon-s.lon)*111.195*cos,d2=dy*dy+dx*dx;
            if(d2>=radiusKm*radiusKm)continue;
            let i=0;while(i<candidates.length&&candidates[i].d2<d2)i++;
            candidates.splice(i,0,{s,d2});if(candidates.length>16)candidates.pop();
          }
        }
        const targetHeight=terrain?.elevation(lat,lon),usable=[];
        for(const {s,d2} of candidates){
          const relief=s.relief?.(lat,lon)??1;if(relief<.005)continue;
          const f=d2/(radiusKm*radiusKm),weight=(1-f)**2*relief/Math.max(4,d2);
          const offset=s.height!=null&&targetHeight!=null?Math.max(-12,Math.min(12,(s.height-targetHeight)*.0065)):0;
          usable.push({index:s.index,weight,offset,effective:d2/Math.max(.02,relief)});
        }
        usable.sort((a,b)=>b.weight-a.weight);const cell=y*W+x,start=cell*maxNeighbours;
        for(let k=0;k<Math.min(maxNeighbours,usable.length);k++){
          const p=usable[k];indices[start+k]=p.index;weights[start+k]=p.weight;offsets[start+k]=p.offset;
        }
        if(usable.length)alpha[cell]=Math.max(0,Math.round(205*Math.min(1,(radiusKm-Math.sqrt(Math.min(...usable.map(p=>p.effective))))/25)));
      }
      if(y%4===3)await yieldFrame();
    }
    if(!valid())return null;
    const result={W,H,indices,weights,offsets,alpha};geometryCache.set(key,result);
    while(geometryCache.size>8)geometryCache.delete(geometryCache.keys().next().value);
    return result;
  }
  async function rasterCore(region,observations,unix,valid=()=>true,yieldFrame=()=>Promise.resolve()){
    observations=nearby(region,observations).filter(s=>Number.isFinite(s.temp)&&Number.isFinite(s.lat)&&Number.isFinite(s.lon)&&Number.isFinite(s.time)).sort((a,b)=>positionKey(a).localeCompare(positionKey(b)));
    const mesh=await geometry(region,observations,valid,yieldFrame);if(!mesh||!valid())return null;
    const ages=observations.map(s=>{
      const age=Math.abs(unix-s.time),maxAge=observationMaxAge(s);
      return age<=3600?1:Math.max(0,(maxAge-age)/(maxAge-3600));
    });
    const coarse=new Float32Array(mesh.W*mesh.H).fill(NaN),opacity=new Uint8Array(coarse.length);
    for(let i=0;i<coarse.length;i++){
      let sum=0,total=0;
      for(let k=0;k<maxNeighbours;k++){
        const p=i*maxNeighbours+k,index=mesh.indices[p];if(index<0)break;
        const weight=mesh.weights[p]*ages[index];if(!weight)continue;
        sum+=(observations[index].temp+mesh.offsets[p])*weight;total+=weight;
      }
      if(total>0){coarse[i]=sum/total;opacity[i]=mesh.alpha[i];}
    }
    const W=region.w,H=region.h,values=new Float32Array(W*H).fill(NaN),alpha=new Uint8Array(W*H);
    for(let y=0;y<H;y++){
      if(!valid())return null;
      const gy=y/(H-1)*(mesh.H-1),y0=Math.min(mesh.H-2,Math.floor(gy)),fy=gy-y0;
      for(let x=0;x<W;x++){
        const gx=x/(W-1)*(mesh.W-1),x0=Math.min(mesh.W-2,Math.floor(gx)),fx=gx-x0;
        const cells=[y0*mesh.W+x0,y0*mesh.W+x0+1,(y0+1)*mesh.W+x0,(y0+1)*mesh.W+x0+1],mix=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
        let sum=0,total=0,a=0;
        for(let k=0;k<4;k++)if(Number.isFinite(coarse[cells[k]])){const w=mix[k]*opacity[cells[k]];sum+=coarse[cells[k]]*w;total+=w;a+=opacity[cells[k]]*mix[k];}
        const i=y*W+x;if(total>0){values[i]=sum/total;alpha[i]=Math.round(a);}
      }
      if(y%24===23)await yieldFrame();
    }
    return {values,alpha};
  }
  let worker=null,workerFailed=false,requestId=0;const pending=new Map();
  function getWorker(){
    if(worker||workerFailed||typeof Worker!=='function'||typeof document==='undefined')return worker;
    try{
      worker=new Worker('js/temperature-raster-worker.js?v=mediterranean-1');
      worker.onmessage=({data})=>{const task=pending.get(data.id);if(task){pending.delete(data.id);if(data.error)task.reject(new Error(data.error));else task.resolve(data.result);}};
      worker.onerror=()=>{workerFailed=true;worker?.terminate();worker=null;for(const task of pending.values())task.reject(new Error('Temperature worker unavailable'));pending.clear();};
    }catch(error){workerFailed=true;worker=null;}
    return worker;
  }
  async function raster(region,observations,unix,valid=()=>true,yieldFrame=()=>Promise.resolve()){
    if(!valid())return null;
    const background=getWorker();
    if(background){
      try{
        const id=++requestId,result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});background.postMessage({id,region,observations,unix});});
        return valid()?result:null;
      }catch(error){workerFailed=true;worker?.terminate();worker=null;}
    }
    return rasterCore(region,observations,unix,valid,yieldFrame);
  }
  root.NorthernUSTemperature={regions,stations,raster,radiusKm,nearby,rasterCore};
})(typeof window!=='undefined'?window:globalThis);

