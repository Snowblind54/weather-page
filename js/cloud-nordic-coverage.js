// Keep cloud extraction complete north of the legacy MSG cloud-mask footprint.
// Also extend the shared GOES-East/West blend across the full US latitude range.
(function(root){
  function installNordicCloudCoverage(){
    let changed=false;

    if(typeof cloudSourceWeights==='function' && !cloudSourceWeights._nordicPolarBlend){
      const baseWeights=cloudSourceWeights;
      function nordicSourceWeights(lat,lon){
        const weights=baseWeights(lat,lon);

        // The original cloud envelope started at 25N, which clipped the
        // Florida Keys and Hawaii. Rebuild the GOES part from 18N northward
        // while keeping the same Meteosat handoff east of the Atlantic.
        if(lat>=18 && lat<=85 && lon>=-170 && lon<=-32){
          const east=smoothstep(-56,-51,lon);
          const limb=(satLon)=>smoothstep(.151,.22,
            Math.cos(lat*Math.PI/180)*Math.cos((lon-satLon)*Math.PI/180));
          // GOES-West is primary west of 108W, GOES-East east of 95W, with a
          // broad complementary blend between them to avoid a visible seam.
          const western=1-smoothstep(-108,-95,lon);
          weights.eumet=east*limb(0);
          weights.gibs=(1-east)*(1-western)*limb(-75);
          weights.west=(1-east)*western*limb(-137);
          weights.noaa=0;
        }
        weights.metop=0;

        // In the worker there is no cloudProducts registry, while in the page
        // the source is installed asynchronously. Do not advertise Metop to the
        // page loader until its product definition exists.
        const metopReady=typeof cloudProducts==='undefined' || !!cloudProducts.metop;

        // Use a true complementary handoff at high latitude: as Metop-C fades
        // in, Meteosat fades out by exactly the same fraction. This avoids a
        // washed double-source overlap and also avoids a low-opacity gap.
        if(metopReady && lat>=64 && lat<=82 && lon>=-32 && lon<=42){
          const north=smoothstep(64.5,69,lat);
          const west=smoothstep(-32,-24,lon);
          const east=1-smoothstep(36,42,lon);
          const polar=Math.max(0,Math.min(1,north*west*east));
          weights.metop=polar;
          if(Number.isFinite(weights.eumet))weights.eumet*=1-polar;
        }
        // Canada and western Greenland: complement both GOES views at their
        // high-latitude limb. The same rule runs in the worker and page.
        if(metopReady && lat>=64 && lat<=85 && lon>=-170 && lon<=-32){
          const polar=smoothstep(64,73,lat)*smoothstep(-170,-155,lon)*
            (1-smoothstep(-40,-32,lon));
          weights.metop=polar;
          for(const id of ['gibs','west','noaa'])weights[id]=(weights[id]||0)*(1-polar);
        }
        return weights;
      }
      nordicSourceWeights._nordicPolarBlend=true;
      cloudSourceWeights=nordicSourceWeights;
      changed=true;
    }

    // The prepared/server renderer does not define CLOUD_BOUNDS. In the page,
    // extend the Leaflet layer south far enough for Florida and Hawaii too.
    if(typeof CLOUD_BOUNDS!=='undefined' && Array.isArray(CLOUD_BOUNDS?.[0])){
      CLOUD_BOUNDS[0][0]=Math.min(CLOUD_BOUNDS[0][0],18);
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

    // Keep the visible version and source description in step with the map.
    if(typeof document!=='undefined'){
      if(/Northern Weather Map v8\.128\b/.test(document.title||''))
        document.title=document.title.replace('v8.128','v8.129');
      const info=document.querySelector?.('#cloudSection-sources .small');
      if(info)info.textContent='Transparent satellite clouds across the USA, Canada, Greenland, the Atlantic and Europe (170°W–42°E, 18–85°N). GOES-18 / GOES-West is primary over the western USA and GOES-19 / GOES-East over the eastern USA, with a smooth blend across the central states. The same full-disk GOES products continue north through Canada; Metop-C fills the far northern viewing gap. GeoColour / visible imagery is used in local daylight and infrared at night. Only visible tiles load. Wide views use lighter tiles; zoom 5 and closer keep full cloud detail. The timeline selects available images at or before the selected time and actual observation times appear below. Missing imagery remains transparent. Snow, ice and warm low cloud can be difficult to separate in this visual cloud overlay.';
      const canada=document.getElementById?.('cloudCanadaView');
      if(canada && !document.getElementById('cloudUsView')){
        const usa=document.createElement('button');usa.id='cloudUsView';usa.type='button';usa.textContent='View USA';
        usa.addEventListener('click',()=>map.fitBounds([[18,-161],[55,-66]],{padding:[24,100]}));
        canada.after(usa);
      }
    }

    return changed;
  }

  root.installNordicCloudCoverage=installNordicCloudCoverage;
})(typeof self!=='undefined'?self:globalThis);
