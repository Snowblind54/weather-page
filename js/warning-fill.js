// Opaque fills use existing visible Leaflet geometry; transparency is applied once.
(()=>{
  const pane=map.createPane('warningFillPane');
  pane.style.zIndex=String(Number(map.getPane('warningPane').style.zIndex)-1);
  pane.style.opacity='.22';pane.style.pointerEvents='none';
  let pending=false;
  function paths(layer,result){
    if(layer instanceof L.Polygon||layer instanceof L.Circle){
      if(layer.options.fill===false)return;
      const color=layer.options.fillColor||layer.options.color;
      const rank=color==='#e03131'?3:color==='#ff8c1a'?2:color==='#8dabc4'?0:1;
      result.push({layer,color,rank});
      if(layer.options.fillOpacity!==0)layer.setStyle({fillOpacity:0});
    }else if(layer.eachLayer)layer.eachLayer(child=>paths(child,result));
  }
  function polygons(latlngs){
    if(!latlngs.length)return [];
    if(latlngs[0]?.lat!==undefined)return [[latlngs]];
    if(latlngs[0]?.[0]?.lat!==undefined)return [latlngs];
    return latlngs.flatMap(polygons);
  }
  const FillCanvas=L.Layer.extend({
    onAdd(m){
      this._map=m;this._canvas=document.createElement('canvas');
      this._canvas.className='leaflet-layer leaflet-zoom-hide';
      Object.assign(this._canvas.style,{position:'absolute',pointerEvents:'none'});
      pane.appendChild(this._canvas);m.on('moveend zoomend viewreset resize',schedule);this.paint();
    },
    onRemove(m){this._ordered=null;this._generation=(this._generation||0)+1;if(this._buffer){this._buffer.width=this._buffer.height=0;this._buffer=null;}m.off('moveend zoomend viewreset resize',schedule);this._canvas.remove();this._canvas.width=this._canvas.height=0;this._map=null;},
    paint(){
      if(!this._map)return;
      const size=map.getSize(),scale=Math.min(1,1600/Math.max(size.x,size.y));
      const width=Math.ceil(size.x*scale),height=Math.ceil(size.y*scale);
      if(this._canvas.width!==width||this._canvas.height!==height){this._canvas.width=width;this._canvas.height=height;}
      this._canvas.style.width=size.x+'px';this._canvas.style.height=size.y+'px';
      L.DomUtil.setPosition(this._canvas,map.containerPointToLayerPoint(L.point(0,0)));
      const generation=this._generation=(this._generation||0)+1;
      const entries=[];warningLayerGroup.eachLayer(layer=>paths(layer,entries));entries.sort((a,b)=>a.rank-b.rank);
      // Reorder outlines only when paths change, not on every map movement.
      if(!this._ordered||this._ordered.length!==entries.length||entries.some((e,i)=>e.layer!==this._ordered[i])){
        this._ordered=entries.map(e=>e.layer);for(const {layer} of entries)layer.bringToFront();
      }
      // Large fills are painted in short batches, then swapped in together.
      const target=entries.length>64?(this._buffer||(this._buffer=document.createElement('canvas'))):this._canvas;
      if(target.width!==width||target.height!==height){target.width=width;target.height=height;}
      const ctx=target.getContext('2d');ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,size.x,size.y);
      let index=0;
      const draw=()=>{
        if(!this._map||generation!==this._generation)return;
        const start=Date.now();let count=0;
        while(index<entries.length&&(count===0||(count<16&&Date.now()-start<8))){
          const {layer,color}=entries[index++];count++;ctx.fillStyle=color;
          if(layer instanceof L.Circle){
            if(!layer._point||!Number.isFinite(layer._radius))continue;
            const p=map.layerPointToContainerPoint(layer._point);ctx.beginPath();ctx.ellipse(p.x,p.y,layer._radius,layer._radiusY||layer._radius,0,0,Math.PI*2);ctx.fill();
          }else{
            for(const polygon of polygons(layer.getLatLngs())){
              ctx.beginPath();
              for(const ring of polygon){for(let i=0;i<ring.length;i++){const p=map.latLngToContainerPoint(ring[i]);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.closePath();}
              ctx.fill('evenodd');
            }
          }
        }
        if(index<entries.length){requestAnimationFrame(draw);return;}
        if(target!==this._canvas){const front=this._canvas.getContext('2d');front.setTransform(1,0,0,1,0,0);front.clearRect(0,0,width,height);front.drawImage(target,0,0);}
      };
      draw();
    }
  });
  const canvas=new FillCanvas();
  function schedule(){
    if(pending)return;pending=true;
    requestAnimationFrame(()=>{pending=false;if(!map.hasLayer(warningLayerGroup)){if(map.hasLayer(canvas))map.removeLayer(canvas);return;}if(!map.hasLayer(canvas))canvas.addTo(map);else canvas.paint();});
  }
  for(const method of ['addLayer','removeLayer','clearLayers']){
    const original=warningLayerGroup[method];warningLayerGroup[method]=function(...args){const result=original.apply(this,args);schedule();return result;};
  }
  warningLayerGroup.on('add remove',schedule);
  window.NorthernWarningViewport?.onChange(schedule);
  schedule();
})();
