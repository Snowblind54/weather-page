// Prefer R2/CDN; use the independent GitHub snapshot during an outage/pause.
(() => {
  const base=window.WEATHER_R2_BASE;if(!base)return;
  const nativeFetch=window.fetch.bind(window),site=new URL('.',window.location.href);
  const github='https://raw.githubusercontent.com/Snowblind54/weather-page/weather-fallback/';
  const r2=base.replace(/\/$/,'')+'/weather/';
  let fallbackUntil=0,checkedAt=0,modePending=null;
  const excluded=path=>/^data\/(cloud-tiles|radar-tiles)(\/|\.json(?:\?|$))/.test(path);
  function dataPath(value){
    const url=new URL(value,site);let path=null;
    if(url.origin===site.origin&&url.pathname.startsWith(site.pathname+'data/'))path=url.pathname.slice(site.pathname.length);
    else if(url.href.startsWith(r2+'data/'))path=url.pathname.slice(new URL(r2).pathname.length);
    else if(url.origin==='https://raw.githubusercontent.com'&&url.pathname.startsWith('/Snowblind54/weather-page/main/data/'))path=url.pathname.slice('/Snowblind54/weather-page/main/'.length);
    if(!path||path==='data/estonia-marine-warning-zones.geojson')return null;
    return path+url.search;
  }
  function useGithub(){return fallbackUntil>Date.now();}
  async function timedFetch(input,options,ms){
    const controller=new AbortController(),source=options.signal;
    const combined=source&&typeof AbortSignal!=='undefined'&&AbortSignal.any?AbortSignal.any([source,controller.signal]):null;
    const abort=()=>controller.abort(source?.reason);
    if(!combined){if(source?.aborted)abort();else source?.addEventListener('abort',abort,{once:true});}
    const timer=setTimeout(()=>controller.abort(),ms);
    try{return await nativeFetch(input,{...options,signal:combined||controller.signal});}
    catch(error){if(!combined)source?.removeEventListener('abort',abort);throw error;}
    finally{clearTimeout(timer);}
  }
  async function checkMode(){
    if(modePending)return modePending;
    if(Date.now()-checkedAt<60000)return;
    modePending=(async()=>{
      try{
        const response=await timedFetch(github+'_fallback/status.json?minute='+Math.floor(Date.now()/60000),{credentials:'omit'},1500);
        if(response.ok){const status=await response.json();
          if(status.version===1&&status.mode==='active'&&Number.isFinite(status.until)){
            fallbackUntil=Math.max(fallbackUntil,Math.min(status.until*1000,Date.now()+1800000));
          }
        }
      }catch{/* R2 stays primary if the standby check is unavailable. */}
      finally{checkedAt=Date.now();modePending=null;}
    })();return modePending;
  }
  window.weatherGithubDataUrl=value=>{const path=dataPath(value);return path?github+path:value;};
  window.weatherDataUrl=value=>{const path=dataPath(value);return path?(useGithub()?github:r2)+path:value;};
  if(typeof document!=='undefined'){
    setInterval(()=>{if(!document.hidden)checkMode();},60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){checkedAt=0;checkMode();}});
  }
  window.fetch=async(input,options={})=>{
    const isRequest=typeof Request!=='undefined'&&input instanceof Request;
    const original=isRequest?input.url:String(input),method=options.method||(isRequest?input.method:'GET');
    const path=dataPath(original);
    if(!path||!['GET','HEAD'].includes(method.toUpperCase()))return nativeFetch(input,options);
    const signal=options.signal||(isRequest?input.signal:undefined);
    const remoteOptions={...options,signal,credentials:'omit'};
    const requestFor=url=>isRequest?new Request(url,input):url;
    // Check the cutoff before issuing any new R2 request.
    await checkMode();
    const primary=useGithub()?null:timedFetch(requestFor(r2+path),remoteOptions,4000)
      .then(response=>({response}),error=>({error}));
    if(!useGithub()&&primary){
      const result=await primary;
      if(signal?.aborted){if(result.error)throw result.error;return result.response;}
      if(result.response?.ok)return result.response;
      if(!excluded(path))fallbackUntil=Date.now()+60000;
    }
    if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');
    // Optional prepared radar/cloud archives are deliberately not mirrored.
    // Their existing loaders recover through official providers.
    if(excluded(path))return new Response('',{status:503});
    try{
      const response=await nativeFetch(requestFor(github+path),remoteOptions);
      if(response.ok||signal?.aborted)return response;
    }catch(error){if(signal?.aborted)throw error;}
    if(useGithub())return new Response('',{status:503});
    return nativeFetch(input,options);
  };
})();
