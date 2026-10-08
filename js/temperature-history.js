// Inline measured-temperature history for official station popups.
(function(){
  'use strict';

  const HISTORY_SECONDS=24*60*60;

  function sameStation(a,b){
    if(!a||!b)return false;
    if(a.country!==b.country)return false;
    if(a.code&&b.code)return a.code===b.code;
    return Math.abs(a.lat-b.lat)<0.0005&&Math.abs(a.lon-b.lon)<0.0005;
  }

  function historyRows(station,endUnix){
    if(typeof officialTemperatureStations==='undefined')return [];
    const end=Math.min(Number(endUnix)||Date.now()/1000,Date.now()/1000),start=end-HISTORY_SECONDS;
    return officialTemperatureStations
      .filter(row=>sameStation(row,station)&&Number.isFinite(row.time)&&Number.isFinite(row.temp)&&row.time>=start&&row.time<=end)
      .sort((a,b)=>a.time-b.time);
  }

  function historyGraph(station,endUnix){
    const rows=historyRows(station,endUnix);
    if(rows.length<2){
      return '<div class="wind-popup-meta" style="margin-top:9px;border-top:1px solid rgba(255,255,255,.12);padding-top:9px">Measured temperature history is still building for this station.</div>';
    }

    const W=304,H=154,L=34,R=7,T=11,B=28,plotW=W-L-R,plotH=H-T-B;
    const start=rows[0].time,end=rows.at(-1).time,span=Math.max(1,end-start);
    const values=rows.map(r=>r.temp),rawMin=Math.min(...values),rawMax=Math.max(...values);
    let yMin=Math.floor(rawMin-1),yMax=Math.ceil(rawMax+1);
    if(yMax-yMin<4){const mid=(yMin+yMax)/2;yMin=Math.floor(mid-2);yMax=Math.ceil(mid+2);}
    const x=t=>L+(t-start)/span*plotW;
    const y=v=>T+(1-(v-yMin)/(yMax-yMin))*plotH;

    let d='',lastTime=null;
    for(const row of rows){
      const gap=lastTime!==null&&row.time-lastTime>3*3600;
      d+=(d&&!gap?'L':'M')+x(row.time).toFixed(1)+' '+y(row.temp).toFixed(1)+' ';
      lastTime=row.time;
    }

    const timeLabel=t=>new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const mid=(start+end)/2;
    const current=rows.at(-1).temp,min=Math.min(...values),max=Math.max(...values);
    const zeroY=yMin<=0&&yMax>=0?y(0):null;

    return `<div style="margin-top:9px;border-top:1px solid rgba(255,255,255,.12);padding-top:9px">
      <div class="wind-popup-meta" style="display:flex;justify-content:space-between;gap:8px;margin-bottom:3px"><strong style="color:#eaf7fb">Measured history · up to 24 h</strong><span>${rows.length} obs</span></div>
      <div class="wind-popup-meta" style="display:flex;justify-content:space-between;gap:7px;margin-bottom:3px"><span>Now ${(globalThis.WeatherUnits?.temperature(current,1)??current.toFixed(1)+'°C')}</span><span>Min ${(globalThis.WeatherUnits?.temperature(min,1)??min.toFixed(1)+'°C')}</span><span>Max ${(globalThis.WeatherUnits?.temperature(max,1)??max.toFixed(1)+'°C')}</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="154" role="img" aria-label="Measured temperature history for ${htmlEscape(station.name)}">
        <g stroke="rgba(255,255,255,.13)" stroke-width="1">
          <line x1="${L}" y1="${T}" x2="${W-R}" y2="${T}"/><line x1="${L}" y1="${T+plotH/2}" x2="${W-R}" y2="${T+plotH/2}"/><line x1="${L}" y1="${T+plotH}" x2="${W-R}" y2="${T+plotH}"/>
          ${zeroY!==null?`<line x1="${L}" y1="${zeroY.toFixed(1)}" x2="${W-R}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,.28)" stroke-dasharray="4 4"/>`:''}
        </g>
        <g fill="rgba(225,239,244,.72)" font-size="9" font-family="system-ui,sans-serif">
          <text x="${L-5}" y="${T+3}" text-anchor="end">${(globalThis.WeatherUnits?.temperature(yMax,0)??Math.round(yMax)+'°C')}</text><text x="${L-5}" y="${T+plotH/2+3}" text-anchor="end">${(globalThis.WeatherUnits?.temperature(((yMin+yMax)/2),0)??Math.round(((yMin+yMax)/2))+'°C')}</text><text x="${L-5}" y="${T+plotH+3}" text-anchor="end">${(globalThis.WeatherUnits?.temperature(yMin,0)??Math.round(yMin)+'°C')}</text>
          <text x="${L}" y="${H-7}">${timeLabel(start)}</text><text x="${L+plotW/2}" y="${H-7}" text-anchor="middle">${timeLabel(mid)}</text><text x="${W-R}" y="${H-7}" text-anchor="end">${timeLabel(end)}</text>
        </g>
        <path d="${d.trim()}" fill="none" stroke="#71d8ff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(rows.at(-1).time).toFixed(1)}" cy="${y(rows.at(-1).temp).toFixed(1)}" r="2.8" fill="#eafcff"/>
      </svg>
    </div>`;
  }

  function install(){
    if(typeof officialTemperaturePopup!=='function'||officialTemperaturePopup._historyInstalled)return;
    const base=officialTemperaturePopup;
    const wrapped=function(station){
      const html=base(station);
      const end=Number.isFinite(station.time)?station.time:Date.now()/1000;
      return html.replace(/<\/div>\s*$/,historyGraph(station,end)+'</div>');
    };
    wrapped._historyInstalled=true;
    officialTemperaturePopup=wrapped;
  }

  install();
})();
