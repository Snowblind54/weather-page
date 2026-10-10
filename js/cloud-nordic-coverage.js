// Keep cloud extraction complete north of the legacy MSG cloud-mask footprint.
// Use NOAA's fresh GOES-19 / GOES-18 mosaic across the USA and populated Canada,
// then hand off smoothly to full-disk GOES and polar imagery in the far Arctic.
(function(root){
  function installNordicCloudCoverage(){
    let changed=false;

    if(typeof cloudSourceWeights==='function' && !cloudSourceWeights._nordicPolarBlend){
      const baseWeights=cloudSourceWeights;
      function nordicSourceWeights(lat,lon){
        const weights=baseWeights(lat,lon);

        // Rebuild North American routing from 18N northward. nowCOAST supplies
        // the recent five-minute GOES mosaic through the USA and most of Canada.
        // Only the high Arctic fades to full-disk GIBS + Metop-C, avoiding the
        // multi-hour GIBS latency seen over Ontario while retaining polar reach.
        if(lat>=18 && lat<=85 && lon>=-170 && lon<=-32){
          // Keep Newfoundland and Labrador on GOES before handing the North
          // Atlantic to Meteosat farther east.
          const east=smoothstep(-50,-44,lon);
          const limb=(satLon)=>smoothstep(.151,.22,
            Math.cos(lat*Math.PI/180)*Math.cos((lon-satLon)*Math.PI/180));
          const fastNorth=1-smoothstep(66,72,lat);
          const western=1-smoothstep(-108,-95,lon);
          const fullDisk=(1-east)*(1-fastNorth);
          weights.eumet=east*limb(0);
          weights.noaa=(1-east)*fastNorth;
          weights.gibs=fullDisk*(1-western)*limb(-75);
          weights.west=fullDisk*western*limb(-137);
        }
        weights.metop=0;

        // In the worker there is no cloudProducts registry, while in the page
        // the source is installed asynchronously. Do not advertise Metop to the
        // page loader until its product definition exists.
        const metopReady=typeof cloudProducts==='undefined' || !!cloudProducts.metop;

        // Use a true complementary handoff at high latitude: as Metop-C fades
        // in, Meteosat fades out by exactly the same fraction.
        if(metopReady && lat>=64 && lat<=82 && lon>=-32 && lon<=42){
          const north=smoothstep(64.5,69,lat);
          const west=smoothstep(-32,-24,lon);
          const east=1-smoothstep(36,42,lon);
          const polar=Math.max(0,Math.min(1,north*west*east));
          weights.metop=polar;
          if(Number.isFinite(weights.eumet))weights.eumet*=1-polar;
        }
        // Canada and western Greenland: complement the fast mosaic and both
        // full-disk GOES views with Metop-C at their high-latitude limb.
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
          return baseProcessPixels(coords,sources,size);
        }finally{
          for(const [source,mask] of disabledMasks)source.mask=mask;
        }
      }

      processNordicCloudPixels._nordicMaskFallback=true;
      cloudProcessPixels=processNordicCloudPixels;
      changed=true;
    }

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
      if(/Northern Weather Map v8\.(128|129|130|131|132)\b/.test(document.title||''))
        document.title=document.title.replace(/v8\.(128|129|130|131|132)/,'v8.133');
      const intro=document.querySelector?.('#cloudSection-sources p');
      if(intro)intro.textContent='EUMETSAT Meteosat GeoColour / FCI IR10.5 and cloud mask; NOAA nowCOAST GOES-19 / GOES-18 visible and longwave infrared mosaic over the USA and most of Canada; NASA GIBS full-disk GOES-East / GOES-West plus EUMETSAT Metop-C AVHRR IR10.8 for the high-Arctic handoff. Local daylight selects visible imagery; darkness selects infrared. Actual source observation times appear in the layer status.';
      const info=document.querySelector?.('#cloudSection-sources .small');
      if(info)info.textContent='Transparent satellite clouds across the USA, Canada, Greenland, the Atlantic and Europe (170°W–42°E, 18–85°N). The frequently updated NOAA GOES mosaic is primary through the USA and populated/central Canada so Canadian clouds stay near real time. From roughly 66–72°N it fades smoothly into NASA GIBS full-disk GOES-West / GOES-East while Metop-C increasingly fills the shallow geostationary viewing angle; Meteosat covers the North Atlantic and Europe. Prepared cloud tiles and the two-hour timeline use the same routing. Missing imagery remains transparent. Snow, ice and warm low cloud can be difficult to separate in this visual cloud overlay.';
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
