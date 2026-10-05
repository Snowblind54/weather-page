(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.WindObservationBlend=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const EARTH_KM=6371;
  const RADIUS_KM=70;
  const SIGMA_KM=40;
  const FULL_AGE_SECONDS=30*60;
  const MAX_AGE_SECONDS=3*60*60;
  const MAX_ABS_DELTA=25;

  function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
  function distanceKm(lat1,lon1,lat2,lon2){
    const toRad=Math.PI/180;
    const phi1=lat1*toRad,phi2=lat2*toRad;
    const dPhi=(lat2-lat1)*toRad,dLambda=(lon2-lon1)*toRad;
    const a=Math.sin(dPhi/2)**2+Math.cos(phi1)*Math.cos(phi2)*Math.sin(dLambda/2)**2;
    return 2*EARTH_KM*Math.asin(Math.min(1,Math.sqrt(a)));
  }
  function ageWeight(ageSeconds){
    if(!Number.isFinite(ageSeconds)||ageSeconds<0||ageSeconds>=MAX_AGE_SECONDS)return 0;
    if(ageSeconds<=FULL_AGE_SECONDS)return 1;
    return 1-(ageSeconds-FULL_AGE_SECONDS)/(MAX_AGE_SECONDS-FULL_AGE_SECONDS);
  }
  function makeCorrection(lat,lon,observedSpeed,modelSpeed,ageSeconds){
    const freshness=ageWeight(ageSeconds);
    if(!freshness||![lat,lon,observedSpeed,modelSpeed].every(Number.isFinite)||observedSpeed<0||modelSpeed<0)return null;
    return {lat,lon,delta:clamp(observedSpeed-modelSpeed,-MAX_ABS_DELTA,MAX_ABS_DELTA),freshness};
  }
  function spatialWeight(distance){
    if(!Number.isFinite(distance)||distance<0||distance>=RADIUS_KM)return 0;
    const t=distance/RADIUS_KM;
    const edge=1-(3*t*t-2*t*t*t);
    return Math.exp(-0.5*(distance/SIGMA_KM)**2)*edge;
  }
  function adjustSpeed(baseSpeed,lat,lon,corrections){
    if(!Number.isFinite(baseSpeed)||baseSpeed<0||!Array.isArray(corrections)||!corrections.length)return baseSpeed;
    let sum=0,deltaSum=0;
    for(const correction of corrections){
      const weight=correction.freshness*spatialWeight(distanceKm(lat,lon,correction.lat,correction.lon));
      if(weight<=0)continue;
      sum+=weight;deltaSum+=correction.delta*weight;
    }
    if(sum<=0)return baseSpeed;
    const confidence=Math.min(1,sum);
    return Math.max(0,baseSpeed+(deltaSum/sum)*confidence);
  }
  return {RADIUS_KM,SIGMA_KM,FULL_AGE_SECONDS,MAX_AGE_SECONDS,MAX_ABS_DELTA,distanceKm,ageWeight,makeCorrection,spatialWeight,adjustSpeed};
});
