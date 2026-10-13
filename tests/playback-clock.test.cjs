const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8').split("$('locateBtn').addEventListener")[0];
function harness(loadTime){
 let clock=0,resolve;const timers=[],el={play:{textContent:''},cloudOn:{checked:true},radarOn:{checked:false},timeline:{value:0,max:3,min:0}};
 const c={playing:false,timer:null,requestCloudHistory(){},$:id=>el[id],performance:{now:()=>clock},setTimeout:(fn,delay)=>{timers.push({fn,delay});return 1;},clearTimeout(){},console,applyFrame:()=>new Promise(r=>{resolve=()=>{clock+=loadTime;r();};})};
 vm.createContext(c);vm.runInContext(source,c);return {c,el,timers,finish:async()=>{resolve();await Promise.resolve();await Promise.resolve();}};
}
test('A cached frame holds only the remaining interval, not another full 900 ms',async()=>{const h=harness(200);h.c.start();await h.finish();assert.equal(h.timers[0].delay,700);});
test('Slow complete frame advances without adding another pause or overlapping loaders',async()=>{const h=harness(1400);h.c.start();assert.equal(h.timers.length,0);await h.finish();assert.equal(h.timers[0].delay,0);});
test('Stopping during frame loading does not restart playback',async()=>{const h=harness(1400);h.c.start();h.c.stop();await h.finish();assert.equal(h.timers.length,0);assert.equal(h.c.playing,false);});
