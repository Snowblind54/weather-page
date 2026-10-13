// Bounded decoded-image ownership: callers lease images while drawing them.
(function(root,factory){const Cache=factory();if(typeof module==='object'&&module.exports)module.exports=Cache;else root.NorthernDecodedImageCache=Cache;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 return class DecodedImageCache {
  constructor({maxBytes,maxEntries=128}){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.entries=new Map();this.pending=new Map();this.live=new Set();this.generation=0;}
  bytes(){let total=0;for(const e of this.live)total+=e.bytes;return total;}
  dispose(e){if(e.closed||!e.image)return;e.closed=true;e.image.close?.();this.live.delete(e);}
  trim(){
   const budget=typeof this.maxBytes==='function'?this.maxBytes():this.maxBytes;
   for(const [key,e] of this.entries){
    if(this.bytes()<=Math.max(0,budget)&&this.entries.size<=this.maxEntries)break;
    if(e.refs)continue;this.entries.delete(key);e.retired=true;this.dispose(e);
   }
  }
  clear(){
   this.generation++;for(const e of this.entries.values()){e.retired=true;if(!e.refs)this.dispose(e);}this.entries.clear();this.pending.clear();
  }
  acquire(key,loader){
   let e=this.entries.get(key)||this.pending.get(key);
   if(!e){
    e={refs:0,bytes:0,image:null,retired:false,closed:false,generation:this.generation};this.pending.set(key,e);
    e.promise=Promise.resolve().then(loader).then(image=>{
     e.image=image;e.bytes=(image.width||image.naturalWidth)*(image.height||image.naturalHeight)*4;this.live.add(e);
     if(e.generation===this.generation){this.entries.set(key,e);}else e.retired=true;
     if(this.pending.get(key)===e)this.pending.delete(key);return e;
    },error=>{if(this.pending.get(key)===e)this.pending.delete(key);throw error;});
   }
   e.refs++;
   return e.promise.then(()=>{
    if(this.entries.get(key)===e){this.entries.delete(key);this.entries.set(key,e);}this.trim();let released=false;
    return {image:e.image,release:()=>{if(released)return;released=true;e.refs--;if(e.retired&&!e.refs)this.dispose(e);this.trim();}};
   },error=>{e.refs--;throw error;});
  }
 };
});
