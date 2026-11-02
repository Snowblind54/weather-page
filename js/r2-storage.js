// Prefer R2/CDN; use the independent GitHub snapshot during an outage/pause.
(() => {
  const base=window.WEATHER_R2_BASE;if(!base)return;
  const nativeFetch=window.fetch.bind(window),site=new URL('.',window.location.href);
  const github='https://raw.githubusercontent.com/Snowblind54/weather-page/weather-fallback/';
  const r2=base.replace(/\/$/,'')+'/weather/';
  let fallbackUntil=0,checkedAt=0,modePending=null,fallbackReason=null;
  const pathFallback=new Map();
  const fallbackKey=path=>{
    const file=path.split('?')[0];
    if(/^data\/(cloud-tiles|radar-tiles)(\/|\.json$)/.test(file))
      return file.startsWith('data/cloud-tiles')?'data/cloud-tiles':'data/radar-tiles';
    if(file==='data/aurora-planner.json'||file.startsWith('data/aurora-planner-cloud/'))return 'data/aurora-planner';
    return file;
  };
  const excluded=path=>/^data\/(cloud-tiles|radar-tiles)(\/|\.json(?:\?|$))/.test(path);
  function dataPath(value){
    const url=new URL(value,site);let path=null;
    if(url.origin===site.origin&&url.pathname.startsWith(site.pathname+'data/'))path=url.pathname.slice(site.pathname.length);
    else if(url.href.startsWith(r2+'data/'))path=url.pathname.slice(new URL(r2).pathname.length);
    else if(url.origin==='https://raw.githubusercontent.com'&&url.pathname.startsWith('/Snowblind54/weather-page/main/data/'))path=url.pathname.slice('/Snowblind54/weather-page/main/'.length);
    if(!path||path==='data/estonia-marine-warning-zones.geojson')return null;
    return path+url.search;
  }
  // A single broken feed must never send unrelated, fresher data to an old
  // GitHub copy. Only a confirmed account-wide operation cutoff is global.
  function useGithub(path){
    return (fallbackReason==='budget_guard' && fallbackUntil>Date.now()) ||
      (pathFallback.get(fallbackKey(path))||0)>Date.now();
  }
  async function staleCritical(response,path,method){
    const file=path.split('?')[0];
    const cloud=file==='data/aurora-cloud.json',planner=file==='data/aurora-planner.json';
    const limit=['data/official-temperature.json','data/official-wind.json'].includes(file)?30*60000:
      file==='data/official-rainfall.json'?45*60000:
      file==='data/space-weather.json'?20*60000:
      cloud?6*3600000:planner?18*3600000:null;
    if(!limit||method.toUpperCase()!=='GET')return false;
    try{
      const snapshot=await response.clone().json(),now=Date.now();
      const generated=planner?Date.parse(snapshot.generated_at):snapshot.generatedAt*1000;
      if(!Number.isFinite(generated)||generated>now+5*60000||now-generated>limit)return true;
      if(cloud){
        const run=Date.parse(snapshot.runTime),valid=Date.parse(snapshot.validTime);
        return !Number.isFinite(run)||!Number.isFinite(valid)||
          now-run>18*3600000||now-valid>3*3600000||valid-now>8*3600000;
      }
      if(planner){
        const run=Date.parse(snapshot.reference_time);
        return !Number.isFinite(run)||run>now+5*60000||now-run>24*3600000;
      }
      return false;
    }catch{return true;}
  }
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
          if(status.version===1&&status.mode==='active'&&status.reason==='budget_guard'&&Number.isFinite(status.until)){
            fallbackReason='budget_guard';
            fallbackUntil=Math.max(fallbackUntil,Math.min(status.until*1000,Date.now()+1800000));
          }else if(status.version===1&&status.mode==='standby'){
            fallbackUntil=0;fallbackReason=null;
          }
        }
      }catch{/* R2 stays primary if the standby check is unavailable. */}
      finally{checkedAt=Date.now();modePending=null;}
    })();return modePending;
  }
  window.weatherGithubDataUrl=value=>{const path=dataPath(value);return path?github+path:value;};
  window.weatherDataUrl=value=>{const path=dataPath(value);return path?(useGithub(path)?github:r2)+path:value;};
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
    const primary=useGithub(path)?null:timedFetch(requestFor(r2+path),remoteOptions,4000)
      .then(response=>({response}),error=>({error}));
    if(!useGithub(path)&&primary){
      const result=await primary;
      if(signal?.aborted){if(result.error)throw result.error;return result.response;}
      if(result.response?.ok && !await staleCritical(result.response,path,method))return result.response;
      if(!excluded(path))pathFallback.set(fallbackKey(path),Date.now()+60000);
    }
    if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');
    // Prepared archives have the same relative paths in the GitHub mirror.
    // If neither copy is available, their loaders still use official providers.
    try{
      const response=await nativeFetch(requestFor(github+path),remoteOptions);
      if(response.ok){
        if(/^data\/aurora-(cloud|planner)\.json(?:\?|$)/.test(path) &&
           await staleCritical(response,path,method))return new Response('',{status:503});
        // A mirrored manifest must load its images from the same healthy
        // source, including native Image requests outside the fetch wrapper.
        pathFallback.set(fallbackKey(path),Date.now()+60000);
        return response;
      }
      if(signal?.aborted)return response;
    }catch(error){if(signal?.aborted)throw error;}
    if(useGithub(path))return new Response('',{status:503});
    return nativeFetch(input,options);
  };
})();

