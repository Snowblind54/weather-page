// Keep cloud extraction away from map interaction and animation on the main thread.
importScripts('cloud-pixels.js?v=8.19');
self.onmessage=({data})=>{
  try{
    const pixels=cloudProcessPixels(data.coords,data.sources,data.size);
    self.postMessage({id:data.id,pixels},[pixels.buffer]);
  }catch(error){self.postMessage({id:data.id,error:error.message});}
};
