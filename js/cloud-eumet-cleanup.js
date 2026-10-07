// Clean Meteosat/MTG cloud extraction for Europe.
// GeoColour contains the real Earth surface, so do not use its broad brightness
// directly as cloud opacity. Pair it with the matching FCI IR10.5 image instead.
(function(root){
  function installEumetCleanClouds(){
    let changed=false;

    // Replace only the EUMETSAT loader. Request GeoColour for daytime tone and
    // IR10.5 at all times as the cloud discriminator. This replaces the legacy
    // MSG cloud-mask request, so request count does not increase in daylight.
    if(typeof cloudLoadSource==='function' && !cloudLoadSource._eumetCleanLoader){
      const baseLoadSource=cloudLoadSource;
      const wrappedLoadSource=async function(id,coords,time){
        if(id!=='eumet')return baseLoadSource(id,coords,time);

        const product=cloudProducts.eumet;
        const dayTime=cloudAvailableTime(product,product.day,time);
        const nightTime=cloudAvailableTime(product,product.night,time);
        const modes=cloudModesForTile(coords,Math.min(dayTime,nightTime),id);

        const [day,night]=await Promise.all([
          modes.day?cloudImagePixels(cloudMapUrl(product,product.day,dayTime,coords),cloudTileSide(coords)):Promise.resolve(null),
          cloudImagePixels(cloudMapUrl(product,product.night,nightTime,coords),cloudTileSide(coords))
        ]);

        return {
          id,
          day,
          night,
          mask:null,
          dayTime,
          nightTime,
          eumetClean:true
        };
      };
      wrappedLoadSource._eumetCleanLoader=true;
      cloudLoadSource=wrappedLoadSource;
      changed=true;
    }

    // Worker and main-thread fallback share this exact pixel rule.
    if(typeof cloudExtractPixel==='function' && !cloudExtractPixel._eumetCleanPixels){
      const baseExtractPixel=cloudExtractPixel;
      const wrappedExtractPixel=function(source,index,p,lat,lon){
        if(source.id!=='eumet' || !source.eumetClean)return baseExtractPixel(source,index,p,lat,lon);

        const solarTime=source.day?source.dayTime:source.nightTime;
        const mix=cloudSolarMix(solarTime,lat,lon).dayMix;
        let dayAlpha=0,nightAlpha=0,dayTone=190,nightTone=190;

        if(source.day && mix>.001){
          const day=source.day;
          const lum=.2126*day[index]+.7152*day[index+1]+.0722*day[index+2];
          const visual=visualCloudScore(day[index],day[index+1],day[index+2]);

          // Finland, Sweden and northern Norway are viewed at a much shallower
          // angle by Meteosat and often contain warmer low/stratiform cloud.
          // Gradually increase sensitivity north of 58 N without weakening the
          // anti-haze filter over central/southern Europe or creating a hard seam.
          const north=smoothstep(58,64,lat);

          // IR10.5 contains no photographic land/sea colour. Keep it as the
          // primary gate, but allow somewhat warmer cloud tops in the north.
          const ir=source.night;
          const irLum=ir?(.2126*ir[index]+.7152*ir[index+1]+.0722*ir[index+2]):0;
          const coldCloud=smoothstep(78-18*north,178-22*north,irLum);
          const visibleCloud=smoothstep(.45-.12*north,.88-.08*north,visual);

          // Thick/mid/high clouds still need IR support, so pale GeoColour
          // surface/haze cannot recreate the former milky European veil.
          dayAlpha=(coldCloud**(1.20-.18*north))*(.34+.66*visibleCloud)*(.92+.04*north);

          // Keep obvious warm low cloud too. This branch gets only a modest
          // northern boost and still requires a bright, neutral visible signal.
          const obviousLowCloud=smoothstep(.78-.08*north,.97-.04*north,visual)*
            smoothstep(160-15*north,235-10*north,lum)*(.38+.10*north);
          dayAlpha=Math.max(dayAlpha,obviousLowCloud);
          dayAlpha*=day[index+3]/255;

          // Lower the final cutoff gradually in the north so thin cloud is not
          // discarded, while southern Europe retains the strict cleanup.
          if(dayAlpha<.06-.025*north)dayAlpha=0;

          dayTone=Math.max(150,Math.min(255,156+99*smoothstep(55,235,lum)));
        }

        if(source.night && mix<.999){
          const ir=source.night;
          const lum=.2126*ir[index]+.7152*ir[index+1]+.0722*ir[index+2];
          nightAlpha=(smoothstep(52,205,lum)**1.35)*.78*(ir[index+3]/255);
          if(nightAlpha<.035)nightAlpha=0;
          nightTone=Math.max(138,Math.min(255,142+113*smoothstep(18,235,lum)));
        }

        const da=Math.min(.95,dayAlpha)*mix;
        const na=Math.min(.95,nightAlpha)*(1-mix);
        return {alpha:da+na,tone:(dayTone*da+nightTone*na)/Math.max(.0001,da+na)};
      };
      wrappedExtractPixel._eumetCleanPixels=true;
      cloudExtractPixel=wrappedExtractPixel;
      changed=true;
    }

    return changed;
  }

  root.installEumetCleanClouds=installEumetCleanClouds;
})(typeof self!=='undefined'?self:globalThis);
