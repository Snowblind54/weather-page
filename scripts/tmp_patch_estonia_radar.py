from pathlib import Path

path=Path('js/radar-images.js')
text=path.read_text(encoding='utf-8')
marker="function radarLatitudeAtY(value){return (2*Math.atan(Math.exp(value))-Math.PI/2)*180/Math.PI;}\n"
insert='''function radarLatitudeAtY(value){return (2*Math.atan(Math.exp(value))-Math.PI/2)*180/Math.PI;}\n\n// Estonia's KAIA composite is authoritative over Estonia. Foreign national\n// mosaics often cover the same area, creating doubled echoes when timestamps\n// or projections differ slightly. The mask is enabled only while KAIA is visible.\nconst ESTONIA_RADAR_PRIORITY_POLYGON=[\n  [24.312863,57.793424],[24.428928,58.383413],[24.061198,58.257375],\n  [23.42656,58.612753],[23.339795,59.18724],[24.604214,59.465854],\n  [25.864189,59.61109],[26.949136,59.445803],[27.981114,59.475388],\n  [28.131699,59.300825],[27.420166,58.724581],[27.716686,57.791899],\n  [27.288185,57.474528],[26.463532,57.476389],[25.60281,57.847529],\n  [25.164594,57.970157],[24.312863,57.793424]\n];\nconst ESTONIA_RADAR_PRIORITY_BOUNDS=[[57.4745,23.3397],[59.6112,28.1318]];\nfunction radarBoundsOverlap(a,b){\n  return a?.length===2&&b?.length===2&&a[0][0]<b[1][0]&&a[1][0]>b[0][0]&&a[0][1]<b[1][1]&&a[1][1]>b[0][1];\n}\nfunction estoniaRadarPriorityMask(bounds){\n  if(!radarBoundsOverlap(bounds,ESTONIA_RADAR_PRIORITY_BOUNDS))return '';\n  const [[south,west],[north,east]]=bounds;\n  const top=radarMercatorY(north),bottom=radarMercatorY(south);\n  if(!Number.isFinite(top)||!Number.isFinite(bottom)||top===bottom||east===west)return '';\n  const points=ESTONIA_RADAR_PRIORITY_POLYGON.map(([lon,lat])=>{\n    const x=(lon-west)/(east-west)*1000;\n    const y=(top-radarMercatorY(lat))/(top-bottom)*1000;\n    return `${x.toFixed(2)} ${y.toFixed(2)}`;\n  });\n  const hole='M'+points.join('L')+'Z';\n  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><path fill="white" fill-rule="evenodd" d="M0 0H1000V1000H0Z ${hole}"/></svg>`;\n  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;\n}\nfunction secondaryRadarElement(layer){return layer?.getElement?.()||layer?._canvas||null;}\nfunction secondaryRadarBounds(layer){\n  const bounds=layer?.getBounds?.();\n  return bounds?[[bounds.getSouth(),bounds.getWest()],[bounds.getNorth(),bounds.getEast()]]:null;\n}\nfunction setEstoniaRadarPriorityMask(layer,enabled){\n  const element=secondaryRadarElement(layer);if(!element)return;\n  const mask=enabled?estoniaRadarPriorityMask(secondaryRadarBounds(layer)):'';\n  element.style.maskImage=mask;element.style.webkitMaskImage=mask;\n  element.style.maskRepeat=mask?'no-repeat':'';element.style.webkitMaskRepeat=mask?'no-repeat':'';\n  element.style.maskSize=mask?'100% 100%':'';element.style.webkitMaskSize=mask?'100% 100%':'';\n}\nfunction syncEstoniaRadarPriorityMasks(){\n  const enabled=!!(typeof radarLayer!=='undefined'&&radarLayer&&typeof map!=='undefined'&&map.hasLayer?.(radarLayer));\n  if(typeof directRadarLayers!=='undefined')for(const layer of directRadarLayers.values())setEstoniaRadarPriorityMask(layer,enabled);\n  if(typeof nordicRadarLayers!=='undefined')for(const layer of nordicRadarLayers.values())setEstoniaRadarPriorityMask(layer,enabled);\n}\n'''
if text.count(marker)!=1: raise SystemExit('radar-images marker mismatch')
text=text.replace(marker,insert,1)
path.write_text(text,encoding='utf-8')

path=Path('js/map.js')
text=path.read_text(encoding='utf-8')
old='''  if(map.hasLayer(temperatureLabels)){\n    map.removeLayer(temperatureLabels);\n    temperatureLabels.addTo(map);\n  }\n}'''
new='''  if(map.hasLayer(temperatureLabels)){\n    map.removeLayer(temperatureLabels);\n    temperatureLabels.addTo(map);\n  }\n  if(typeof syncEstoniaRadarPriorityMasks==='function')syncEstoniaRadarPriorityMasks();\n}'''
if text.count(old)!=1: raise SystemExit('weatherFront marker mismatch')
text=text.replace(old,new,1)
path.write_text(text,encoding='utf-8')

path=Path('js/radar.js')
text=path.read_text(encoding='utf-8')
old='''      map.removeLayer(radarLayer);\n      radarLayer=null;\n    }\n    return;'''
new='''      map.removeLayer(radarLayer);\n      radarLayer=null;\n      if(typeof syncEstoniaRadarPriorityMasks==='function')syncEstoniaRadarPriorityMasks();\n    }\n    return;'''
if text.count(old)!=1: raise SystemExit('radar removal marker mismatch')
text=text.replace(old,new,1)
path.write_text(text,encoding='utf-8')

path=Path('tests/radar-direct.test.cjs')
text=path.read_text(encoding='utf-8')
test='''\n\ntest('secondary radar mask cuts Estonia out of overlapping national mosaics',()=>{\n const c=harness();c.bounds=[[54.59,19.82],[59.09,28.07]];\n const mask=vm.runInContext('estoniaRadarPriorityMask(bounds)',c);assert.match(mask,/data:image\\/svg\\+xml/);\n c.bounds=[[61,-29],[69,-10]];assert.equal(vm.runInContext('estoniaRadarPriorityMask(bounds)',c),'');\n});\n'''
if 'secondary radar mask cuts Estonia' in text: raise SystemExit('test already exists')
path.write_text(text+test,encoding='utf-8')

path=Path('index.html')
text=path.read_text(encoding='utf-8')
text=text.replace('Northern Weather Map v8.77','Northern Weather Map v8.78',1)
for old,new in {
  'js/map.js?v=8.75':'js/map.js?v=8.78',
  'js/radar.js?v=8.74':'js/radar.js?v=8.78',
  'js/radar-images.js?v=8.44':'js/radar-images.js?v=8.78'
}.items():
    if old not in text: raise SystemExit('index marker missing: '+old)
    text=text.replace(old,new,1)
path.write_text(text,encoding='utf-8')
