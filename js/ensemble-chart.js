/* A location-specific, on-demand ensemble meteogram. No startup data requests. */
(function(){
 'use strict';
 const api=window.NorthernEnsembleData;if(!api)return;
 let dialog,canvas,empty,tooltip,status,locationLabel,subtitle,retry,help,observer,raf=0,session=0,point,returnFocus;
 const data={},stats={},errors={},loading={},controllers={},checks={},counts={};
 let members=true,enabled={ecmwf:true,gfs:true},cursor=null,plot=null;
 try{const p=JSON.parse(localStorage.getItem('northernEnsembleView')||'null');if(p){for(const m of api.models)enabled[m.id]=p[m.id]!==false;members=p.members!==false;}}catch{}
 const element=(tag,value,cls)=>{const e=document.createElement(tag);if(value)e.textContent=value;if(cls)e.className=cls;return e;};
 const temp=v=>globalThis.WeatherUnits?.temperatureValue(v)??v;
 const unit=()=>globalThis.WeatherUnits?.temperatureUnit()||'°C';
 function zone(){const z=api.models.map(m=>data[m.id]?.timezone).find(Boolean)||'UTC';try{new Intl.DateTimeFormat(undefined,{timeZone:z});return z;}catch{return 'UTC';}}
 function format(time,options={}){return new Intl.DateTimeFormat(undefined,{timeZone:zone(),...options}).format(new Date(time*1000));}
 function remember(){try{localStorage.setItem('northernEnsembleView',JSON.stringify({...enabled,members}));}catch{}}
 function active(){return api.models.filter(m=>enabled[m.id]&&data[m.id]);}
 function close(){
  session++;for(const c of Object.values(controllers))c?.abort();observer?.disconnect();
  if(dialog?.open)dialog.close();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
 }
 function create(){
  dialog=element('dialog','','ensemble-dialog');dialog.setAttribute('aria-labelledby','ensembleTitle');
  const heading=element('header','','ensemble-heading'),titleBox=element('div'),title=element('h2','Temperature ensembles');title.id='ensembleTitle';
  locationLabel=element('p','','ensemble-location');subtitle=element('p','15-day outlook · 2 m air temperature','ensemble-location');titleBox.append(title,locationLabel,subtitle);
  const actions=element('div','','ensemble-actions'),info=element('button','i','info-button'),dismiss=element('button','×');info.type=dismiss.type='button';info.setAttribute('aria-label','About temperature ensembles');info.setAttribute('aria-expanded','false');info.setAttribute('aria-controls','ensembleHelp');dismiss.setAttribute('aria-label','Close temperature ensembles');
  help=element('div','Each thin line is one possible forecast from an ensemble member; thick lines show the model averages. Turning individual members off shows the middle 80% of members as a shaded band. A wider spread means more disagreement, not a calibrated confidence interval. The proportion below 0°C refers to 2 m air temperature, not guaranteed ground frost. Forecasts become less specific farther ahead. ECMWF and GFS have different grid sizes; elevation-adjusted model forecasts cannot resolve every valley or local inversion. API hourly values may include interpolation from coarser time steps. “Fetched” is retrieval time, not model initialization time.','ensemble-help');help.id='ensembleHelp';help.hidden=true;
  info.addEventListener('click',()=>{help.hidden=!help.hidden;info.setAttribute('aria-expanded',String(!help.hidden));});dismiss.addEventListener('click',close);actions.append(info,dismiss);heading.append(titleBox,actions);
  const controls=element('div','','ensemble-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label','Visible ensemble models');
  for(const m of api.models){
   const label=element('label','','ensemble-model-toggle');label.style.setProperty('--ensemble-colour',m.color);
   const input=element('input');input.type='checkbox';input.checked=enabled[m.id];input.setAttribute('aria-label','Show '+m.name+' ensemble');checks[m.id]=input;
   const copy=element('span'),name=element('b',m.name);counts[m.id]=element('small','Not loaded');copy.append(name,counts[m.id]);label.append(input,copy);controls.append(label);
   input.addEventListener('change',()=>{enabled[m.id]=input.checked;remember();cursor=null;if(input.checked&&!data[m.id]&&!loading[m.id])loadOne(m,session);schedule();update();});
  }
  const memberLabel=element('label','','ensemble-members'),memberToggle=element('input');memberToggle.type='checkbox';memberToggle.checked=members;memberToggle.setAttribute('aria-label','Show individual ensemble members');memberLabel.append(memberToggle,element('span','Individual members'));
  memberToggle.addEventListener('change',()=>{members=memberToggle.checked;remember();schedule();});controls.append(memberLabel);
  const wrap=element('div','','ensemble-chart-wrap');canvas=element('canvas','','ensemble-canvas');canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Temperature ensemble chart. Use left and right arrow keys to inspect forecast times.');empty=element('div','Loading ensemble forecasts…','ensemble-empty');wrap.append(canvas,empty);
  tooltip=element('output','','ensemble-tooltip');tooltip.setAttribute('aria-label','Selected ensemble forecast');tooltip.textContent='Touch or point at the chart to inspect a forecast time. Keyboard: left and right arrows.';
  status=element('p','','ensemble-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');retry=element('button','Retry unavailable models','ensemble-retry');retry.type='button';retry.hidden=true;retry.addEventListener('click',()=>{for(const m of api.models)if(enabled[m.id]&&errors[m.id]&&!loading[m.id])loadOne(m,session);});
  const footer=element('footer','','ensemble-footer'),credit=element('span');credit.append(document.createTextNode('ECMWF / NOAA GEFS via '));const link=element('a','Open-Meteo');link.href='https://open-meteo.com/en/docs/ensemble-api';link.target='_blank';link.rel='noopener';credit.append(link,document.createTextNode(' · CC BY 4.0'));footer.append(credit,element('span','Thin lines: members · thick lines: averages · dashed: freezing'));
  dialog.append(heading,help,controls,wrap,tooltip,status,retry,footer);document.body.append(dialog);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  canvas.addEventListener('pointermove',event=>{if(!plot)return;const box=canvas.getBoundingClientRect();cursor=Math.max(plot.start,Math.min(plot.end,plot.start+(event.clientX-box.left-plot.left)/plot.width*(plot.end-plot.start)));schedule();});
  canvas.addEventListener('keydown',event=>{
   if(!plot||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
   cursor=event.key==='Home'?plot.start:event.key==='End'?plot.end:Math.max(plot.start,Math.min(plot.end,(cursor??plot.start)+(event.key==='ArrowRight'?1:-1)*3*3600));schedule();
  });
  window.addEventListener('resize',()=>{if(dialog.open)schedule();});document.addEventListener('weather-units-change',()=>{if(dialog.open)schedule();});
 }
 function update(){
  if(!dialog?.open)return;
  for(const m of api.models)counts[m.id].textContent=loading[m.id]?'Loading…':data[m.id]?data[m.id].members.length+' members · '+m.resolution:errors[m.id]?'Unavailable':'Not loaded';
  const on=api.models.filter(m=>enabled[m.id]),available=active();
  empty.hidden=available.length>0;
  empty.textContent=!on.length?'Switch on ECMWF or GFS above to view its forecast.':on.some(m=>loading[m.id])?'Loading ensemble forecasts…':'Forecast data unavailable. Try again shortly.';
  retry.hidden=!on.some(m=>errors[m.id]);
  const notes=[];
  for(const m of on){if(errors[m.id])notes.push(m.name+': '+errors[m.id]);else if(data[m.id])notes.push(m.name+': fetched '+format(data[m.id].fetchedAt/1000,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+(data[m.id].elevation!==null?' · elevation '+Math.round(data[m.id].elevation)+' m':''));}
  status.textContent=notes.join(' | ')||'Choose which models to display.';
  subtitle.textContent='15-day outlook · 2 m air temperature · '+unit()+' · '+zone();
  if(!available.length){plot=null;tooltip.textContent=!on.length?'Both models are switched off.':'Waiting for a model forecast…';}
 }
 async function loadOne(model,id){
  if(!dialog.open||id!==session)return;
  loading[model.id]=true;delete errors[model.id];update();const controller=new AbortController();controllers[model.id]=controller;const timer=setTimeout(()=>controller.abort(),20000);
  try{
   const result=await api.load(point,model.id,{signal:controller.signal});
   if(id!==session||!dialog.open)return;data[model.id]=result;stats[model.id]=api.statistics(result);
  }catch(error){if(id===session&&dialog.open)errors[model.id]=error.name==='AbortError'?'Request timed out. Try again.':error.message;}
  finally{clearTimeout(timer);if(id===session){loading[model.id]=false;controllers[model.id]=null;update();schedule();}}
 }
 function schedule(){if(!dialog?.open||raf)return;raf=requestAnimationFrame(()=>{raf=0;draw();});}
 function draw(){
  if(!dialog.open)return;
  const box=canvas.getBoundingClientRect(),W=Math.round(box.width),H=Math.round(box.height);if(W<80||H<80)return;
  const ratio=Math.min(2,window.devicePixelRatio||1);canvas.width=W*ratio;canvas.height=H*ratio;const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,W,H);
  const selected=active();if(!selected.length){plot=null;return;}
  const now=Math.floor(Date.now()/10800000)*10800;let start=Infinity,end=-Infinity,min=Infinity,max=-Infinity;
  for(const m of selected)for(const s of stats[m.id])if(s&&s.time>=now){start=Math.min(start,s.time);end=Math.max(end,s.time);min=Math.min(min,temp(s.min));max=Math.max(max,temp(s.max));}
  if(!Number.isFinite(start)||end<=start){empty.hidden=false;empty.textContent='No future forecast times are available for this location.';return;}
  empty.hidden=true;const pad=Math.max(1,(max-min)*.08),step=max-min>35?10:max-min>15?5:2;min=Math.floor((min-pad)/step)*step;max=Math.ceil((max+pad)/step)*step;
  const left=W<500?40:48,right=16,top=22,bottom=38,width=W-left-right,height=H-top-bottom;
  const x=t=>left+(t-start)/(end-start)*width,y=v=>top+(max-temp(v))/(max-min)*height;
  plot={start,end,left,width};ctx.font='11px system-ui';ctx.lineWidth=1;ctx.textAlign='right';ctx.textBaseline='middle';
  for(let v=min;v<=max;v+=step){const yy=top+(max-v)/(max-min)*height;ctx.strokeStyle='#ffffff14';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(W-right,yy);ctx.stroke();ctx.fillStyle='#c4b2a4';ctx.fillText(String(v),left-8,yy);}
  ctx.textAlign='left';ctx.fillStyle='#e8dcd0';ctx.fillText(unit(),6,top-10);
  const ticks=W<500?4:8;ctx.textBaseline='top';
  for(let i=0;i<=ticks;i++){const t=start+(end-start)*i/ticks,xx=x(t);ctx.strokeStyle='#ffffff10';ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,H-bottom);ctx.stroke();ctx.fillStyle='#bba99a';ctx.textAlign=i===0?'left':i===ticks?'right':'center';ctx.fillText(format(t,{month:'short',day:'numeric'}),xx,H-bottom+12);}
  const freezing=temp(0);if(freezing>=min&&freezing<=max){ctx.setLineDash([5,4]);ctx.strokeStyle='#f0dfb788';ctx.beginPath();ctx.moveTo(left,y(0));ctx.lineTo(W-right,y(0));ctx.stroke();ctx.setLineDash([]);}
  ctx.save();ctx.beginPath();ctx.rect(left,top,width,height);ctx.clip();
  function line(times,values,color,lineWidth,opacity){ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.globalAlpha=opacity;ctx.beginPath();let begun=false;
   for(let i=0;i<times.length;i++){if(times[i]<start||times[i]>end)continue;const value=values[i];if(!Number.isFinite(value)){begun=false;continue;}if(i%3!==0&&i!==times.length-1)continue;if(!begun){ctx.moveTo(x(times[i]),y(value));begun=true;}else ctx.lineTo(x(times[i]),y(value));}ctx.stroke();}
  for(const m of selected){const d=data[m.id],summary=stats[m.id];
   if(members){for(const values of d.members)line(d.times,values,m.color,1,Math.min(.16,4/d.members.length));}
   else{
    let segment=[];const fill=()=>{if(segment.length<2){segment=[];return;}ctx.beginPath();segment.forEach((s,i)=>i?ctx.lineTo(x(s.time),y(s.p90)):ctx.moveTo(x(s.time),y(s.p90)));segment.slice().reverse().forEach(s=>ctx.lineTo(x(s.time),y(s.p10)));ctx.closePath();ctx.fillStyle=m.color;ctx.globalAlpha=.13;ctx.fill();segment=[];};
    for(const s of summary){if(s&&s.time>=start&&s.time<=end)segment.push(s);else fill();}fill();
   }
   line(d.times,summary.map(s=>s?.mean??null),m.color,2.5,1);
  }
  ctx.globalAlpha=1;
  if(cursor!==null){ctx.strokeStyle='#f7f1eb88';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x(cursor),top);ctx.lineTo(x(cursor),H-bottom);ctx.stroke();}
  ctx.restore();inspect(cursor??start);
 }
 function inspect(time){
  tooltip.replaceChildren();const heading=element('time',format(time,{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));heading.dateTime=new Date(time*1000).toISOString();tooltip.append(heading);
  for(const m of active()){
   const d=data[m.id];let index=0;for(let i=1;i<d.times.length;i++)if(Math.abs(d.times[i]-time)<Math.abs(d.times[index]-time))index=i;
   const s=stats[m.id][index],row=element('div','','ensemble-tooltip-row'),label=element('b',m.name);label.style.color=m.color;row.append(label);
   if(s&&Math.abs(s.time-time)<=3*3600){row.append(element('span','Average '+temp(s.mean).toFixed(1)+unit()),element('span','Middle 80%: '+temp(s.p10).toFixed(1)+' to '+temp(s.p90).toFixed(1)+unit()),element('span','Members below '+temp(0).toFixed(0)+unit()+': '+Math.round(s.belowZero*100)+'% ('+s.count+' members)'));}
   else row.append(element('span','No forecast for this time'));tooltip.append(row);
  }
 }
 function open(location){
  const next=api.location(location);if(dialog?.open&&point?.lat===next.lat&&point?.lon===next.lon)return;
  if(!dialog)create();session++;for(const c of Object.values(controllers))c?.abort();for(const m of api.models){delete data[m.id];delete stats[m.id];delete errors[m.id];loading[m.id]=false;checks[m.id].checked=enabled[m.id];}
  point=next;cursor=null;returnFocus=document.activeElement;locationLabel.textContent=location.label||next.lat.toFixed(3)+'°, '+next.lon.toFixed(3)+'°';
  if(!dialog.open)dialog.showModal();update();schedule();
  if(typeof ResizeObserver==='function'){observer?.disconnect();observer=new ResizeObserver(schedule);observer.observe(canvas.parentElement);}
  for(const m of api.models)if(enabled[m.id])loadOne(m,session);
 }
 window.NorthernEnsembleForecast={open,close};
})();
