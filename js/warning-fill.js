// Paint warning fills opaquely in severity order, then apply transparency once
// to their shared pane. Overlapping alerts cannot multiply the fill opacity.
(()=>{
  const pane=map.createPane('warningFillPane');
  pane.style.zIndex=String(Number(map.getPane('warningPane').style.zIndex)-1);
  pane.style.opacity='.22';
  pane.style.pointerEvents='none';
  const renderer=L.svg({pane:'warningFillPane'});
  const fills=L.layerGroup();
  let pending=false;

  function paths(layer,record,result){
    record=layer.warningRecord||record;
    if(layer instanceof L.Polygon){
      // Outline-only marine warnings remain outline-only.
      if(layer.options.fill===false) return;
      const color=layer.options.fillColor||layer.options.color;
      const rank=color==='#e03131'?3:color==='#ff8c1a'?2:color==='#8dabc4'?0:1;
      result.push({layer,record,color,rank});
      layer.setStyle({fillOpacity:0});
    }else if(layer.eachLayer){
      layer.eachLayer(child=>paths(child,record,result));
    }
  }

  function rebuild(){
    pending=false;
    fills.clearLayers();
    if(!map.hasLayer(warningLayerGroup)){
      map.removeLayer(fills);
      return;
    }
    const entries=[];
    warningLayerGroup.eachLayer(layer=>paths(layer,null,entries));
    entries.sort((a,b)=>a.rank-b.rank);
    for(const entry of entries){
      L.geoJSON(entry.layer.toGeoJSON(),{
        pane:'warningFillPane',renderer,interactive:false,
        style:{stroke:false,fill:true,fillColor:entry.color,fillOpacity:1,fillRule:'evenodd'}
      }).addTo(fills);
      // Keep the most severe original popup above lower-level overlays.
      entry.layer.bringToFront();
    }
    fills.addTo(map);
  }

  function schedule(){
    if(pending) return;
    pending=true;
    requestAnimationFrame(rebuild);
  }

  for(const method of ['addLayer','removeLayer','clearLayers']){
    const original=warningLayerGroup[method];
    warningLayerGroup[method]=function(...args){
      if(method==='addLayer') paths(args[0],null,[]);
      const result=original.apply(this,args);
      schedule();
      return result;
    };
  }
  warningLayerGroup.on('add',schedule);
  warningLayerGroup.on('remove',()=>map.removeLayer(fills));
  schedule();
})();
