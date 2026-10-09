const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {popupPanOffset}=require('../js/popup-visibility.js');

test('Popup panning respects the top bar and viewport edges',()=>{
  const safe={left:12,right:988,top:110,bottom:688};
  assert.deepEqual(popupPanOffset({left:300,right:650,top:50,bottom:280},safe),[0,-60]);
  assert.deepEqual(popupPanOffset({left:300,right:650,top:150,bottom:400},safe),[0,0]);
  assert.deepEqual(popupPanOffset({left:850,right:1100,top:550,bottom:760},safe),[112,72]);
});

test('Refreshing station markers during automatic panning preserves the open popup',()=>{
  const events={},queue=[],pans=[],handlers=new Map();let closed=0;
  const source={on:(type,fn)=>handlers.set(type,fn),off:(type,fn)=>{if(handlers.get(type)===fn)handlers.delete(type);},closePopup:()=>closed++,getPopup:()=>popup};
  handlers.set('remove',source.closePopup); // Leaflet 1.9.4 bindPopup removal hook.
  const popup={_source:source,options:{maxHeight:500,maxWidth:300},on:()=>{},off:()=>{},
    getElement:()=>({isConnected:true,getBoundingClientRect:()=>({left:300,right:650,top:50,bottom:280})}),update:()=>{throw Error('No resize needed');}};
  const ctx={innerWidth:1000,innerHeight:700,document:{querySelector:()=>({getBoundingClientRect:()=>({left:16,right:984,bottom:96})})},
    requestAnimationFrame:fn=>(queue.push(fn),queue.length),cancelAnimationFrame:()=>{},matchMedia:()=>({matches:false}),
    map:{on:(type,fn)=>events[type]=fn,getContainer:()=>({getBoundingClientRect:()=>({left:0,right:1000,top:0,bottom:700})}),
      panBy:offset=>{pans.push(Array.from(offset));handlers.get('remove')?.();}}};
  vm.runInNewContext(fs.readFileSync('js/popup-visibility.js','utf8'),ctx);
  events.popupopen({popup});while(queue.length)queue.shift()();
  assert.deepEqual(pans,[[0,-58]]);
  assert.equal(closed,0,'moveend marker replacement must not close the popup');
  source.closePopup();assert.equal(closed,1,'explicit popup closing remains available');
  events.popupclose({popup});
  assert.equal(handlers.get('remove'),source.closePopup,'restore normal removal behavior after closing');
});
