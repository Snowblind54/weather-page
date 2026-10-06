// Shared model-wind source for the particle animation and wind heatmap.
//
// The old browser path asked Open-Meteo for all 568 grid locations separately
// for every visitor. Open-Meteo counts multi-location requests by location, so
// visitors could hit HTTP 429 and get stuck in a local cooldown. GitHub Actions
// now builds data/model-wind.json centrally; browsers only download that file.
(function installSharedWindSource(){
  // This module is requested by config.js while the page is still parsing.
  // If wind.js has not executed yet, retry once the synchronous scripts finish.
  if(typeof validWindData!=='function' || typeof windVisualEnabled!=='function'){
    setTimeout(installSharedWindSource,0);
    return;
  }

  const SHARED_WIND_URL='data/model-wind.json';
  const SHARED_WIND_REFRESH_MS=45*60*1000;

  fetchWindData=async function(){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      // Five-minute URL buckets avoid a stale intermediary cache while still
      // letting simultaneous visitors share the same static response.
      const cacheBucket=Math.floor(Date.now()/(5*60*1000));
      const response=await fetch(`${SHARED_WIND_URL}?v=${cacheBucket}`,{
        cache:'no-store',signal:controller.signal
      });
      if(!response.ok)throw new Error(`Shared wind snapshot HTTP ${response.status}`);
      const data=await response.json();
      if(!validWindData(data)||!data.grids?.[0]?.some(series=>series.some(Boolean))){
        throw new Error('Shared wind snapshot is invalid');
      }

      // savedAt is used by the existing client as its cache-receipt time. Keep
      // the server generation time separately so a shared snapshot does not get
      // re-downloaded on every toggle merely because it was generated earlier.
      data.generatedAt=data.savedAt;
      data.savedAt=Date.now();
      windRetryAt=0;
      return data;
    }catch(error){
      const detail=error?.name==='AbortError'?'timed out':'is temporarily unavailable';
      const wrapped=new Error(`Shared wind data ${detail}. Please try again shortly.`);
      wrapped.cause=error;
      throw wrapped;
    }finally{
      clearTimeout(timeout);
    }
  };

  loadWind=async function(){
    if(!windVisualEnabled())return;

    if(windData && Date.now()-windData.savedAt<SHARED_WIND_REFRESH_MS){
      if($('windOn').checked)renderWind(selectedWindTime());
      if($('windHeatmapOn').checked)renderWindHeatmap(selectedWindTime());
      return;
    }

    // There is no visitor-specific upstream cooldown anymore. An old 429 from
    // the previous direct-fetch implementation must not block the new source.
    windRetryAt=0;
    renderWind(selectedWindTime());
    $('windStatus').textContent=windData?'Updating shared wind data…':'Loading shared wind over land and sea…';
    $('windStatus').className='status';

    if(!windLoadPromise){
      windLoadPromise=fetchWindData().then(data=>{
        windData=data;
        try{localStorage.setItem(WIND_CACHE_KEY,JSON.stringify(data));}catch(e){}
      }).finally(()=>{windLoadPromise=null;});
    }

    await windLoadPromise;
    if($('windOn').checked)renderWind(selectedWindTime());
    if($('windHeatmapOn').checked)renderWindHeatmap(selectedWindTime());
  };

  // Clear any cooldown left behind if the old implementation already ran from
  // a cached page before this small override module finished loading.
  windRetryAt=0;
})();
