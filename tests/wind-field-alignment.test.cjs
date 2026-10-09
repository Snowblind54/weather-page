const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('js/wind.js','utf8');

test('world-zoom field reaches the equator at the same screen position as particles, including a viewport beyond the pole',()=>{
  for(const originY of [-155,0,200]){
    const worldSize=1024,size={x:300,y:936};let raster,destination;
    const unproject=({x,y})=>({lat:Math.atan(Math.sinh(Math.PI*(1-2*y/worldSize)))*180/Math.PI,lng:x/worldSize*360-180});
    const map={getSize:()=>size,getZoom:()=>2,getPixelBounds:()=>({min:{x:0,y:originY}}),
      containerPointToLayerPoint:()=>[0,0],containerPointToLatLng:([x,y])=>unproject({x,y:y+originY}),
      // Real Mercator projection clamps near the poles; the round trip loses
      // negative world pixels and used to shift the entire coloured field.
      project:ll=>({x:(ll.lng+180)/360*worldSize,y:worldSize*(1-Math.asinh(Math.tan(Math.max(-85.0511287798,Math.min(85.0511287798,ll.lat))*Math.PI/180))/Math.PI)/2}),
      unproject};
    const ctx={clearRect(){},save(){},restore(){},drawImage(...args){destination=args;}};
    const lowCtx={createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{raster=image;}};
    const c={console,Math,Number,Object,Array,Date,Map,windData:{},windTimeSlice:()=>({i:0,f:0}),
      windAt:lat=>lat>=0&&lat<=84?[3,4]:null,windGustAt:()=>8,windColourIndex:()=>0,
      WIND_COLOUR_PALETTES:{sustained:['#45dfac']},windHeatmapCorrections:()=>[],windHeatmapCorrectionIndex:()=>({count:0}),windHeatmapNearbyCorrections:()=>[],
      $:id=>id==='windHeatmapOpacity'?{value:'50'}:{},fmt:()=>'',globalThis:{},
      document:{createElement:()=>({getContext:()=>lowCtx})},L:{Layer:{extend:m=>m},DomUtil:{setPosition(){}},point:(x,y)=>({x,y})}};
    vm.createContext(c);vm.runInContext(source.slice(source.indexOf('const WindHeatmapLayer='),source.indexOf('function hideWindHeatmap')),c);
    const layer=vm.runInContext('Object.create(WindHeatmapLayer)',c);Object.assign(layer,{_map:map,ctx,canvas:{style:{}},mode:'sustained',unix:100});layer.reset();
    let last=-1;
    for(let y=0;y<raster.height;y++)if(raster.data[(y*raster.width+1)*4+3]>0)last=y;
    const [, , , , ,dx,dy,dw,dh]=destination,step=dh/raster.height;
    const lastPaintedCentre=dy+(last+.5)*step;
    const equatorOnScreen=worldSize/2-originY;
    assert(Math.abs(lastPaintedCentre-equatorOnScreen)<=step,`${originY}: field ended at ${lastPaintedCentre}, equator at ${equatorOnScreen}`);
  }
});
