const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function snowContext() {
  const nodes = {};
  const labels = [];
  const context = vm.createContext({
    Date, Intl, console, setTimeout, clearTimeout, snowMode: true,
    $: id => nodes[id] ||= {checked: true, addEventListener() {}},
    L: {
      layerGroup: () => ({clearLayers() {labels.length = 0;}, addTo() {}}),
      latLng: (lat, lng) => ({lat, lng}), divIcon: options => options,
      marker: (ll, options) => ({bindPopup(html) {this.popup = html; return this;},
        addTo() {labels.push({ll, options, html: this.popup});}})
    },
    map: {on() {}, hasLayer: () => false, getBounds: () => ({contains: () => true}),
      getSize: () => ({x: 1000, y: 700}), getCenter: () => ({lng: -90}), getZoom: () => 6,
      latLngToContainerPoint: ll => ({x: (ll.lng+180)*4, y: (90-ll.lat)*7})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/snow-depth.js'), 'utf8'), context);
  return {context, nodes, labels};
}

test('Canadian and Greenland stations render with official sources and missing-data status', () => {
  const {context, nodes, labels} = snowContext();
  const time = Math.floor(Date.now()/1000)-60;
  const ca = {country:'CA', code:'A', name:'Inuvik', lat:68.3, lon:-133.7,
    time, timePrecision:'instant', depthCm:9, state:'depth', quality:'approved'};
  const gl = {country:'GL', code:'B', name:'Nuuk', lat:64.2, lon:-51.7,
    time, timePrecision:'instant', depthCm:null, state:'trace', quality:'provisional'};
  context.snapshot = {stations:[ca, gl], providers:{GL:{status:'no-data'}}};
  vm.runInContext('snowDepthData=snapshot; renderSnowDepth()', context);
  assert.equal(labels.length, 2);
  assert.match(labels[0].html, /Environment and Climate Change Canada/);
  assert.match(labels[0].html, /Quality checked/);
  assert.match(labels[1].html, /Danish Meteorological Institute/);
  assert.match(labels[1].html, /&lt;0\.5 cm/);
  assert.match(nodes.snowDepthStatus.textContent, /GL: 1 \(no recent measurements\)/);
  context.snapshot.stations = [ca];
  vm.runInContext('renderSnowDepth()', context);
  assert.match(nodes.snowDepthStatus.textContent, /GL: 0 \(no recent measurements\)/);
});

test('Canadian zero toggle and country bounds preserve existing European rules', () => {
  const {context, nodes, labels} = snowContext();
  const row = {country:'CA', name:'Inuvik', lat:68.3, lon:-133.7,
    time:Math.floor(Date.now()/1000)-60, depthCm:0, state:'bare'};
  context.row = row;
  assert.equal(vm.runInContext('snowDepthValid(row)', context), true);
  assert.equal(vm.runInContext('snowDepthValid({...row,country:"FI"})', context), false);
  assert.equal(vm.runInContext('snowDepthValid({...row,lon:20})', context), false);
  assert.equal(vm.runInContext('snowDepthValid({...row,depthCm:null})', context), false);
  assert.equal(vm.runInContext('snowDepthValid({...row,time:row.time-8*86400})', context), false);
  context.snapshot = {stations:[row], providers:{}};
  nodes.snowDepthZero.checked = false;
  vm.runInContext('snowDepthData=snapshot; renderSnowDepth()', context);
  assert.equal(labels.length, 0);
  nodes.snowDepthZero.checked = true;
  vm.runInContext('renderSnowDepth()', context);
  assert.equal(labels.length, 1);
});
