from pathlib import Path

p=Path('js/temperature.js')
text=p.read_text()

old="""function temperatureCorrectionIndex(corrections){
  const index=new Map();
  for(const correction of corrections){
    const key=Math.floor(correction.lat)+'/'+Math.floor(correction.lon);
    if(!index.has(key)) index.set(key,[]);
    index.get(key).push(correction);
  }
  return index;
}

function temperatureNearbyCorrections(index,lat,lon){
  const out=[];
  const y=Math.floor(lat),x=Math.floor(lon);
  for(let dy=-1;dy<=1;dy++){
    for(let dx=-3;dx<=3;dx++){
      const rows=index.get((y+dy)+'/'+(x+dx));
      if(rows) out.push(...rows);
    }
  }
  return out;
}

function temperatureAdjustedValue(model,lat,lon,corrections){
  let sum=0,total=0;
  for(const correction of corrections){
    const distance=temperatureObservationDistanceKm(lat,lon,correction.lat,correction.lon);
    if(distance>=TEMP_OBS_RADIUS_KM) continue;
    const x=distance/TEMP_OBS_RADIUS_KM;
    const spatial=1-(3*x*x-2*x*x*x);
    const weight=spatial*correction.ageWeight;
    sum+=correction.bias*weight;
    total+=weight;
  }
  if(total<=0) return model;
  const blend=Math.min(1,total);
  return model+(sum/total)*blend;
}
"""
new="""function buildTemperatureCorrectionRaster(region,W,H,corrections,latValues,lonValues){
  const weightedBias=new Float32Array(W*H);
  const weightTotal=new Float32Array(W*H);
  if(!corrections.length) return {weightedBias,weightTotal};

  const south=region.bounds[0][0],west=region.bounds[0][1];
  const north=region.bounds[1][0],east=region.bounds[1][1];

  for(const correction of corrections){
    if(correction.lat<TEMP_REGIONS[0]?.bounds?.[0]?.[0]-20) continue;
    const latPad=TEMP_OBS_RADIUS_KM/111;
    const cosLat=Math.max(0.18,Math.cos(correction.lat*Math.PI/180));
    const lonPad=TEMP_OBS_RADIUS_KM/(111*cosLat);
    if(correction.lat+latPad<south || correction.lat-latPad>north ||
       correction.lon+lonPad<west || correction.lon-lonPad>east) continue;

    const x0=Math.max(0,Math.floor(((correction.lon-lonPad-west)/(east-west))*(W-1)));
    const x1=Math.min(W-1,Math.ceil(((correction.lon+lonPad-west)/(east-west))*(W-1)));
    const yA=rasterYForLatitude(region,correction.lat+latPad,H);
    const yB=rasterYForLatitude(region,correction.lat-latPad,H);
    const y0=Math.max(0,Math.floor(Math.min(yA,yB)));
    const y1=Math.min(H-1,Math.ceil(Math.max(yA,yB)));

    for(let y=y0;y<=y1;y++){
      const lat=latValues[y];
      const row=y*W;
      for(let x=x0;x<=x1;x++){
        const distance=temperatureObservationDistanceKm(lat,lonValues[x],correction.lat,correction.lon);
        if(distance>=TEMP_OBS_RADIUS_KM) continue;
        const f=distance/TEMP_OBS_RADIUS_KM;
        const spatial=1-(3*f*f-2*f*f*f);
        const weight=spatial*correction.ageWeight;
        const i=row+x;
        weightedBias[i]+=correction.bias*weight;
        weightTotal[i]+=weight;
      }
    }
  }
  return {weightedBias,weightTotal};
}

function temperatureAdjustedFromRaster(model,index,weightedBias,weightTotal){
  const total=weightTotal[index];
  if(total<=0) return model;
  const blend=Math.min(1,total);
  return model+(weightedBias[index]/total)*blend;
}
"""
if old not in text:
    raise SystemExit('old correction helper block missing')
text=text.replace(old,new,1)

text=text.replace("  const correctionIndex=temperatureCorrectionIndex(corrections);\n","")

old="""    // Longitude coordinate and bracket are identical for every row, so calculate them once.
    const lonValues=Array.from({length:W},(_,x)=>west+(x/(W-1))*(east-west));
    const lonLookup=lonValues.map(lon=>axisBracket(spec.longitudes,lon));

    for(let y=0;y<H;y++){
      if(token!==temperatureRenderToken) return null;

      const lat=rasterLatitudeForRow(region,y,H);
      const latB=axisBracket(spec.latitudes,lat);
"""
new="""    // Pixel coordinates and model brackets are fixed for this raster.
    const lonValues=Array.from({length:W},(_,x)=>west+(x/(W-1))*(east-west));
    const lonLookup=lonValues.map(lon=>axisBracket(spec.longitudes,lon));
    const latValues=Array.from({length:H},(_,y)=>rasterLatitudeForRow(region,y,H));
    const latLookup=latValues.map(lat=>axisBracket(spec.latitudes,lat));
    const correctionRaster=buildTemperatureCorrectionRaster(region,W,H,corrections,latValues,lonValues);

    for(let y=0;y<H;y++){
      if(token!==temperatureRenderToken) return null;

      const latB=latLookup[y];
"""
if old not in text:
    raise SystemExit('coordinate lookup block missing')
text=text.replace(old,new,1)

old="""        if(corrections.length){
          const nearby=temperatureNearbyCorrections(correctionIndex,lat,lonValues[x]);
          if(nearby.length) value=temperatureAdjustedValue(value,lat,lonValues[x],nearby);
        }
"""
new="""        if(corrections.length){
          const pixelIndex=y*W+x;
          value=temperatureAdjustedFromRaster(
            value,pixelIndex,correctionRaster.weightedBias,correctionRaster.weightTotal
          );
        }
"""
if old not in text:
    raise SystemExit('per-pixel correction block missing')
text=text.replace(old,new,1)

text=text.replace("      // Yield only a few times; the new renderer is much cheaper than v7.7.\n      if(y%40===0) await new Promise(requestAnimationFrame);",
                  "      // Keep the UI responsive while large rasters are generated.\n      if(y%64===0) await new Promise(requestAnimationFrame);")

p.write_text(text)

p=Path('index.html')
html=p.read_text()
for old,new in [
 ('<title>Northern Weather Map v8.68</title>','<title>Northern Weather Map v8.69</title>'),
 ('js/temperature.js?v=8.68','js/temperature.js?v=8.69')
]:
    if old not in html:
        raise SystemExit('index marker missing: '+old)
    html=html.replace(old,new,1)
p.write_text(html)
