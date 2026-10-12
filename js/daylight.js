// Live day/night shading is calculated locally; it never loads a data snapshot.
(function(){
  'use strict';
  const toggle=$('daylightOn'),status=$('daylightStatus'),math=window.NorthernDaylightMath;
  if(!toggle||!math||typeof map==='undefined')return;
  let layer=null,popup=null,point=null;
  map.createPane('daylightPane');
  Object.assign(map.getPane('daylightPane').style,{zIndex:'455',pointerEvents:'none'});
  const DaylightLayer=L.Layer.extend({
    onAdd(map){
      this._map=map;this._canvas=document.createElement('canvas');
      this._canvas.className='leaflet-layer leaflet-zoom-hide daylight-canvas';
      Object.assign(this._canvas.style,{position:'absolute',pointerEvents:'none'});
      map.getPane('daylightPane').appendChild(this._canvas);
      map.on('move zoom viewreset resize',this._schedule,this);this._paint();
    },
    onRemove(map){
      map.off('move zoom viewreset resize',this._schedule,this);
      cancelAnimationFrame(this._pending);this._canvas.remove();this._canvas.width=this._canvas.height=0;
    },
    _schedule(){
      if(this._pending)return;
      this._pending=requestAnimationFrame(()=>{this._pending=null;if(this._canvas.width)this._paint();});
    },
    _paint(){
      const size=this._map.getSize(),scale=Math.min(1,480/Math.max(size.x,size.y));
      const w=Math.max(1,Math.ceil(size.x*scale)),h=Math.max(1,Math.ceil(size.y*scale));
      this._canvas.width=w;this._canvas.height=h;
      this._canvas.style.width=size.x+'px';this._canvas.style.height=size.y+'px';
      L.DomUtil.setPosition(this._canvas,this._map.containerPointToLayerPoint(L.point(0,0)));
      const vector=math.solarVector(new Date()),ctx=this._canvas.getContext('2d'),image=ctx.createImageData(w,h);
      const lons=Array.from({length:w},(_,x)=>this._map.containerPointToLatLng(L.point((x+.5)*size.x/w,0)).lng);
      for(let y=0;y<h;y++){
        const lat=this._map.containerPointToLatLng(L.point(0,(y+.5)*size.y/h)).lat;
        for(let x=0;x<w;x++)image.data.set(math.colour(math.elevation(vector,lat,lons[x])),(y*w+x)*4);
      }
      ctx.putImageData(image,0,0);
    }
  });
  function popupContent(location,now=new Date()){
    const lat=location.lat,lon=math.longitude(location.lng),events=math.nextEvents(now,lat,lon);
    const current=math.state(math.elevation(math.solarVector(now),lat,lon));
    const formatter=new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'});
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const time=value=>value?formatter.format(value):'No event found in the next year';
    const polar=events.polar?'<p class="sun-polar">'+(current==='Daylight'?'Polar day — the sun stays above the horizon today.':'Polar night — the sun does not rise today.')+'</p>':'';
    return '<div class="sun-popup"><strong>Sunrise &amp; sunset</strong><p>'+lat.toFixed(3)+'°, '+lon.toFixed(3)+'° · '+current+' now</p>'+polar+
      '<div class="sun-events"><div><span>Next sunset</span><b>'+time(events.sunset)+'</b></div><div><span>Next sunrise</span><b>'+time(events.sunrise)+'</b></div></div>'+
      '<small>Times in '+zone+'. Estimated for a clear, level horizon; terrain and clouds can change what you see.</small></div>';
  }
  function showPopup(location){
    point=location;
    if(!popup)popup=L.popup({maxWidth:350,className:'sun-popup-container',autoPan:false,keepInView:false});
    popup.setLatLng(location).setContent(popupContent(location)).openOn(map);
  }
  function refresh(){
    if(!toggle.checked||document.hidden)return;
    layer?._paint();
    status.textContent='Live day/night boundary · updated '+new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
    if(popup&&point&&map.hasLayer(popup))popup.setContent(popupContent(point));
  }
  toggle.addEventListener('change',()=>{
    if(toggle.checked){if(!layer)layer=new DaylightLayer().addTo(map);refresh();}
    else{if(layer)map.removeLayer(layer);layer=null;if(popup&&map.hasLayer(popup))map.removeLayer(popup);point=null;status.textContent='Daylight / night layer is off.';}
  });
  // While enabled, a map tap has a single purpose even over another weather
  // layer. Controls and popup buttons retain their normal interaction.
  map.getContainer().addEventListener('click',event=>{
    if(!toggle.checked||event.target.closest('.leaflet-control,.leaflet-popup')||(!event.detail&&!event.clientX&&!event.clientY))return;
    event.stopPropagation();showPopup(map.mouseEventToLatLng(event));
  },true);
  document.addEventListener('visibilitychange',refresh);
  setInterval(refresh,60000);
})();
