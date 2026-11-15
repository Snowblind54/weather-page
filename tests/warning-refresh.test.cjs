const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('open warning maps refresh every five minutes, pause when hidden or off, and coalesce overlap',async()=>{
 let tick,visible,release,calls=0;const checkbox={checked:true};
 const c={console:{warn(){}},document:{hidden:false,addEventListener:(name,fn)=>{assert.equal(name,'visibilitychange');visible=fn;}},
   $:()=>checkbox,setInterval:(fn,ms)=>{assert.equal(ms,300000);tick=fn;},
   loadWarnings:async(force)=>{assert.equal(force,false);calls++;await new Promise(r=>release=r);}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/warning-refresh.js','utf8'),c);
 const first=tick();tick();visible();assert.equal(calls,1);
 release();await first;
 c.document.hidden=true;await tick();assert.equal(calls,1);
 c.document.hidden=false;const next=visible();assert.equal(calls,2);release();await next;
 checkbox.checked=false;await tick();assert.equal(calls,2);
 checkbox.checked=true;c.loadWarnings=async()=>{calls++;throw Error('offline');};
 await tick();await tick();assert.equal(calls,4);
});
