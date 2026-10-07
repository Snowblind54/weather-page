// Keep cloud extraction complete north of the legacy MSG cloud-mask footprint.
// Also blend a polar-orbiting Metop source across high-latitude Scandinavia.
// In the European Meteosat daylight footprint, suppress the weak gray wash and
// keep only clearly cloud-like pixels. The northern Metop supplement is not changed.
(function(root){
  function installNordicCloudCoverage(){
    let changed=false;

    if(typeof cloudSourceWeights==='function' && !cloudSourceWeights._nordicPolarBlend){
      const baseWeights=cloudSourceWeights;
      function nordicSourceWeights(lat,lon){
        const weights=baseWeights(lat,lon);
        weights.metop=0;

        // In the worker there is no cloudProducts registry, while in the page
        // the source is installed asynchronously. Do not advertise Metop to the
        // page loader until its product definition exists.
        const metopReady=typeof cloudProducts==='undefined' || !!cloudProducts.metop;

        // Metop-C is used only where geostationary viewing becomes shallow.
        // Fade in gradually across northern Scandinavia / Nordic seas so there
        // is no visible latitude seam. Keep the normal Meteosat source beneath
        // the blend for continuity when both observations contain data.
        if(metopReady && lat>=64 && lat<=82 && lon>=-32 && lon<=42){
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

    // The old European daytime extraction leaves a low-alpha gray veil over
    // large areas because the soft cloud mask admits dim GeoColour pixels.
    // Tighten only the EUMETSAT daylight component south of the old 67.5°N mask
    // edge. Strong/bright cloud pixels survive; weak gray background fades out.
    // Night IR and the Metop northern source stay untouched.
    if(typeof cloudExtractPixel==='function' && !cloudExtractPixel._europeDayCleanup){
      const baseExtractPixel=cloudExtractPixel;
      function cleanEuropeanDayPixel(source,index,p,lat,lon){
        const pixel=baseExtractPixel(source,index,p,lat,lon);
        if(source.id!=='eumet' || lat>=67.5 || !source.day || pixel.alpha<=0)return pixel;

        const solarTime=source.dayTime ?? source.nightTime;
        const dayMix=cloudSolarMix(solarTime,lat,lon).dayMix;
        if(dayMix<=.001)return pixel;

        const a=source.day;
        const visual=visualCloudScore(a[index],a[index+1],a[index+2]);

        // Two independent signals keep real clouds:
        //  - visual whiteness/brightness from the GeoColour image
        //  - already-strong cloud alpha from the official mask/extractor
        // Weak values from both are the unwanted overall gray hue.
        const visualGate=smoothstep(.14,.58,visual);
        const strengthGate=smoothstep(.30,.62,pixel.alpha);
        const cloudGate=Math.max(visualGate,strengthGate);

        // Apply only to the daylight share so twilight/night infrared remains
        // continuous. The small floor avoids abruptly thinning cloud edges.
        const daylightKeep=.04+.96*cloudGate;
        pixel.alpha*=1-dayMix+dayMix*daylightKeep;

        if(dayMix>.5 && pixel.alpha<.055)pixel.alpha=0;
        return pixel;
      }
      cleanEuropeanDayPixel._europeDayCleanup=true;
      cloudExtractPixel=cleanEuropeanDayPixel;
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
