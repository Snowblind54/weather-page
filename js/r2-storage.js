// Route only this site's generated weather files. Official provider requests
// and static coastline geometry keep their existing URLs and behaviour.
(() => {
  const base = window.WEATHER_R2_BASE;
  if (!base) return;
  const nativeFetch = window.fetch.bind(window);
  const site = new URL('.', window.location.href);
  function dataPath(value) {
    const url = new URL(value, site);
    let path = null;
    if (url.origin === site.origin && url.pathname.startsWith(site.pathname + 'data/')) {
      path = url.pathname.slice(site.pathname.length);
    } else if (url.origin === 'https://raw.githubusercontent.com' &&
               url.pathname.startsWith('/Snowblind54/weather-page/main/data/')) {
      path = url.pathname.slice('/Snowblind54/weather-page/main/'.length);
    }
    if (!path || path === 'data/estonia-marine-warning-zones.geojson') return null;
    return path + url.search;
  }
  window.weatherDataUrl = value => {
    const path = dataPath(value);
    return path ? base.replace(/\/$/, '') + '/weather/' + path : value;
  };
  window.fetch = async (input, options = {}) => {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const original = isRequest ? input.url : String(input);
    const method = options.method || (isRequest ? input.method : 'GET');
    const target = window.weatherDataUrl(original);
    if (target === original || !['GET', 'HEAD'].includes(method.toUpperCase())) {
      return nativeFetch(input, options);
    }
    const signal = options.signal || (isRequest ? input.signal : undefined);
    try {
      const remote = isRequest ? new Request(target, input) : target;
      const response = await nativeFetch(remote, {...options, credentials: 'omit'});
      if (response.ok) return response;
      if (signal?.aborted) return response;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return nativeFetch(input, options);
  };
})();
