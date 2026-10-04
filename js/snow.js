// NOAA / U.S. National Ice Center daily IMS analysis, delivered in map tiles.
const SNOW_SERVICE='https://mapservices.weather.noaa.gov/raster/rest/services/obs/usnic_ims_snow_ice_1km/ImageServer';
const SNOW_RENDERING_RULE={
  rasterFunction:'Colormap',
  rasterFunctionArguments:{
    Raster:{rasterFunction:'Remap',rasterFunctionArguments:{
      Raster:'$$',InputRanges:[3,4,4,5],OutputValues:[3,4],
      NoDataRanges:[0,3],AllowUnmatched:false
    }},
    Colormap:[[3,77,205,245],[4,245,250,255]]
  }
};
map.createPane('snowPane');
map.getPane('snowPane').style.zIndex='450';
map.getPane('snowPane').style.pointerEvents='none';
const SnowTileLayer=L.TileLayer.extend({
  getTileUrl(coords){
    const size=this.getTileSize(),z=coords.z;
    const nw=map.options.crs.project(map.unproject(L.point(coords.x*size.x,coords.y*size.y),z));
    const se=map.options.crs.project(map.unproject(L.point((coords.x+1)*size.x,(coords.y+1)*size.y),z));
    const params=new URLSearchParams({
      bbox:[nw.x,se.y,se.x,nw.y].join(','),bboxSR:'3857',imageSR:'3857',
      size:size.x+','+size.y,format:'png32',f:'image',
      interpolation:'RSP_NearestNeighbor',renderingRule:JSON.stringify(SNOW_RENDERING_RULE),
      _ts:String(this.refreshKey)
    });
    if(this.rasterId!==null && this.rasterId!==undefined){
      params.set('mosaicRule',JSON.stringify({mosaicMethod:'esriMosaicLockRaster',lockRasterIds:[this.rasterId]}));
    }
    return SNOW_SERVICE+'/exportImage?'+params;
  }
});
const snowLayer=new SnowTileLayer('',{
  pane:'snowPane',opacity:.85,maxNativeZoom:8,maxZoom:18,
  bounds:[[0,-180],[85.05112878,180]],updateWhenIdle:true,keepBuffer:1,
  attribution:'Snow & ice: NOAA / U.S. National Ice Center IMS (1 km)'
});
snowLayer.refreshKey=0;
let snowMode=false,snowPreviousView=null,snowMetadataGeneration=0,snowRefreshTimer=null;
let snowSourceLabel='Latest daily analysis · source date pending';
let snowTilesFailed=0,snowTilesLoaded=0;
const snowWeatherToggles=['tempOn','heatmapOn','windOn','cloudOn','radarOn','rain1h','rain24h','rain48h','cycloneOn','warningOn'];
function snowStatus(text,kind=''){
  $('snowStatus').textContent=text;
  $('snowStatus').className='status'+(kind?' '+kind:'');
  $('snowMapStatus').textContent=text;
}
function snowTileStatus(){
  if(!snowMode)return;
  if(snowTilesFailed){
    snowStatus(snowTilesLoaded?'Some snow tiles could not load. Refresh to retry.':'Snow coverage could not load. Refresh to retry.','bad');
  }else{
    snowStatus(snowSourceLabel+' · snow cover, not snow depth','ok');
  }
}
snowLayer.on('loading',()=>{snowTilesFailed=0;snowTilesLoaded=0;if(snowMode)snowStatus('Loading snow coverage…');});
snowLayer.on('tileerror',()=>{snowTilesFailed++;});
snowLayer.on('tileload',()=>{snowTilesLoaded++;});
snowLayer.on('load',snowTileStatus);
function setSnowToggle(id,checked){
  if($(id).checked===checked)return;
  $(id).checked=checked;
  $(id).dispatchEvent(new Event('change',{bubbles:true}));
}
function enterSnowView(){
  if(snowMode)return;
  snowPreviousView={
    center:map.getCenter(),zoom:map.getZoom(),
    toggles:snowWeatherToggles.filter(id=>$(id).checked)
  };
  snowMode=true;stop();
  // Disable through the existing controls so pending async renders are cancelled.
  for(const id of snowWeatherToggles)setSnowToggle(id,false);
  $('snowOn').checked=true;
  $('nav-snowSection').classList.add('layer-active');
  document.body.classList.add('snow-view');
  $('snowMapKey').hidden=false;
  map.closePopup();
  map.fitBounds([[0,-180],[83,180]],{padding:[16,16],animate:false});
  snowLayer.addTo(map);
  refreshSnowCoverage();
  snowRefreshTimer=setInterval(()=>{if(!document.hidden)refreshSnowCoverage();},30*60*1000);
}
function exitSnowView({restore=true}={}){
  if(!snowMode)return;
  snowMode=false;snowMetadataGeneration++;
  clearInterval(snowRefreshTimer);snowRefreshTimer=null;
  map.removeLayer(snowLayer);
  $('snowOn').checked=false;
  $('nav-snowSection').classList.remove('layer-active');
  document.body.classList.remove('snow-view');
  $('snowMapKey').hidden=true;
  const previous=snowPreviousView;snowPreviousView=null;
  if(previous && restore){
    map.setView(previous.center,previous.zoom,{animate:false});
    for(const id of previous.toggles)setSnowToggle(id,true);
  }
  snowStatus('Snow coverage is off.');
}
async function refreshSnowCoverage(){
  if(!snowMode)return;
  const generation=++snowMetadataGeneration;
  $('snowRefresh').disabled=true;
  try{
    const params=new URLSearchParams({
      where:'category=1',outFields:'objectid,name,idp_filedate,idp_ingestdate',
      returnGeometry:'false',orderByFields:'idp_filedate DESC',resultRecordCount:'1',f:'json'
    });
    const response=await fetch(SNOW_SERVICE+'/query?'+params,{signal:AbortSignal.timeout(12000),cache:'no-store'});
    if(!response.ok)throw new Error('Snow metadata HTTP '+response.status);
    const data=await response.json();
    if(data.error)throw new Error(data.error.message);
    const record=data.features?.[0]?.attributes;
    if(!record)throw new Error('Snow source has no analysis');
    if(!snowMode || generation!==snowMetadataGeneration)return;
    snowLayer.rasterId=record.objectid;
    const timestamp=record.idp_filedate;
    const date=timestamp===null || timestamp===undefined?null:new Date(timestamp);
    snowSourceLabel=date && Number.isFinite(date.getTime())
      ?'Source file: '+date.toISOString().slice(0,10)+' UTC · daily IMS analysis'
      :'Latest daily IMS analysis · source date unavailable';
    $('snowDate').textContent=snowSourceLabel;
  }catch(error){
    if(!snowMode || generation!==snowMetadataGeneration)return;
    // Imagery works without the catalog endpoint; never invent an observation date.
    snowLayer.rasterId=null;
    snowSourceLabel='Latest daily IMS analysis · source date unavailable';
    $('snowDate').textContent=snowSourceLabel;
    console.warn('Snow metadata unavailable',error);
  }finally{
    if(snowMode && generation===snowMetadataGeneration){
      snowLayer.refreshKey=Date.now();
      snowLayer.redraw();
      $('snowRefresh').disabled=false;
    }
  }
}
$('snowOn').addEventListener('change',()=>{$('snowOn').checked?enterSnowView():exitSnowView();});
$('snowOpacity').addEventListener('input',()=>{
  $('snowOpacityVal').textContent=$('snowOpacity').value+'%';
  snowLayer.setOpacity(Number($('snowOpacity').value)/100);
});
$('snowRefresh').addEventListener('click',refreshSnowCoverage);
$('snowOverview').addEventListener('click',()=>map.fitBounds([[0,-180],[83,180]],{padding:[16,16],animate:false}));
$('snowReturn').addEventListener('click',()=>{exitSnowView();closeWeatherPanel(true);});
