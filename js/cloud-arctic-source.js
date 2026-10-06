// High-latitude satellite supplement for Northern Weather.
// Meteosat remains primary; Metop-C AVHRR IR10.8 fills the shallow-view Arctic limb.
(function(root){
  function installArcticCloudSource(){
    if(typeof cloudProducts==='undefined' || typeof cloudLoadSource!=='function')return false;
    if(cloudProducts.metop?.northernWeather)return false;

    cloudProducts.metop={
      endpoint:CLOUD_EUMET,
      day:'eps:m03_ir108',
      night:'eps:m03_ir108',
      cadence:600,
      northernWeather:true
    };

    const baseLoadSource=cloudLoadSource;
    cloudLoadSource=async function(id,coords,time){
      if(id!=='metop')return baseLoadSource(id,coords,time);

      const product=cloudProducts.metop;
      const observation=cloudAvailableTime(product,product.day,time);
      const pixels=await cloudImagePixels(
        cloudMapUrl(product,product.day,observation,coords),
        cloudTileSide(coords)
      );

      // The same IR10.8 observation works in daylight and darkness. Keep two
      // arrays because the worker transfers their buffers independently.
      return {
        id,
        day:pixels,
        night:new Uint8ClampedArray(pixels),
        mask:null,
        dayTime:observation,
        nightTime:observation
      };
    };

    if(typeof cloudTimeDescription==='function' && !cloudTimeDescription._metopLabel){
      const baseTimeDescription=cloudTimeDescription;
      const wrapped=function(results){
        return baseTimeDescription(results).replace(/undefined /g,'Metop-C polar ');
      };
      wrapped._metopLabel=true;
      cloudTimeDescription=wrapped;
    }

    const sourceText=document.querySelector?.('#cloudSection-sources p');
    if(sourceText && !/Metop-C/.test(sourceText.textContent)){
      sourceText.textContent=sourceText.textContent.replace(
        'EUMETSAT Meteosat GeoColour / FCI IR10.5 and cloud mask;',
        'EUMETSAT Meteosat GeoColour / FCI IR10.5 and cloud mask; Metop-C AVHRR IR10.8 for high-latitude Nordic coverage;'
      );
    }

    return true;
  }

  root.installArcticCloudSource=installArcticCloudSource;
})(typeof window!=='undefined'?window:globalThis);
