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
  style.rel='stylesheet';style.href='css/space-weather.css?v=1';
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
      <p>NOAA Space Weather Prediction Center (SWPC): OVATION short-term aurora forecast, observed planetary Kp and real-time solar-wind measurements. Viewing conditions are a Northern Weather derived layer combining the NOAA aurora forecast with astronomical darkness.</p>
      <div class="source-links"><a href="https://www.spaceweather.gov/products/aurora-30-minute-forecast" target="_blank" rel="noopener">NOAA Aurora ↗</a><a href="https://www.spaceweather.gov/products/solar-wind" target="_blank" rel="noopener">NOAA Solar Wind ↗</a></div>
      <div class="small">OVATION is a forecast, not an observation of visible aurora. The viewing layer accounts for daylight and twilight only; it does not currently account for cloud, local light pollution or horizon conditions. The shared NOAA snapshot is collected server-side so visitors do not query SWPC directly.</div>
    </div>
    <div class="row"><label class="label"><input id="auroraOn" type="checkbox"> Aurora forecast</label><span class="badge">NOAA OVATION</span></div>
    <div class="row"><label class="label"><input id="auroraViewingOn" type="checkbox"> Aurora viewing conditions</label><span class="badge">aurora + darkness</span></div>
    <div class="small space-weather-help">Viewing conditions dim the aurora in daylight and twilight. Satellite cloud imagery is not used in this layer.</div>
    <label class="small" for="auroraOpacity">Layer opacity</label>
    <div class="grid2"><input id="auroraOpacity" type="range" min="20" max="90" value="68" step="2"><span id="auroraOpacityVal" class="value">68%</span></div>
    <div class="space-aurora-legend" aria-label="Aurora forecast intensity"><span>Low</span><i></i><span>High</span></div>
    <div id="spaceWeatherStatus" class="status" role="status">Space weather layers are off.</div>
    <div class="section space-dashboard-section">
      <div class="row"><div><div class="label">Current space weather</div><div class="small">Official NOAA SWPC data</div></div><button id="spaceWeatherRefresh" type="button" title="Refresh space weather">↻</button></div>
      <div class="space-dashboard">
        <div class="space-metric"><span>Kp</span><strong id="spaceKpValue">—</strong><small id="spaceKpMeta">Loading…</small></div>
        <div class="space-metric"><span>Solar wind</span><strong id="spaceWindValue">—</strong><small>Speed at L1</small></div>
        <div class="space-metric wide"><span>IMF Bz</span><strong id="spaceBzValue">—</strong><small id="spaceBzMeta">Loading…</small></div>
      </div>
      <div class="space-forecast-row"><span>OVATION forecast</span><strong id="spaceForecastTime">—</strong></div>
      <div id="spaceObservationTime" class="small">OVATION input —</div>
    </div>`;
  document.body.appendChild(panel);
})();

// Load the wind data-source override independently from the renderer. It can
// begin downloading while the remaining map scripts parse and installs itself
// as soon as wind.js is ready.
const sharedWindSourceScript=document.createElement('script');
sharedWindSourceScript.src='js/model-wind-source.js?v=1';
sharedWindSourceScript.async=true;
document.head.appendChild(sharedWindSourceScript);

// Wind chill and Space Weather depend on weather modules that are defined by
// the synchronous scripts below config.js, so install them after page load.
window.addEventListener('load',()=>{
  const windChillScript=document.createElement('script');
  windChillScript.src='js/wind-chill.js?v=3';
  document.body.appendChild(windChillScript);

  const spaceWeatherScript=document.createElement('script');
  spaceWeatherScript.src='js/space-weather-v4.js?v=5';
  document.body.appendChild(spaceWeatherScript);
});
