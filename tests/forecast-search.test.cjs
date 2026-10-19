const {test}=require('node:test'),assert=require('node:assert/strict');
const {places,attach}=require('../js/forecast-search.js');
class Element{
 constructor(){this.children=[];this.listeners={};this.attrs={};this.value='';this.id='matches';}
 addEventListener(name,fn){this.listeners[name]=fn;}
 setAttribute(name,value){this.attrs[name]=value;}
 removeAttribute(name){delete this.attrs[name];}
 replaceChildren(){this.children=[];}
 appendChild(e){this.children.push(e);}
}
function ui(fetcher,options={}){
 global.document={createElement:()=>new Element()};
 const form=new Element(),input=new Element(),results=new Element(),status=new Element(),selected=[];
 const search=attach({...options,form,input,results,status,fetcher,onChoose:p=>selected.push(p)});
 return {form,input,results,status,selected,search};
}
const point=(name='Tallinn',latitude=59.44,longitude=24.75)=>({name,latitude,longitude,admin1:'Harjumaa',country:'Estonia'});
test('location results preserve useful labels and reject invalid coordinates',()=>{
 const result=places({results:[point(),point('bad',NaN),point('bad',99),point('bad',50,181),{name:'Missing'}]});
 assert.equal(result.length,1);assert.equal(result[0].label,'Tallinn, Harjumaa, Estonia');assert.equal(result[0].lat,59.44);
 assert.deepEqual(places({}),[]);assert.throws(()=>places({error:true}));
});
test('search selects a place with the keyboard and reuses cached results',async()=>{
 let calls=0;
 const h=ui(async url=>{calls++;assert.match(url,/name=Tallinn/);return {ok:true,json:async()=>({results:[point()]})};});
 h.input.value='Tallinn';await h.search.search();assert.equal(h.results.children.length,1);
 assert.equal(h.input.attrs['aria-expanded'],'true');
 h.input.listeners.keydown({key:'ArrowDown',preventDefault(){}});
 assert.equal(h.results.children[0].attrs['aria-selected'],'true');
 h.input.listeners.keydown({key:'Enter',preventDefault(){}});
 assert.equal(h.selected[0].lon,24.75);assert.equal(h.input.value,'Tallinn, Harjumaa, Estonia');assert(h.results.hidden);
 h.input.value='Tallinn';await h.search.search();assert.equal(calls,1);
});
test('late results and closed-panel requests cannot replace the current search',async()=>{
 const pending=[];const h=ui((url,options)=>new Promise(resolve=>pending.push({resolve,options})));
 h.input.value='Tallinn';const first=h.search.search();
 h.input.value='London';const second=h.search.search();assert(pending[0].options.signal.aborted);
 pending[1].resolve({ok:true,json:async()=>({results:[point('London',51.5,-.1)]})});await second;
 pending[0].resolve({ok:true,json:async()=>({results:[point()]})});await first;
 assert.match(h.results.children[0].textContent,/London/);
 h.input.value='Reykjavik';const third=h.search.search();h.search.cancel();
 pending[2].resolve({ok:true,json:async()=>({results:[point('Reykjavik',64,-22)]})});await third;
 assert(h.results.hidden);assert.equal(h.results.children.length,0);
});
test('empty searches and provider failures do not select a place',async()=>{
 let calls=0;const h=ui(async()=>{calls++;throw new Error('offline');});
 h.input.value='T';await h.search.search();assert.equal(calls,0);
 h.input.value='Tallinn';await h.search.search();assert.match(h.status.textContent,/unavailable/);assert.equal(h.selected.length,0);
});

test('forecast place results follow the country selection while space-weather searches remain global',async()=>{
 global.NorthernCountryFocus={allowsPoint:lat=>lat>55};
 try{
  const fetcher=async()=>({ok:true,json:async()=>({results:[point(),point('London',51.5,-.1)]})});
  const forecast=ui(fetcher,{countryScope:true});forecast.input.value='Place';await forecast.search.search();assert.equal(forecast.results.children.length,1);assert.match(forecast.results.children[0].textContent,/Tallinn/);
  const aurora=ui(fetcher);aurora.input.value='Place';await aurora.search.search();assert.equal(aurora.results.children.length,2);
 }finally{delete global.NorthernCountryFocus;}
});
