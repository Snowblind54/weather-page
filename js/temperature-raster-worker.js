/* Interpolation runs off the UI thread; static weights are reused across frames. */
self.NorthernTerrainAssetBase='../assets/';
importScripts('terrain-context.js?v=3','temperature-us.js?v=adriatic-1');
let current=0;
self.onmessage=async({data})=>{
 const {id,region,observations,unix}=data;current=id;
 try{
  await NorthernTerrain.ready();
  const result=await NorthernUSTemperature.rasterCore(region,observations,unix,()=>current===id,()=>new Promise(resolve=>setTimeout(resolve,0)));
  if(result)self.postMessage({id,result},[result.values.buffer,result.alpha.buffer]);
  else self.postMessage({id,result:null});
 }catch(error){self.postMessage({id,error:error.message});}
};
