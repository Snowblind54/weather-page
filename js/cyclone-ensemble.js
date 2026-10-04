// Descriptive GEFS track spread, loaded separately from the unchanged GFS path.
map.createPane('cycloneEnsemblePane');map.getPane('cycloneEnsemblePane').style.zIndex='605';
map.getPane('cycloneEnsemblePane').style.pointerEvents='none';
let cycloneEnsembleData=null,cycloneEnsemblePromise=null,cycloneEnsembleGroup=null,cycloneEnsembleKey='';
let cycloneEnsembleLoadedAt=0,cycloneEnsembleRetryAt=0,cycloneEnsembleFailed=false;

function validateCycloneEnsemble(data){
  const now=Date.now()/1000;
  if(data?.version!==1 || data.methodVersion!==2 || !Number.isFinite(data.modelRun) || data.modelRun>now+300 ||
    !Number.isFinite(data.generatedAt) || data.generatedAt>now+300 || !Number.isInteger(data.forecastEnd) ||
    data.forecastEnd<data.modelRun+24*3600 || data.forecastEnd>data.modelRun+96*3600 || (data.forecastEnd-data.modelRun)%(6*3600)!==0 ||
    data.stepHours!==6 || data.expectedMembers!==31 || !Number.isInteger(data.availableMembers) || data.availableMembers<20 || data.availableMembers>31 ||
    data.spreadPercentile!==80 || !['ok','partial'].includes(data.status) || !Array.isArray(data.systems) || data.systems.length>150)throw new Error('Invalid ensemble snapshot');
  const ids=new Set();let total=0;
  const validPoint=p=>Number.isFinite(p.lat)&&p.lat>=20&&p.lat<=82&&Number.isFinite(p.lon)&&p.lon>=-85&&p.lon<=45&&
    Number.isInteger(p.time)&&p.time>=data.modelRun&&p.time<=data.forecastEnd&&(p.time-data.modelRun)%(6*3600)===0;
  for(const system of data.systems){
    if(typeof system.id!=='string' || ids.has(system.id) || !Array.isArray(system.members) || system.members.length<10 || system.members.length>data.availableMembers ||
      !Array.isArray(system.frames) || system.frames.length>17)throw new Error('Invalid ensemble system');
    ids.add(system.id);const members=new Set();
    for(const track of system.members){
      if(!/^(c00|p(0[1-9]|[12][0-9]|30))$/.test(track.member) || members.has(track.member) || !Array.isArray(track.points) || track.points.length<4 || track.points.length>17)throw new Error('Invalid ensemble member');
      members.add(track.member);
      track.points.forEach((p,i)=>{if(!validPoint(p)||(i&&p.time<=track.points[i-1].time)||!Number.isFinite(p.pressure)||p.pressure<850||p.pressure>1100)throw new Error('Invalid ensemble centre');});
      total+=track.points.length;if(total>100000)throw new Error('Ensemble tracks too large');
    }
    system.frames.forEach((p,i)=>{if(!validPoint(p)||(i&&p.time<=system.frames[i-1].time)||!Number.isFinite(p.radiusKM)||p.radiusKM<0||p.radiusKM>10000||
      !Number.isInteger(p.support)||p.support<Math.max(10,Math.ceil(data.availableMembers*.5))||p.support>system.members.length)throw new Error('Invalid ensemble spread');});
  }
  return data;
}

function ensemblePointAt(points,unix,spread=false){
  const exact=points.find(p=>p.time===unix);if(exact)return exact;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(a.time<unix&&unix<b.time&&b.time-a.time<=6*3600){
      const f=(unix-a.time)/(b.time-a.time),p={time:unix,lat:a.lat+(b.lat-a.lat)*f,lon:a.lon+(b.lon-a.lon)*f};
      if(spread){p.radiusKM=a.radiusKM+(b.radiusKM-a.radiusKM)*f;p.support=Math.min(a.support,b.support);}
      return p;
    }
  }
  return null;
}
function ensembleWindow(points,start,end,spread=false){
  const result=points.filter(p=>p.time>start&&p.time<end);
  const first=ensemblePointAt(points,start,spread),last=ensemblePointAt(points,end,spread);
  if(first)result.unshift(first);if(last&&end>start)result.push(last);
  return result;
}
function ensembleDestination(p,bearing,km){
  const r=Math.PI/180,lat=p.lat*r,lon=p.lon*r,b=bearing*r,d=km/6371;
  const y=Math.asin(Math.sin(lat)*Math.cos(d)+Math.cos(lat)*Math.sin(d)*Math.cos(b));
  const x=lon+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat),Math.cos(d)-Math.sin(lat)*Math.sin(y));
  return [y/r,((x/r+540)%360)-180];
}
function hideCycloneEnsemble(){
  if(cycloneEnsembleGroup)map.removeLayer(cycloneEnsembleGroup);
  cycloneEnsembleGroup=null;cycloneEnsembleKey='';
}
function renderCycloneEnsemble(){
  const status=$('cycloneEnsembleStatus'),spread=$('cycloneSpreadOn').checked,possible=$('cyclonePossibleOn').checked;
  if(!$('cycloneOn').checked || !cycloneUsable() || (!spread&&!possible)){
    hideCycloneEnsemble();status.textContent='Ensemble track spread and possible tracks are off.';return;
  }
  if(!cycloneEnsembleData || cycloneEnsembleData.modelRun!==cycloneData.modelRun){
    hideCycloneEnsemble();status.textContent=cycloneEnsembleFailed?'GEFS spread unavailable for this model run; the GFS path remains available.':'Loading GEFS ensemble tracks…';
    loadCycloneEnsemble();return;
  }
  const start=cycloneFrameTime(cycloneTrackStart()),end=Math.min(start+72*3600,cycloneEnsembleData.forecastEnd);
  const shown=cycloneData.systems.filter(s=>cycloneVisiblePosition(cyclonePointAt(s,cycloneSelectedTime())));
  const matched=cycloneEnsembleData.systems.filter(s=>shown.some(reference=>reference.id===s.id));
  const key=[cycloneEnsembleData.generatedAt,start,end,spread,possible,matched.map(s=>s.id).join(',')].join('/');
  if(key!==cycloneEnsembleKey){
    hideCycloneEnsemble();const layers=[];
    for(const system of matched){
      if(spread){
        const frames=ensembleWindow(system.frames,start,end,true);
        for(let i=0;i<frames.length;i++){
          const a=frames[i],b=frames[i+1],style={pane:'cycloneEnsemblePane',color:'#80c9ff',weight:0,fillColor:'#80c9ff',fillOpacity:.075,interactive:false};
          if(a.radiusKM>0)layers.push(L.circle([a.lat,a.lon],{...style,radius:a.radiusKM*1000}));
          if(b&&b.time-a.time<=6*3600){
            const bearing=cycloneBearing(a,b);
            layers.push(L.polygon([ensembleDestination(a,bearing-90,a.radiusKM),ensembleDestination(b,bearing-90,b.radiusKM),
              ensembleDestination(b,bearing+90,b.radiusKM),ensembleDestination(a,bearing+90,a.radiusKM)],style));
          }
        }
      }
      if(possible)for(const member of system.members){
        const points=ensembleWindow(member.points,start,end);let part=[];
        const draw=()=>{if(part.length>1)layers.push(L.polyline(part.map(p=>[p.lat,p.lon]),{pane:'cycloneEnsemblePane',color:'#80c9ff',weight:1,opacity:.25,interactive:false}));};
        for(const p of points){if(part.length&&p.time-part.at(-1).time>6*3600){draw();part=[];}part.push(p);}draw();
      }
    }
    cycloneEnsembleGroup=L.layerGroup(layers).addTo(map);cycloneEnsembleKey=key;
  }
  const available=cycloneEnsembleData.availableMembers;
  const support=matched.map(s=>ensemblePointAt(s.frames,cycloneSelectedTime(),true)?.support);
  status.textContent=matched.length
    ?'GEFS '+available+'/31 members · '+matched.length+'/'+shown.length+' visible systems matched. Selected-hour spread support: '+support.map(n=>n==null?'insufficient':n+'/'+available).join(', ')+
      '. Shading: 80th-percentile spread of matched centres, not a probability cone or wind footprint. Native 6-hour steps.'
    :'GEFS '+available+'/31 members · too few unambiguous matching tracks for the visible systems; no spread drawn.';
  if(cycloneEnsembleData.status==='partial')status.textContent+=' Some ensemble members are unavailable.';
  if(cycloneEnsembleData.forecastEnd<cycloneEnsembleData.modelRun+96*3600)status.textContent+=' Ensemble data currently extends '+((cycloneEnsembleData.forecastEnd-cycloneEnsembleData.modelRun)/3600)+' h from the model run; later frames are still arriving.';
  if(cycloneEnsembleFailed)status.textContent+=' Latest ensemble refresh failed; using this same-run snapshot.';
  if(Date.now()-cycloneEnsembleLoadedAt>30*60*1000)loadCycloneEnsemble();
}
async function loadCycloneEnsemble(){
  if(cycloneEnsemblePromise || Date.now()<cycloneEnsembleRetryAt || !$('cycloneOn').checked ||
    (!$('cycloneSpreadOn').checked&&!$('cyclonePossibleOn').checked))return;
  cycloneEnsembleRetryAt=Date.now()+5*60*1000;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  cycloneEnsemblePromise=(async()=>{
    try{
      const response=await fetch('data/cyclone-ensemble.json',{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('GEFS feed HTTP '+response.status);
      const data=validateCycloneEnsemble(await response.json());
      if(data.modelRun!==cycloneData?.modelRun)throw new Error('GEFS and GFS model runs differ');
      cycloneEnsembleData=data;cycloneEnsembleLoadedAt=Date.now();cycloneEnsembleFailed=false;
    }catch(error){cycloneEnsembleFailed=true;console.warn('Cyclone ensemble unavailable',error.message);}
    finally{clearTimeout(timer);}
  })();
  await cycloneEnsemblePromise;cycloneEnsemblePromise=null;
  if($('cycloneOn').checked)renderCycloneEnsemble();
}
$('cycloneSpreadOn').addEventListener('change',renderCycloneEnsemble);
$('cyclonePossibleOn').addEventListener('change',renderCycloneEnsemble);
