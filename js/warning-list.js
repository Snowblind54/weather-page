// Keep the warning list small. Every record remains available through paging.
(function(root){
  'use strict';
  let state=null;
  function update(){
    if(!state)return;
    const s=state;
    s.pending=s.pending.filter(job=>s.visible(job.record));
    if(!s.pending.length){s.button?.remove();s.button=null;return;}
    if(!s.button){
      s.button=document.createElement('button');s.button.type='button';s.button.className='warning-load-more';
      s.button.addEventListener('click',()=>{
        if(state!==s)return;s.button.remove();
        const jobs=s.pending.splice(0,50);for(const job of jobs)if(s.visible(job.record))s.list.appendChild(job.create());
        s.button=null;update();
      });s.list.appendChild(s.button);
    }
    s.button.textContent='Show '+Math.min(50,s.pending.length)+' more warnings ('+s.pending.length+' remaining)';
  }
  root.NorthernWarningList={
    begin(list,visible=()=>true){state={list,visible,pending:[],shown:0,button:null};},
    append(list,record,create){
      if(!state||state.list!==list||state.shown<50){list.appendChild(create());if(state)state.shown++;}
      else state.pending.push({record,create});
    },
    finish:update,purge:update,clear(){state?.button?.remove();state=null;}
  };
})(window);
