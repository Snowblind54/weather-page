// Baltic Weather Map v7.2 — shared configuration
const APP_CONFIG = Object.freeze({
  H5WASM_URL: 'https://cdn.jsdelivr.net/npm/h5wasm@0.10.1/dist/esm/hdf5_hl.js',
  RADAR_BOUNDS: [[56.48834379574241,20.354150207505985],[61.33568305549932,29.760049907697866]],
  CLOUD_BOUNDS: [[25,-85],[82,42]]
});

const RADAR_BOUNDS = APP_CONFIG.RADAR_BOUNDS;
const CLOUD_BOUNDS = APP_CONFIG.CLOUD_BOUNDS;

// Load the wind data-source override independently from the renderer. It can
// begin downloading while the remaining map scripts parse and installs itself
// as soon as wind.js is ready.
const sharedWindSourceScript=document.createElement('script');
sharedWindSourceScript.src='js/model-wind-source.js?v=1';
sharedWindSourceScript.async=true;
document.head.appendChild(sharedWindSourceScript);
