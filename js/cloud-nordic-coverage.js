// Keep cloud extraction complete north of the legacy MSG cloud-mask footprint.
// Use full-disk GOES-East / GOES-West across North America so Canada never
// depends on the CONUS-clipped nowCOAST mosaic; polar imagery fills the far Arctic.
(function(root){
  function installNordicCloudCoverage(){
    let changed=false;

    if(typeof cloudSourceWeights==='function' && !cloudSourceWeights._nordicPolarBlend){
      const baseWeights=cloudSourceWeights;
      function nordicSourceWeights(lat,lon){
        const weights=baseWeights(lat,lon);

        // The original cloud envelope started at 25N, which clipped Florida and
        // Hawaii. Rebuild North American routing from 18N northward. NASA GIBS
        // full-disk GOES-East / GOES-West is used on both sides of the US/Canada
        // border, avoiding the hard northern edge in the nowCOAST mosaic.
        if(lat>=18 && lat<=85 && lon>=-170 && lon<=-32){
          // Keep Newfoundland and Labrador on GOES before handing the North
          // Atlantic to Meteosat farther east.
          const east=smoothstep(-50,-44,lon);
          const limb=(satLon)=>smoothstep(.151,.22,
            Math.cos(lat*Math.PI/180)*Math.cos((lon-satLon)*Math.PI/180));
          const western=1-smoothstep(-108,-95,lon);
          weights.eumet=east*limb(0);
          weights.noaa=0;
          weights.gibs=(1-east)*(1-western)*limb(-75);
          weights.west=(1-east)*western*limb(-137);
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
        // Canada and western Greenland: complement both full-disk GOES views
        // with Metop-C at their high-latitude limb. Multiplying geostationary
        // contributions by (1-polar) keeps the blend complementary.
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

    // Preserve readable wording if the legacy NOAA source is ever used as a
    // fallback elsewhere. The normal North American path is full-disk GIBS.
    if(typeof cloudTimeDescription==='function' && !cloudTimeDescription._canadaFastGoes){
      const baseTimeDescription=cloudTimeDescription;
      const wrapped=function(results){
        return baseTimeDescription(results).replace(/GOES US/g,'GOES East/West');
      };
      wrapped._canadaFastGoes=true;
      cloudTimeDescription=wrapped;
    }

    // Keep the visible version and source description in step with the map.
    if(typeof document!=='undefined'){
      if(/Northern Weather Map v8\.(128|129|130|131)\b/.test(document.title||''))
        document.title=document.title.replace(/v8\.(128|129|130|131)/,'v8.132');
      const intro=document.querySelector?.('#cloudSection-sources p');
      if(intro)intro.textContent='EUMETSAT Meteosat GeoColour / FCI IR10.5 and cloud mask; NASA GIBS full-disk GOES-East / GOES-West visible and Band 13 infrared across the USA and Canada; EUMETSAT Metop-C AVHRR IR10.8 over the Arctic. Local daylight selects visible imagery; darkness selects infrared. Actual source observation times appear in the layer status.';
      const info=document.querySelector?.('#cloudSection-sources .small');
      if(info)info.textContent='Transparent satellite clouds across the USA, Canada, Greenland, the Atlantic and Europe (170°W–42°E, 18–85°N). NASA GIBS full-disk GOES-East / GOES-West is used continuously across the USA–Canada border, removing the former northern cutoff from the CONUS-oriented nowCOAST mosaic. The East/West views blend smoothly through central North America; at high Arctic latitudes Metop-C increasingly fills the shallow geostationary viewing angle, while Meteosat covers the North Atlantic and Europe. Visible imagery is used in local daylight and infrared at night. Prepared cloud tiles and the two-hour timeline update from the same routing, and actual observation times appear below. Missing imagery remains transparent. Snow, ice and warm low cloud can be difficult to separate in this visual cloud overlay.';
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
