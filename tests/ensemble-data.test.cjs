const {test}=require('node:test'),assert=require('node:assert/strict'),api=require('../js/ensemble-data.js'),fs=require('node:fs'),vm=require('node:vm');
function response(values=[[0,1],[-2,null],[2,3]]){const h={time:[1800000000,1800003600]},units={time:'unixtime'};values.forEach((v,i)=>{const key='temperature_2m'+(i?'_member'+String(i).padStart(2,'0'):'');h[key]=v;units[key]='°C'});return {hourly:h,hourly_units:units,timezone:'Europe/Tallinn',elevation:145,latitude:58,longitude:26};}

test('requests keep ECMWF and GFS separate and ask for individual 2 m temperatures over 15 days',()=>{
 for(const [id,model]of [['ecmwf','ecmwf_ifs025'],['gfs','gfs05']]){const url=new URL(api.url({lat:58.06,lon:26.5},id));assert.equal(url.searchParams.get('models'),model);assert.equal(url.searchParams.get('hourly'),'temperature_2m');assert.equal(url.searchParams.get('forecast_days'),'15');assert.equal(url.searchParams.get('timeformat'),'unixtime');assert.equal(url.searchParams.get('timezone'),'auto');}
 assert.throws(()=>api.url({lat:91,lon:20},'gfs'));assert.throws(()=>api.url({lat:58,lon:20},'unknown'));
});

test('member averages, central percentiles and below-freezing fractions use only real values',()=>{
 const d=api.normalize(response(),'ecmwf',123),s=api.statistics(d);assert.equal(d.members.length,3);assert.equal(d.fetchedAt,123);
 assert.equal(s[0].mean,0);assert.equal(s[0].count,3);assert.equal(s[0].belowZero,1/3);assert(Math.abs(s[0].p10+1.6)<1e-9);assert(Math.abs(s[0].p90-1.6)<1e-9);
 assert.equal(s[1].count,2);assert.equal(s[1].mean,2);assert.equal(d.members[1][1],null,'missing is not zero');
 const g=api.statistics(api.normalize(response([[10,20],[20,30]]),'gfs'));assert.equal(g[0].mean,15);assert.equal(s[0].mean,0,'models never share an average');
});

test('invalid units, time axes and unavailable members are rejected rather than fabricated',()=>{
 const f=response();f.hourly_units.temperature_2m='°F';assert.throws(()=>api.normalize(f,'ecmwf'));
 const t=response();t.hourly.time.reverse();assert.throws(()=>api.normalize(t,'ecmwf'));
 assert.throws(()=>api.normalize(response([[1,2]]),'gfs'));
 assert.throws(()=>api.normalize(response([[null,null],[null,null]]),'ecmwf'));
 const partial=api.normalize(response([[1,null],[2,null]]),'ecmwf');assert.equal(api.statistics(partial)[1],null);
 const bad=api.normalize(response([[false,2],[Infinity,3],[0,1]]),'gfs');assert.equal(api.statistics(bad)[0],null);assert.equal(bad.members[2][0],0);
});

test('each location and model is cached independently and errors do not poison later retries',async()=>{
 let requests=0;const fetcher=async()=>{requests++;return {ok:true,json:async()=>response()}};const p={lat:57.123,lon:25.321};
 await api.load(p,'ecmwf',{fetcher});await api.load(p,'ecmwf',{fetcher});assert.equal(requests,1);
 await api.load(p,'gfs',{fetcher});assert.equal(requests,2);await api.load({...p,lat:57.124},'gfs',{fetcher});assert.equal(requests,3);
 const q={lat:56,lon:26};await assert.rejects(api.load(q,'gfs',{fetcher:async()=>({ok:false,status:429})}),/busy/);
 await api.load(q,'gfs',{fetcher});assert.equal(requests,4);
});

test('cache keys preserve nearby mountain locations instead of merging a whole model grid cell',()=>{
 assert.notDeepEqual(api.location({lat:45.83,lon:6.86}),api.location({lat:45.84,lon:6.86}));
});

test('chart installation makes no network calls or hidden DOM work before it is opened',()=>{
 let calls=0;const c={window:{NorthernEnsembleData:{models:api.models,load(){calls++}}},document:{createElement(){throw new Error('Chart must be lazy')}},localStorage:{getItem:()=>null},console};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/ensemble-chart.js','utf8'),c);assert.equal(calls,0);assert.equal(typeof c.window.NorthernEnsembleForecast.open,'function');
});
