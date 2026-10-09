// Keep weather popups inside the map and below its fixed category bar.
(function(root){
  function popupPanOffset(rect,safe){
    const x=rect.left<safe.left?rect.left-safe.left:rect.right>safe.right?rect.right-safe.right:0;
    // If a popup is taller than the available space, prioritize its heading.
    const y=rect.top<safe.top?rect.top-safe.top:rect.bottom>safe.bottom?rect.bottom-safe.bottom:0;
    return [Math.abs(x)>2?x:0,Math.abs(y)>2?y:0];
  }
  if(typeof module!=='undefined')module.exports={popupPanOffset};
  if(typeof map==='undefined'||typeof document==='undefined')return;
  let active=null,frame=null;
  const original=new WeakMap();
  function schedule(){
    if(frame!==null)cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(adjust);});
  }
  function adjust(){
    frame=null;
    const popup=active,el=popup?.getElement();if(!el?.isConnected)return;
    const container=map.getContainer().getBoundingClientRect(),viewport=root.visualViewport;
    const safe={left:Math.max(container.left,viewport?.offsetLeft||0)+12,
      right:Math.min(container.right,(viewport?.offsetLeft||0)+(viewport?.width||root.innerWidth))-12,
      top:Math.max(container.top,viewport?.offsetTop||0)+12,
      bottom:Math.min(container.bottom,(viewport?.offsetTop||0)+(viewport?.height||root.innerHeight))-12};
    const rect=el.getBoundingClientRect(),bar=document.querySelector('.topbar');
    if(bar){const b=bar.getBoundingClientRect();if(rect.right>b.left&&rect.left<b.right)safe.top=Math.max(safe.top,b.bottom+12);}
    if(!original.has(popup))original.set(popup,{maxHeight:popup.options.maxHeight,maxWidth:popup.options.maxWidth});
    const base=original.get(popup),height=Math.max(40,Math.floor(safe.bottom-safe.top-70));
    const width=Math.max(100,Math.floor(safe.right-safe.left-40));
    const maxHeight=Math.min(base.maxHeight||Infinity,height),maxWidth=Math.min(base.maxWidth||300,width);
    if(popup.options.maxHeight!==maxHeight||popup.options.maxWidth!==maxWidth){
      popup.options.maxHeight=maxHeight;popup.options.maxWidth=maxWidth;popup.update();schedule();return;
    }
    const offset=popupPanOffset(el.getBoundingClientRect(),safe);
    if(offset[0]||offset[1])map.panBy(offset,{animate:!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches,duration:.25});
  }
  map.on('popupopen',event=>{
    active?.off('contentupdate',schedule);active=event.popup;
    active.on('contentupdate',schedule);schedule();
  });
  map.on('popupclose',event=>{
    if(event.popup!==active)return;active.off('contentupdate',schedule);active=null;
    if(frame!==null)cancelAnimationFrame(frame);frame=null;
  });
  map.on('resize',schedule);
  root.visualViewport?.addEventListener('resize',schedule);
})(typeof window!=='undefined'?window:globalThis);
