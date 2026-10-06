// Keep cloud extraction complete north of the legacy MSG cloud-mask footprint.
// Also blend a polar-orbiting Metop source across high-latitude Scandinavia.
(function(root){
  function installNordicCloudCoverage(){
    let changed=false;

    if(typeof cloudSourceWeights==='function' && !cloudSourceWeights._nordicPolarBlend){
      const baseWeights=cloudSourceWeights;
      function nordicSourceWeights(lat,lon){
        const weights=baseWeights(lat,lon);
        weights.metop=0;

        // Metop-C is used only where geostationary viewing becomes shallow.
        // Fade in gradually across northern Scandinavia / Nordic seas so there
        // is no visible latitude seam. Keep the normal Meteosat source beneath
        // the blend for continuity when both observations contain data.
        if(lat>=64 && lat<=82 && lon>=-32 && lon<=42){
          const north=smoothstep(64.5,69,lat);
          const west=smoothstep(-32,-24,lon);
          const east=1-smoothstep(36,42,lon);
          const polar=Math.max(0,Math.min(1,north*west*east));
          weights.metop=polar;
          if(Number.isFinite(weights.eumet))weights.eumet*=1-0.82*polar;
        }
        return weights;
      }
      nordicSourceWeights._nordicPolarBlend=true;
      cloudSourceWeights=nordicSourceWeights;
      changed=true;
    }

    if(typeof cloudProcessPixels==='function' && !cloudProcessPixels._nordicMaskFallback){
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
          // Above the MSG mask footprint, use the same visual/IR extraction
          // instead of interpreting transparent off-footprint mask pixels as
          // clear sky. The Metop polar source then fills the true MTG limb gap.
          return baseProcessPixels(coords,sources,size);
        }finally{
          for(const [source,mask] of disabledMasks)source.mask=mask;
        }
      }

      processNordicCloudPixels._nordicMaskFallback=true;
      cloudProcessPixels=processNordicCloudPixels;
      changed=true;
    }

    return changed;
  }

  root.installNordicCloudCoverage=installNordicCloudCoverage;
})(typeof self!=='undefined'?self:globalThis);
