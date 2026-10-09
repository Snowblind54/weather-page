// Clean Meteosat/MTG cloud extraction for Europe.
// GeoColour contains the real Earth surface, so do not use its broad brightness
// directly as cloud opacity. Pair it with the matching FCI IR10.5 image instead.
(function(root){
  function localVisibleSmoothness(day,p,blockScale=1){
    if(!day?.length)return .5;
    const side=Math.round(Math.sqrt(day.length/4));
    if(side<8 || side*side*4!==day.length)return .5;
    const x=p%side,y=Math.floor(p/side),r=Math.max(2,Math.round(side/(64*blockScale)));
    let min=255,max=0,sum=0,count=0;
    for(const dy of [-r,0,r])for(const dx of [-r,0,r]){
      if(dx===0&&dy===0)continue;
      const xx=Math.max(0,Math.min(side-1,x+dx));
      const yy=Math.max(0,Math.min(side-1,y+dy));
      const i=(yy*side+xx)*4;
      const lum=.2126*day[i]+.7152*day[i+1]+.0722*day[i+2];
      min=Math.min(min,lum);max=Math.max(max,lum);sum+=lum;count++;
    }
    if(!count)return .5;
    const spread=max-min;
    return 1-smoothstep(10,52,spread);
  }

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
          const red=day[index],green=day[index+1],blue=day[index+2];
          const lum=.2126*red+.7152*green+.0722*blue;
          const visual=visualCloudScore(red,green,blue);
          const chroma=Math.max(red,green,blue)-Math.min(red,green,blue);

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

          // Keep very obvious warm low cloud too.
          const obviousLowCloud=smoothstep(.78-.08*north,.97-.04*north,visual)*
            smoothstep(160-15*north,235-10*north,lum)*(.38+.10*north);
          dayAlpha=Math.max(dayAlpha,obviousLowCloud);

          // Recover broad warm stratus/low-cloud sheets that the strict IR gate
          // tends to erase over the Baltics, Finland and Scandinavia. Sat24-like
          // scenes often contain these clouds even though their tops are only a
          // little colder than the surface. Use a feathered northern-Europe mask,
          // neutral visible colour, weak IR support and local smoothness so land
          // texture does not turn into a milky overlay.
          const northEurope=smoothstep(52,56,lat)*(1-smoothstep(69,72,lat))*
            smoothstep(2,8,lon)*(1-smoothstep(36,42,lon));
          if(northEurope>.001 && ir){
            const neutral=1-smoothstep(18,72,chroma);
            const sheetVisible=smoothstep(.30,.76,visual);
            const warmIr=smoothstep(42-6*north,118-10*north,irLum);
            const smooth=localVisibleSmoothness(day,p,source.blockScale||1);
            const lowCloudSheet=northEurope*sheetVisible*neutral*
              (.55+.45*smooth)*(.22+.78*warmIr)*(.56+.08*north);
            dayAlpha=Math.max(dayAlpha,lowCloudSheet);
          }

          dayAlpha*=day[index+3]/255;

          // Thin northern-European low cloud is allowed a lower opacity floor;
          // elsewhere the stricter anti-haze cutoff remains unchanged.
          const cutoff=(.06-.025*north)*(1-.35*northEurope);
          if(dayAlpha<cutoff)dayAlpha=0;

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
