// Place search resolves coordinates; weather still uses the existing forecast cache.
(function(root){
  'use strict';
  function places(payload){
    if(payload?.error)throw new Error('Location search unavailable');
    return (Array.isArray(payload?.results)?payload.results:[]).filter(p=>
      typeof p.name==='string'&&p.name.trim()&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&
      Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180).slice(0,6).map(p=>({
        lat:p.latitude,lon:p.longitude,name:p.name,
        label:[p.name,...new Set([p.admin1,p.country].filter(v=>typeof v==='string'&&v&&v!==p.name))].join(', ')
      }));
  }
  function attach({form,input,results,status,onChoose,fetcher=fetch}){
    let timer=null,controller=null,generation=0,found=[],active=-1;
    const cache=new Map();
    const message=value=>{status.textContent=value;};
    function hide(){results.replaceChildren();results.hidden=true;found=[];active=-1;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
    function cancel(){clearTimeout(timer);generation++;controller?.abort();controller=null;}
    function highlight(index){
      active=index;input.setAttribute('aria-activedescendant',results.id+'-'+index);
      [...results.children].forEach((e,i)=>e.setAttribute('aria-selected',String(i===index)));
    }
    function select(place){
      cancel();hide();input.value=place.label;input.blur?.();message('Showing forecast for '+place.label+'.');onChoose(place);
    }
    function show(items){
      hide();found=items;
      for(const [i,p] of items.entries()){
        const e=document.createElement('li');e.id=results.id+'-'+i;e.setAttribute('role','option');
        e.setAttribute('aria-selected','false');e.textContent=p.label;
        e.addEventListener('mousedown',event=>event.preventDefault());
        e.addEventListener('click',()=>select(p));results.appendChild(e);
      }
      results.hidden=!items.length;input.setAttribute('aria-expanded',String(!!items.length));
      message(items.length?'Choose a location below.':'No matching locations. Try a nearby town or add the country.');
    }
    async function search(){
      cancel();hide();const id=generation,query=input.value.trim();
      if(query.length<2){message('Enter at least 2 characters.');return;}
      const key=query.toLowerCase();if(cache.has(key)){show(cache.get(key));return;}
      const abort=new AbortController();controller=abort;message('Searching locations…');
      const timeout=setTimeout(()=>abort.abort(),10000);
      try{
        const params=new URLSearchParams({name:query,count:'6',language:'en',format:'json'});
        const response=await fetcher('https://geocoding-api.open-meteo.com/v1/search?'+params,{signal:abort.signal});
        if(!response.ok)throw new Error('Location search HTTP '+response.status);
        const items=places(await response.json());
        if(id!==generation)return;
        cache.set(key,items);if(cache.size>30)cache.delete(cache.keys().next().value);show(items);
      }catch(error){if(id===generation)message('Location search unavailable. Try again, or choose a point on the map.');}
      finally{clearTimeout(timeout);if(controller===abort)controller=null;}
    }
    input.addEventListener('input',()=>{cancel();hide();if(input.value.trim().length<2){message('Search for a town or city.');return;}message('');timer=setTimeout(search,450);});
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();cancel();hide();message('');}
      else if(found.length&&['ArrowDown','ArrowUp','Enter'].includes(event.key)){
        event.preventDefault();
        if(event.key==='Enter'){select(found[active<0?0:active]);}
        else highlight(active<0?(event.key==='ArrowDown'?0:found.length-1):(active+(event.key==='ArrowDown'?1:-1)+found.length)%found.length);
      }
    });
    form.addEventListener('submit',event=>{event.preventDefault();search();});
    return {cancel:()=>{cancel();hide();},search};
  }
  root.NorthernForecastSearch={places,attach};
  if(typeof module!=='undefined'&&module.exports)module.exports={places,attach};
})(typeof window!=='undefined'?window:globalThis);
