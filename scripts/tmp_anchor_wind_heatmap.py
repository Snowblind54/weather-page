from pathlib import Path
import re

wind_path = Path('js/wind.js')
text = wind_path.read_text()
pattern = re.compile(r"    const step=area>=1500000\?32:area>=900000\?28:24;\n    const cols=Math\.ceil\(size\.x/step\)\+1,rows=Math\.ceil\(size\.y/step\)\+1;\n    const low=document\.createElement\('canvas'\);low\.width=cols;low\.height=rows;\n    const lowCtx=low\.getContext\('2d'\),img=lowCtx\.createImageData\(cols,rows\),palette=WIND_COLOUR_PALETTES\[this\.mode\];\n    const rgb=palette\.map\(hex=>\[parseInt\(hex\.slice\(1,3\),16\),parseInt\(hex\.slice\(3,5\),16\),parseInt\(hex\.slice\(5,7\),16\)\]\);\n    const corrections=windHeatmapCorrections\(this\.unix,slice,this\.mode\);\n    const correctionIndex=windHeatmapCorrectionIndex\(corrections\);\n    let shown=0;\n    for\(let row=0;row<rows;row\+\+\)for\(let col=0;col<cols;col\+\+\)\{\n      const x=Math\.min\(size\.x,col\*step\),y=Math\.min\(size\.y,row\*step\),ll=this\._map\.containerPointToLatLng\(\[x,y\]\);\n      const vector=windAt\(ll\.lat,ll\.lng,slice\);\n      let speed=null;\n      if\(vector\) speed=this\.mode==='gust'\?windGustAt\(ll\.lat,ll\.lng,slice\):Math\.hypot\(vector\[0\],vector\[1\]\);\n      if\(!Number\.isFinite\(speed\)\)continue;\n      const nearby=windHeatmapNearbyCorrections\(correctionIndex,ll\.lat,ll\.lng\);\n      if\(nearby\.length&&globalThis\.WindObservationBlend\) speed=globalThis\.WindObservationBlend\.adjustSpeed\(speed,ll\.lat,ll\.lng,nearby\);\n      const c=rgb\[windColourIndex\(speed\)\],i=\(row\*cols\+col\)\*4;\n      img\.data\[i\]=c\[0\];img\.data\[i\+1\]=c\[1\];img\.data\[i\+2\]=c\[2\];img\.data\[i\+3\]=230;shown\+\+;\n    \}\n    lowCtx\.putImageData\(img,0,0\);\n    this\.ctx\.clearRect\(0,0,size\.x,size\.y\);\n    this\.ctx\.imageSmoothingEnabled=true;this\.ctx\.imageSmoothingQuality='high';\n    this\.ctx\.drawImage\(low,0,0,cols,rows,0,0,size\.x,size\.y\);")
replacement = """    const step=area>=1500000?32:area>=900000?28:24;
    // Anchor samples to fixed Web-Mercator world pixels instead of the viewport.
    // Panning now reveals the same wind field rather than resampling at new
    // geographic points every time the screen origin changes.
    const zoom=this._map.getZoom();
    const topLeft=this._map.project(this._map.containerPointToLatLng([0,0]),zoom);
    const anchorX=Math.floor(topLeft.x/step)*step,anchorY=Math.floor(topLeft.y/step)*step;
    const startX=anchorX-topLeft.x,startY=anchorY-topLeft.y;
    const cols=Math.ceil((size.x-startX)/step)+2,rows=Math.ceil((size.y-startY)/step)+2;
    const low=document.createElement('canvas');low.width=cols;low.height=rows;
    const lowCtx=low.getContext('2d'),img=lowCtx.createImageData(cols,rows),palette=WIND_COLOUR_PALETTES[this.mode];
    const rgb=palette.map(hex=>[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]);
    const corrections=windHeatmapCorrections(this.unix,slice,this.mode);
    const correctionIndex=windHeatmapCorrectionIndex(corrections);
    let shown=0;
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const world=L.point(anchorX+col*step,anchorY+row*step),ll=this._map.unproject(world,zoom);
      const vector=windAt(ll.lat,ll.lng,slice);
      let speed=null;
      if(vector) speed=this.mode==='gust'?windGustAt(ll.lat,ll.lng,slice):Math.hypot(vector[0],vector[1]);
      if(!Number.isFinite(speed))continue;
      const nearby=windHeatmapNearbyCorrections(correctionIndex,ll.lat,ll.lng);
      if(nearby.length&&globalThis.WindObservationBlend) speed=globalThis.WindObservationBlend.adjustSpeed(speed,ll.lat,ll.lng,nearby);
      const c=rgb[windColourIndex(speed)],i=(row*cols+col)*4;
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=230;shown++;
    }
    lowCtx.putImageData(img,0,0);
    this.ctx.clearRect(0,0,size.x,size.y);
    this.ctx.imageSmoothingEnabled=true;this.ctx.imageSmoothingQuality='high';
    // Source pixel centres line up with the anchored sample coordinates.
    this.ctx.drawImage(low,0,0,cols,rows,startX-step/2,startY-step/2,cols*step,rows*step);"""
new_text, count = pattern.subn(replacement, text)
if count != 1:
    raise SystemExit(f'Expected one heatmap sampling block, found {count}')
wind_path.write_text(new_text)

index_path = Path('index.html')
index = index_path.read_text()
for old, new in [
    ('<title>Northern Weather Map v8.65</title>', '<title>Northern Weather Map v8.66</title>'),
    ('<script src="js/wind.js?v=8.65"></script>', '<script src="js/wind.js?v=8.66"></script>'),
]:
    if old not in index:
        raise SystemExit(f'Missing expected index marker: {old}')
    index = index.replace(old, new, 1)
index_path.write_text(index)
