// Station shading estimates temperatures between official US, Atlantic and Western European stations, without a model
// download. Each station touches only pixels within 125 km; gaps stay clear.
(function(root){
  'use strict';
  const radiusKm=125;
  const measuredCountries=new Set(['US','GB','IE','FO','DE','NL','BE','CZ','SK','LU','FR','AD','ES','PT','AT','CH','IT','HU']);
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
  function stations(unix){
    return typeof officialStationsNearTime==='function'?officialStationsNearTime(unix,{crossBorder:true}).filter(s=>
      Number.isFinite(s.temp)&&Number.isFinite(s.time)&&
      Math.abs(s.time-unix)<=(s.country==='FR'?4*3600:(['ES','PT','IT'].includes(s.country)?2*3600:95*60))):[];
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
  async function raster(region,observations,unix,valid=()=>true,yieldFrame=()=>Promise.resolve()){
    const W=region.w,H=region.h,[south,west]=region.bounds[0],[north,east]=region.bounds[1];
    const northY=mercator(north),southY=mercator(south);
    const lats=Array.from({length:H},(_,y)=>Math.atan(Math.sinh(northY+y/(H-1)*(southY-northY)))/rad);
    const lons=Array.from({length:W},(_,x)=>west+x/(W-1)*(east-west));
    const weighted=new Float32Array(W*H),total=new Float32Array(W*H),nearest=new Float32Array(W*H).fill(Infinity);
    const terrain=globalThis.NorthernTerrain;
    const heights=terrain?new Float32Array(W*H).fill(NaN):null;
    if(heights)for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const h=terrain.elevation(lats[y],lons[x]);if(h!==null)heights[y*W+x]=h;
    }
    let touched=0;
    for(const s of observations){
      if(!valid())return null;
      if(!Number.isFinite(s.temp)||!Number.isFinite(s.lat)||!Number.isFinite(s.lon)||!Number.isFinite(s.time))continue;
      const age=Math.abs(unix-s.time),maxAge=s.country==='FR'?4*3600:(['ES','PT','IT'].includes(s.country)?2*3600:5700),ageWeight=age<=3600?1:Math.max(0,(maxAge-age)/(maxAge-3600));
      if(!ageWeight)continue;
      const terrainWeight=terrain?.influence(s.lat,s.lon,'temperature'),stationHeight=terrain?.elevation(s.lat,s.lon);
      let lon=s.lon;
      while(lon-(west+east)/2>180)lon-=360;
      while(lon-(west+east)/2< -180)lon+=360;
      const latPad=radiusKm/111,lonPad=radiusKm/(111*Math.max(.18,Math.cos(s.lat*rad)));
      if(s.lat+latPad<south||s.lat-latPad>north||lon+lonPad<west||lon-lonPad>east)continue;
      const x0=Math.max(0,Math.floor((lon-lonPad-west)/(east-west)*(W-1)));
      const x1=Math.min(W-1,Math.ceil((lon+lonPad-west)/(east-west)*(W-1)));
      const yAt=lat=>(northY-mercator(Math.max(-85,Math.min(85,lat))))/(northY-southY)*(H-1);
      const y0=Math.max(0,Math.floor(yAt(s.lat+latPad))),y1=Math.min(H-1,Math.ceil(yAt(s.lat-latPad)));
      // Local distance approximation is accurate over this short radius;
      // one cosine per row avoids millions of spherical calculations on phones.
      for(let y=y0;y<=y1;y++){
        const dy=(lats[y]-s.lat)*111.195,dxScale=111.195*Math.cos((lats[y]+s.lat)*rad/2);
        for(let x=x0;x<=x1;x++){
          const dx=(lons[x]-lon)*dxScale,km2=dy*dy+dx*dx;
          if(km2>=radiusKm*radiusKm)continue;
          const relief=terrainWeight?.(lats[y],lons[x])??1;
          if(relief<.005)continue;
          const f=km2/(radiusKm*radiusKm),weight=(1-f)**2*ageWeight*relief/Math.max(4,km2),i=y*W+x;
          const value=stationHeight!=null&&Number.isFinite(heights?.[i])?s.temp+Math.max(-12,Math.min(12,(stationHeight-heights[i])*.0065)):s.temp;
          weighted[i]+=value*weight;total[i]+=weight;nearest[i]=Math.min(nearest[i],km2/Math.max(.02,relief));
        }
      }
      if(++touched%16===0)await yieldFrame();
    }
    const values=new Float32Array(W*H).fill(NaN),alpha=new Uint8Array(W*H);
    for(let i=0;i<values.length;i++)if(total[i]>0){
      values[i]=weighted[i]/total[i];
      alpha[i]=Math.round(205*Math.min(1,(radiusKm-Math.sqrt(nearest[i]))/25));
    }
    return {values,alpha};
  }
  root.NorthernUSTemperature={regions,stations,raster,radiusKm,nearby};
})(typeof window!=='undefined'?window:globalThis);

