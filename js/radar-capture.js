// v8.6: keep a small direct-source Latvian history warm while the page is open.
async function captureLatestLatviaRadar(){
  const source=DIRECT_RADAR_SOURCES.find(s=>s.id==='lv');
  if(!source) return;

  const time=Math.floor(Date.now()/1000/LV_STEP)*LV_STEP;
  const dataUrl=await nationalRadarImage(source,false);
  saveLvLocal(time,dataUrl);
}

setTimeout(()=>captureLatestLatviaRadar().catch(()=>{}),8000);
setInterval(()=>captureLatestLatviaRadar().catch(()=>{}),5*60*1000);
