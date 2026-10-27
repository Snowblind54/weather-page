const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('A list with 5000 warnings creates only the visible page, keeps later details lazy, and expires queued records',()=>{
 const list={children:[],appendChild(e){e.parent=this;this.children.push(e);}},document={createElement:()=>({events:{},addEventListener(n,f){this.events[n]=f;},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}})};
 const c={window:{},document};vm.createContext(c);vm.runInContext(fs.readFileSync('js/warning-list.js','utf8'),c);
 const api=c.window.NorthernWarningList,records=Array.from({length:5000},(_,i)=>({i,active:true}));let built=0;
 api.begin(list,r=>r.active);for(const r of records)api.append(list,r,()=>{built++;return {warningRecord:r};});api.finish();
 assert.equal(built,50);assert.equal(list.children.length,51);assert.match(list.children.at(-1).textContent,/4950 remaining/);
 records[50].active=false;api.purge();assert.match(list.children.at(-1).textContent,/4949 remaining/);
 list.children.at(-1).events.click();assert.equal(built,100);assert.equal(list.children.length,101);assert(!list.children.some(e=>e.warningRecord===records[50]));
 api.begin(list);api.clear();assert.equal(built,100,'clearing never creates hidden warning cards');
});
