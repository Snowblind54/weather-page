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
      pane.appendChild(this._canvas);m.on('move zoom viewreset resize',schedule);this.paint();
    },
    onRemove(m){m.off('move zoom viewreset resize',schedule);this._canvas.remove();this._canvas.width=this._canvas.height=0;this._map=null;},
    paint(){
      if(!this._map)return;
      const size=map.getSize(),scale=Math.min(1,1600/Math.max(size.x,size.y));
      const width=Math.ceil(size.x*scale),height=Math.ceil(size.y*scale);
      if(this._canvas.width!==width||this._canvas.height!==height){this._canvas.width=width;this._canvas.height=height;}
      this._canvas.style.width=size.x+'px';this._canvas.style.height=size.y+'px';
      L.DomUtil.setPosition(this._canvas,map.containerPointToLayerPoint(L.point(0,0)));
      const ctx=this._canvas.getContext('2d');ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,size.x,size.y);
      const entries=[];warningLayerGroup.eachLayer(layer=>paths(layer,entries));entries.sort((a,b)=>a.rank-b.rank);
      for(const {layer,color} of entries){
        ctx.fillStyle=color;
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
        layer.bringToFront();
      }
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
