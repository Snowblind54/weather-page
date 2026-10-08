// Draw the visible crop, rather than scaling a whole-country filtered surface
// to hundreds of thousands of CSS pixels at close zooms (especially on iOS).
function radarViewportLayer(frame,opacity=.84,filter=''){
  const Layer=L.Layer.extend({
    onAdd(map){
      this._map=map;this._canvas=document.createElement('canvas');
      this._canvas.className='leaflet-image-layer leaflet-zoom-hide';
      Object.assign(this._canvas.style,{position:'absolute',pointerEvents:'none',opacity:String(opacity),filter});
      Object.assign(this._canvas.dataset,frame.canvas?.dataset||{});
      this._canvas.dataset.radarViewport='true';
      map.getPane('overlayPane').appendChild(this._canvas);
      map.on('move zoom viewreset moveend resize',this._reset,this);this._reset();
    },
    onRemove(map){
      map.off('move zoom viewreset moveend resize',this._reset,this);
      this._canvas.remove();this._canvas.width=this._canvas.height=0;
    },
    _reset(){
      const size=this._map.getSize(),light=typeof radarLightMode==='function'&&radarLightMode();
      const scale=Math.min(1,(light?1536:4096)/Math.max(1,size.x,size.y));
      const width=Math.max(1,Math.ceil(size.x*scale)),height=Math.max(1,Math.ceil(size.y*scale));
      if(this._canvas.width!==width||this._canvas.height!==height){this._canvas.width=width;this._canvas.height=height;}
      this._canvas.style.width=size.x+'px';this._canvas.style.height=size.y+'px';
      L.DomUtil.setPosition(this._canvas,this._map.containerPointToLayerPoint(L.point(0,0)));
      this._bounds=this._map.getBounds();
      const context=this._canvas.getContext('2d');context.clearRect(0,0,width,height);
      const image=frame.canvas||frame.image,iw=image?.naturalWidth||image?.width,ih=image?.naturalHeight||image?.height;
      if(iw&&ih){
        const bounds=L.latLngBounds(frame.bounds),top=this._map.latLngToContainerPoint(bounds.getNorthWest()),bottom=this._map.latLngToContainerPoint(bounds.getSouthEast());
        const fullWidth=bottom.x-top.x,fullHeight=bottom.y-top.y;
        const left=Math.max(0,top.x),upper=Math.max(0,top.y),right=Math.min(size.x,bottom.x),lower=Math.min(size.y,bottom.y);
        if(fullWidth>0&&fullHeight>0&&right>left&&lower>upper){
          context.drawImage(image,(left-top.x)/fullWidth*iw,(upper-top.y)/fullHeight*ih,
            (right-left)/fullWidth*iw,(lower-upper)/fullHeight*ih,
            left*scale,upper*scale,(right-left)*scale,(lower-upper)*scale);
        }
      }
      // Masks use the displayed viewport bounds, preserving coastline seams.
      if(typeof queueEstoniaRadarPrioritySync==='function')queueEstoniaRadarPrioritySync();
    },
    getBounds(){return this._bounds||L.latLngBounds(frame.bounds);},
    getElement(){return this._canvas;},
    setOpacity(value){this._canvas.style.opacity=String(value);return this;},
    bringToFront(){this._canvas.parentNode?.appendChild(this._canvas);return this;}
  });return new Layer();
}
function radarImageOverlay(image,bounds,options={}){
  if(!(typeof radarLightMode==='function'&&radarLightMode()))return L.imageOverlay(image,bounds,options);
  if(typeof image!=='string')return radarViewportLayer({image,bounds},options.opacity??1);
  const element=new Image();element.decoding='async';
  const layer=radarViewportLayer({image:element,bounds},options.opacity??1);
  element.onload=()=>{if(layer._map&&layer._canvas?.width)layer._reset();};
  element.src=image;return layer;
}
