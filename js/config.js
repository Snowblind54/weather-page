// Baltic Weather Map v7.2 — shared configuration
const APP_CONFIG = Object.freeze({
  H5WASM_URL: 'https://cdn.jsdelivr.net/npm/h5wasm@0.10.1/dist/esm/hdf5_hl.js',
  RADAR_BOUNDS: [[56.48834379574241,20.354150207505985],[61.33568305549932,29.760049907697866]],
  CLOUD_BOUNDS: [[25,-85],[82,42]]
});

const RADAR_BOUNDS = APP_CONFIG.RADAR_BOUNDS;
const CLOUD_BOUNDS = APP_CONFIG.CLOUD_BOUNDS;

// Install the Space Weather shell before ui.js runs so it participates in the
// same navigation, panel and accessibility behaviour as the weather sections.
(function installSpaceWeatherShell(){
  if(document.getElementById('spaceWeatherSection'))return;
  const nav=document.querySelector('.category-nav');
  if(!nav)return;

  const style=document.createElement('link');
  style.rel='stylesheet';style.href='css/space-weather.css?v=3';
  document.head.appendChild(style);

  const button=document.createElement('button');
  button.className='category-tab';
  button.id='nav-spaceWeatherSection';
  button.dataset.panel='spaceWeatherSection';
  button.setAttribute('aria-controls','spaceWeatherSection');
  button.setAttribute('aria-expanded','false');
  button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16c3-6 6-8 9-8s6 2 9 8"/><path d="M5 18c2.5-4 4.8-5.5 7-5.5s4.5 1.5 7 5.5"/><path d="M12 3v2M5.5 5.5 7 7M18.5 5.5 17 7"/></svg><span>Space Weather</span><span class="layer-dot" aria-hidden="true"></span>';
  nav.appendChild(button);

  const panel=document.createElement('div');
  panel.className='weather-panel weather-section space-weather-panel';
  panel.id='spaceWeatherSection';
  panel.hidden=true;
  panel.setAttribute('role','region');
  panel.setAttribute('aria-labelledby','spaceWeatherSection-title');
  panel.innerHTML=`
    <div class="panel-heading">
      <div><div class="eyebrow">SPACE WEATHER</div><h2 id="spaceWeatherSection-title">Northern Lights</h2><p>Aurora forecast &amp; viewing conditions</p></div>
      <div class="panel-actions"><button class="info-button" data-info="spaceWeatherSection-sources" aria-controls="spaceWeatherSection-sources" aria-expanded="false" aria-label="Space weather sources">i</button><button class="close-panel" aria-label="Close Space Weather menu">×</button></div>
    </div>
    <div id="spaceWeatherSection-sources" class="source-card" hidden>
      <h3>Sources &amp; attribution</h3>
      <p>NOAA Space Weather Prediction Center (SWPC): OVATION short-term aurora forecast, northern hemispheric auroral power, observed planetary Kp and real-time solar-wind measurements. ECMWF IFS Open Data supplies total cloud cover on a 0.25° global grid. Viewing conditions are a Northern Weather derived layer combining NOAA OVATION, astronomical darkness and ECMWF total cloud cover.</p>
      <div class="source-links"><a href="https://www.spaceweather.gov/products/aurora-30-minute-forecast" target="_blank" rel="noopener">NOAA Aurora ↗</a><a href="https://services.swpc.noaa.gov/text/aurora-nowcast-hemi-power.txt" target="_blank" rel="noopener">NOAA Aurora Power ↗</a><a href="https://www.spaceweather.gov/products/solar-wind" target="_blank" rel="noopener">NOAA Solar Wind ↗</a><a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF Open Data ↗</a></div>
      <div class="small">OVATION is a forecast, not an observation of visible aurora. Hemispheric power is the modeled total auroral energy input over the northern hemisphere, not a local viewing percentage. The viewing layer reduces visibility for daylight/twilight and modelled cloud cover. Local light pollution, terrain, haze and horizon obstructions are not modelled.</div>
    </div>

    <div class="section space-layer-section">
      <div class="space-section-title"><div><div class="label">Aurora layers</div><div class="small">Forecast or local viewing conditions</div></div></div>
      <div class="row"><label class="label"><input id="auroraOn" type="checkbox"> Aurora forecast</label><span class="badge">NOAA OVATION</span></div>
      <div class="row"><label class="label"><input id="auroraViewingOn" type="checkbox"> Aurora viewing conditions</label><span class="badge">aurora + dark + ECMWF cloud</span></div>
      <div class="small space-weather-help">Viewing conditions combine NOAA OVATION with astronomical darkness and ECMWF IFS total cloud cover. Click the map while either aurora layer is on to see the local viewing estimate.</div>
      <label class="small" for="auroraOpacity">Layer opacity</label>
      <div class="grid2"><input id="auroraOpacity" type="range" min="20" max="90" value="68" step="2"><span id="auroraOpacityVal" class="value">68%</span></div>
      <div class="space-aurora-legend" aria-label="Aurora forecast intensity"><span>Low</span><i></i><span>High</span></div>
      <div id="spaceWeatherStatus" class="status" role="status">Space weather layers are off.</div>
    </div>

    <div class="section space-dashboard-section">
      <div class="space-section-title"><div><div class="label">Aurora now</div><div class="small">NOAA OVATION &amp; geomagnetic activity</div></div><button id="spaceWeatherRefresh" type="button" title="Refresh space weather">↻</button></div>
      <div class="space-dashboard space-dashboard-aurora">
        <div class="space-metric space-metric-power">
          <div class="space-metric-heading"><span>Aurora power</span><button class="space-metric-info" type="button" data-space-help="spaceHelpPower" aria-controls="spaceHelpPower" aria-expanded="false" aria-label="Why hemispheric aurora power matters">i</button></div>
          <strong id="spacePowerValue">—</strong><small id="spacePowerMeta">Loading…</small>
          <div id="spacePowerAge" class="space-data-age">Update time unavailable</div>
          <div id="spaceHelpPower" class="space-metric-help" hidden>NOAA OVATION hemispheric power estimates the total auroral particle energy deposited over one hemisphere. Higher gigawatts usually mean a stronger, broader auroral oval. It is not a local visibility percentage.</div>
        </div>
        <div class="space-metric">
          <div class="space-metric-heading"><span>Kp</span><button class="space-metric-info" type="button" data-space-help="spaceHelpKp" aria-controls="spaceHelpKp" aria-expanded="false" aria-label="Why Kp matters">i</button></div>
          <strong id="spaceKpValue">—</strong><small id="spaceKpMeta">Loading…</small>
          <div id="spaceKpAge" class="space-data-age">Update time unavailable</div>
          <div id="spaceHelpKp" class="space-metric-help" hidden>Kp measures global geomagnetic disturbance. Higher Kp usually means the auroral oval expands farther south and aurora can become stronger.</div>
        </div>
      </div>
      <div class="space-forecast-row"><span>OVATION forecast</span><strong id="spaceForecastTime">—</strong></div>
      <div id="spaceObservationTime" class="small">OVATION input —</div>
      <div id="spaceOvationAge" class="space-data-age">Update time unavailable</div>
    </div>

    <div class="section space-dashboard-section">
      <div class="space-section-title"><div><div class="label">Solar wind</div><div class="small">Measurements upstream at L1</div></div></div>
      <div class="space-dashboard">
        <div class="space-metric">
          <div class="space-metric-heading"><span>Speed</span><button class="space-metric-info" type="button" data-space-help="spaceHelpWind" aria-controls="spaceHelpWind" aria-expanded="false" aria-label="Why solar wind speed matters">i</button></div>
          <strong id="spaceWindValue">—</strong><small>Solar-wind speed</small>
          <div id="spaceWindAge" class="space-data-age">Update time unavailable</div>
          <div id="spaceHelpWind" class="space-metric-help" hidden>Fast solar wind delivers energy to Earth more quickly. High speed alone is not enough, but it can intensify aurora when the magnetic field is favorably oriented.</div>
        </div>
        <div class="space-metric">
          <div class="space-metric-heading"><span>IMF Bz</span><button class="space-metric-info" type="button" data-space-help="spaceHelpBz" aria-controls="spaceHelpBz" aria-expanded="false" aria-label="Why IMF Bz matters">i</button></div>
          <strong id="spaceBzValue">—</strong><small id="spaceBzMeta">Loading…</small>
          <div id="spaceBzAge" class="space-data-age">Update time unavailable</div>
          <div id="spaceHelpBz" class="space-metric-help" hidden>Bz is the north-south direction of the solar-wind magnetic field. Negative (southward) Bz couples more efficiently with Earth's field and is one of the strongest signs that aurora may intensify.</div>
        </div>
      </div>
    </div>

    <div class="section space-dashboard-section">
      <div class="space-section-title"><div><div class="label">Viewing conditions</div><div class="small">Cloud model used by the viewing layer</div></div></div>
      <div class="space-condition-row"><span>ECMWF total cloud cover</span><strong id="spaceCloudValid">Loading…</strong></div>
      <div id="spaceCloudAge" class="space-data-age">Loads when Space Weather opens</div>
      <div class="small space-condition-note">Astronomical darkness is calculated continuously for each map position. The ECMWF cloud field is combined with OVATION only when “Aurora viewing conditions” is enabled.</div>
    </div>`;
  panel.addEventListener('click',event=>{
    const info=event.target.closest('.space-metric-info');
    if(!info)return;
    const help=panel.querySelector('#'+info.dataset.spaceHelp);
    if(!help)return;
    const opening=help.hidden;
    for(const item of panel.querySelectorAll('.space-metric-help'))item.hidden=true;
    for(const button of panel.querySelectorAll('.space-metric-info'))button.setAttribute('aria-expanded','false');
    help.hidden=!opening;
    info.setAttribute('aria-expanded',String(opening));
  });
  document.body.appendChild(panel);
})();

// Load the wind data-source override independently from the renderer. It can
// begin downloading while the remaining map scripts parse and installs itself
// as soon as wind.js is ready.
const sharedWindSourceScript=document.createElement('script');
sharedWindSourceScript.src='js/model-wind-source.js?v=1';
sharedWindSourceScript.async=true;
document.head.appendChild(sharedWindSourceScript);

// Wind chill, satellite compatibility and Space Weather depend on modules that
// are defined by the synchronous scripts below config.js, so install them after
// page load.
window.addEventListener('load',()=>{
  const cloudNordicScript=document.createElement('script');
  cloudNordicScript.src='js/cloud-nordic-coverage.js?v=4';
  cloudNordicScript.onload=()=>{
    window.installNordicCloudCoverage?.();

    const cloudEumetScript=document.createElement('script');
    cloudEumetScript.src='js/cloud-eumet-cleanup.js?v=1';
    cloudEumetScript.onload=()=>{
      window.installEumetCleanClouds?.();

      const cloudArcticScript=document.createElement('script');
      cloudArcticScript.src='js/cloud-arctic-source.js?v=1';
      cloudArcticScript.onload=()=>window.installArcticCloudSource?.();
      document.body.appendChild(cloudArcticScript);
    };
    document.body.appendChild(cloudEumetScript);
  };
  document.body.appendChild(cloudNordicScript);

  const windChillScript=document.createElement('script');
  windChillScript.src='js/wind-chill.js?v=3';
  document.body.appendChild(windChillScript);

  const spaceWeatherScript=document.createElement('script');
  spaceWeatherScript.src='js/space-weather-v4.js?v=6';
  spaceWeatherScript.onload=()=>{
    const dashboardScript=document.createElement('script');
    dashboardScript.src='js/space-weather-dashboard.js?v=1';
    document.body.appendChild(dashboardScript);
  };
  document.body.appendChild(spaceWeatherScript);
});
