// One lightweight group per alert; only visible polygons become Leaflet paths.
(function(){
  'use strict';
  const G=window.NorthernWarningGeometry;if(!G||typeof map==='undefined')return;
  const active=new Set(),listeners=new Set();let scheduled=false;
  // All warning boundaries share one canvas instead of thousands of SVG paths.
  const renderer=L.canvas?.({pane:'warningPane',padding:.05,tolerance:4});
  const batchSize=64;
  const notify=()=>listeners.forEach(f=>f());
  const viewport=()=>{const b=map.getBounds().pad(.15);return {west:b.getWest(),east:b.getEast(),south:b.getSouth(),north:b.getNorth()};};
  const WarningGroup=L.FeatureGroup.extend({
    initialize(descriptors,options,circle=null){
      L.FeatureGroup.prototype.initialize.call(this,[]);
      this._descriptors=descriptors;this._warningOptions=options;this._circleSource=circle;this._viewKey=null;this._visibleDescriptors=[];this._revision=0;
    },
    bindPopup(content,options){this._warningContent=content;this._warningPopupOptions=options;return this;},
    onAdd(m){L.FeatureGroup.prototype.onAdd.call(this,m);this._warningMap=m;active.add(this);this._update();},
    onRemove(m){this._revision++;active.delete(this);L.FeatureGroup.prototype.onRemove.call(this,m);this.clearLayers();for(const d of this._visibleDescriptors)d.cache?.clear();this._visibleDescriptors=[];this._viewKey=null;this._warningMap=null;if(!active.size&&renderer&&map.hasLayer?.(renderer))map.removeLayer(renderer);if(this._warningPopup)m.closePopup(this._warningPopup);notify();},
    _update(){
      if(!this._warningMap)return;
      const zoom=Math.floor(map.getZoom()),centre=map.getCenter().lng,v=viewport();
      const visible=[],keys=[];
      for(let i=0;i<this._descriptors.length;i++){const d=this._descriptors[i];if(G.intersects(d.bounds,v)){visible.push(d);keys.push(i+'@'+G.worldShift(d.bounds,centre));}}
      const key=zoom+':'+keys.join(',');
      if(key===this._viewKey)return;this._viewKey=key;const revision=++this._revision;this.clearLayers();
      const keep=new Set(visible);for(const d of this._visibleDescriptors)if(!keep.has(d))d.cache?.clear();this._visibleDescriptors=visible;
      if(visible.length){
        const style=this._warningOptions.style||this._warningOptions;
        const options={...style,...this._warningOptions,pane:'warningPane',smoothFactor:.5,...(renderer?{renderer}:{})};delete options.style;if(options.fill!==false)options.fillOpacity=0;
        const addBatch=offset=>{
          if(!this._warningMap||revision!==this._revision)return;
          const parts=visible.slice(offset,offset+batchSize);
          const child=this._circleSource?L.circle([this._circleSource[0],this._circleSource[1]+G.worldShift(visible[0].bounds,centre)],options):L.polygon(parts.map(d=>G.simplified(d,zoom,centre)),options);
          child.warningRecord=this.warningRecord;
          child.bindPopup(()=>typeof this._warningContent==='function'?this._warningContent(child):this._warningContent,this._warningPopupOptions);
          this.addLayer(child);notify();
          if(!this._circleSource&&offset+batchSize<visible.length)requestAnimationFrame(()=>addBatch(offset+batchSize));
        };
        addBatch(0);
      }
      notify();
    },
    getBounds(){
      const bounds=L.latLngBounds([]),centre=map.getCenter().lng;
      for(const d of this._descriptors){const b=d.bounds,shift=G.worldShift(b,centre);bounds.extend([b.south,b.west+shift]);bounds.extend([b.north,b.east+shift]);}
      return bounds;
    },
    openPopup(){
      const bounds=this.getBounds();if(!bounds.isValid())return this;
      const content=typeof this._warningContent==='function'?this._warningContent(this):this._warningContent;
      this._warningPopup=L.popup(this._warningPopupOptions).setLatLng(bounds.getCenter()).setContent(content).openOn(map);return this;
    },
    bringToFront(){this.eachLayer(layer=>layer.bringToFront?.());notify();return this;}
  });
  function schedule(){
    if(scheduled)return;scheduled=true;
    requestAnimationFrame(()=>{scheduled=false;const groups=[...active];let i=0;const step=()=>{const end=Math.min(i+16,groups.length);for(;i<end;i++)if(active.has(groups[i]))groups[i]._update();notify();if(i<groups.length)requestAnimationFrame(step);};step();});
  }
  map.on('moveend zoomend resize',schedule);
  window.NorthernWarningViewport={
    polygons:(polygons,options)=>new WarningGroup(G.cap(polygons),options),
    geoJSON:(feature,options)=>new WarningGroup(G.geojson(feature),options),
    circle:(centre,options)=>{
      const dy=options.radius/111200,dx=dy/Math.max(.01,Math.cos(centre[0]*Math.PI/180));
      return new WarningGroup([{bounds:{south:centre[0]-dy,north:centre[0]+dy,west:centre[1]-dx,east:centre[1]+dx}}],options,centre);
    },
    onChange:fn=>listeners.add(fn),refresh:schedule
  };
})();
