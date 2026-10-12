// Local solar geometry and upcoming events. SunCalc 1.9 uses radians.
(function(root){
  'use strict';
  const rad=Math.PI/180,day=86400000,horizon=-.833;
  const longitude=lon=>((lon+180)%360+360)%360-180;
  function solarVector(date){
    return [Math.sin(SunCalc.getPosition(date,0,0).altitude),
      Math.sin(SunCalc.getPosition(date,0,90).altitude),
      Math.sin(SunCalc.getPosition(date,90,0).altitude)];
  }
  function elevation(vector,lat,lon){
    const phi=lat*rad,lambda=lon*rad;
    return Math.asin(Math.max(-1,Math.min(1,Math.sin(phi)*vector[2]+
      Math.cos(phi)*(Math.cos(lambda)*vector[0]+Math.sin(lambda)*vector[1]))))/rad;
  }
  function state(altitude){return altitude>=horizon?'Daylight':altitude>=-6?'Twilight':'Night';}
  function colour(altitude){
    if(altitude>=horizon)return [0,0,0,0];
    if(altitude>=-6)return [235,160,70,Math.round(28+12*(horizon-altitude)/(6+horizon))];
    return [7,16,38,Math.round(70+65*Math.min(1,(-altitude-6)/12))];
  }
  function nextEvents(now,lat,lon){
    if(!Number.isFinite(+now)||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90)throw new Error('Invalid sun location');
    lon=longitude(lon);
    const events={sunrise:null,sunset:null},start=+now;
    for(let offset=-1;offset<=370;offset++){
      const times=SunCalc.getTimes(new Date(start+offset*day),lat,lon);
      for(const key of ['sunrise','sunset']){
        const value=+times[key];
        if(Number.isFinite(value)&&value>start&&(!events[key]||value<+events[key]))events[key]=new Date(value);
      }
      if(events.sunrise&&events.sunset&&offset>=2)break;
    }
    // At the geographic poles the usual daily hour-angle formula is singular.
    // Find seasonal horizon crossings directly instead of returning Invalid Date.
    if(!events.sunrise||!events.sunset){
      const altitude=t=>SunCalc.getPosition(new Date(t),lat,lon).altitude/rad-horizon;
      let previous=start,low=altitude(previous);
      for(let t=start+6*3600000;t<=start+371*day;t+=6*3600000){
        const high=altitude(t),key=low<0&&high>=0?'sunrise':low>=0&&high<0?'sunset':null;
        if(key&&!events[key]){
          let a=previous,b=t;
          while(b-a>1000){const middle=(a+b)/2;if((altitude(middle)>=0)===(low>=0))a=middle;else b=middle;}
          events[key]=new Date((a+b)/2);
        }
        if(events.sunrise&&events.sunset)break;
        previous=t;low=high;
      }
    }
    const nearby=SunCalc.getTimes(now,lat,lon);
    events.polar=!Number.isFinite(+nearby.sunrise)&&!Number.isFinite(+nearby.sunset);
    return events;
  }
  root.NorthernDaylightMath={solarVector,elevation,state,colour,nextEvents,longitude};
})(typeof window!=='undefined'?window:globalThis);
