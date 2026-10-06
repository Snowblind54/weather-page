// Keep Meteosat cloud extraction complete north of the legacy MSG cloud-mask footprint.
// The MTG GeoColour/IR imagery reaches farther north than msg_fes:clm (67.5°N).
(function(root){
  function installNordicCloudCoverage(){
    if(typeof cloudProcessPixels!=='function' || cloudProcessPixels._nordicMaskFallback)return false;

    const baseProcessPixels=cloudProcessPixels;
    function processNordicCloudPixels(coords,sources,size){
      const northEdge=cloudTileLocation(coords,128,0).lat;
      if(northEdge<=67.5)return baseProcessPixels(coords,sources,size);

      const disabledMasks=[];
      for(const source of sources){
        if(source.id!=='eumet' || !source.mask)continue;
        disabledMasks.push([source,source.mask]);
        source.mask=null;
      }

      try{
        // Above the MSG mask footprint, use the same clean visual/IR extraction
        // instead of treating transparent off-footprint pixels as clear sky.
        return baseProcessPixels(coords,sources,size);
      }finally{
        for(const [source,mask] of disabledMasks)source.mask=mask;
      }
    }

    processNordicCloudPixels._nordicMaskFallback=true;
    cloudProcessPixels=processNordicCloudPixels;
    return true;
  }

  root.installNordicCloudCoverage=installNordicCloudCoverage;
})(typeof self!=='undefined'?self:globalThis);
