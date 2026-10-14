// Contour the same smoothed GFS pressure field at an interpolated model time.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NorthernCyclonePressure=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  let archiveRef=null,decoded=new Map(),lastKey='',lastFrame=null;
  function gridEqual(a,b){return ['width','height','west','south','dx','dy'].every(k=>a?.[k]===b?.[k]);}
  function validate(archive,modelRun,end){
    if(!archive)return;
    if(archive.version!==1||archive.modelRun!==modelRun||!Array.isArray(archive.frames)||archive.frames.length>8)throw Error('Invalid live pressure archive');
    let previous=-Infinity;
    for(const f of archive.frames){
      const g=f.grid,n=g?.width*g?.height;
      if(!Number.isInteger(f.time)||f.time%3600||f.time<modelRun||f.time>end||f.time<=previous||!Number.isInteger(g?.width)||!Number.isInteger(g?.height)||g.width<2||g.height<2||g.width>300||g.height>150||n>45000||![g.west,g.south,g.dx,g.dy].every(Number.isFinite)||g.dx!==.5||g.dy!==.5||g.west<-85||g.south<20||g.west+(g.width-1)*g.dx>45||g.south+(g.height-1)*g.dy>82||typeof f.values!=='string'||f.values.length!==4*Math.ceil(n*2/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.values))throw Error('Invalid live pressure frame');
      unpack(f);previous=f.time;
    }
  }
  function pair(archive,time){
    const frames=archive?.frames||[];
    for(let i=0;i<frames.length-1;i++){const a=frames[i],b=frames[i+1];if(a.time<=time&&time<=b.time&&b.time-a.time===3600&&gridEqual(a.grid,b.grid))return [a,b];}
    return null;
  }
  function canInterpolate(archive,time){return Boolean(pair(archive,time));}
  function unpack(frame){
    if(decoded.has(frame))return decoded.get(frame);
    const raw=typeof atob==='function'?atob(frame.values):Buffer.from(frame.values,'base64').toString('binary');
    if(raw.length!==frame.grid.width*frame.grid.height*2)throw Error('Invalid live pressure bytes');
    const values=new Float32Array(raw.length/2);
    for(let i=0;i<values.length;i++){values[i]=(raw.charCodeAt(i*2)+raw.charCodeAt(i*2+1)*256)/10;if(values[i]<850||values[i]>1100)throw Error('Invalid live pressure value');}
    decoded.set(frame,values);while(decoded.size>2)decoded.delete(decoded.keys().next().value);
    return values;
  }
  function contour(grid,values,interval=1){
    const {width:w,height:h,west,south,dx,dy}=grid,lines=[];
    let min=Infinity,max=-Infinity;for(const p of values){min=Math.min(min,p);max=Math.max(max,p);}
    const table={1:[[3,0]],2:[[0,1]],3:[[3,1]],4:[[1,2]],6:[[0,2]],7:[[3,2]],8:[[2,3]],9:[[0,2]],11:[[1,2]],12:[[3,1]],13:[[0,1]],14:[[3,0]]},empty=[],low=new Float32Array((w-1)*(h-1)),high=new Float32Array(low.length);
    for(let y=0;y<h-1;y++)for(let x=0;x<w-1;x++){const i=y*(w-1)+x;low[i]=Math.min(values[y*w+x],values[y*w+x+1],values[(y+1)*w+x],values[(y+1)*w+x+1]);high[i]=Math.max(values[y*w+x],values[y*w+x+1],values[(y+1)*w+x],values[(y+1)*w+x+1]);}
    for(let level=Math.ceil(min/interval)*interval;level<max;level+=interval){
      const nodes=new Map(),segments=[],base=h*(w-1);
      function edge(x,y,k,q){
        const id=k===0?y*(w-1)+x:k===2?(y+1)*(w-1)+x:k===1?base+y*w+x+1:base+y*w+x;
        if(!nodes.has(id)){
          const ends=k===0?[0,1]:k===1?[1,2]:k===2?[3,2]:[0,3],a=q[ends[0]],b=q[ends[1]],f=(level-a)/(b-a);
          const px=k===0||k===2?x+f:x+(k===1?1:0),py=k===0?y:k===2?y+1:y+f;
          nodes.set(id,{point:[west+px*dx,south+py*dy],edges:[]});
        }
        return id;
      }
      for(let y=0;y<h-1;y++)for(let x=0;x<w-1;x++){
        const cell=y*(w-1)+x;if(level<=low[cell]||level>high[cell])continue;
        const q=[values[y*w+x],values[y*w+x+1],values[(y+1)*w+x+1],values[(y+1)*w+x]],mask=q.reduce((m,v,i)=>m|(v>=level?1<<i:0),0);
        let pairs=table[mask]||empty;
        if(mask===5||mask===10){const high=q.reduce((a,b)=>a+b,0)/4>=level;pairs=(mask===5)===high?[[0,1],[2,3]]:[[0,3],[1,2]];}
        for(const [a,b] of pairs){const u=edge(x,y,a,q),v=edge(x,y,b,q),id=segments.length;segments.push([u,v]);nodes.get(u).edges.push(id);nodes.get(v).edges.push(id);}
      }
      const used=new Set();
      function walk(start){
        let id=start;const points=[nodes.get(id).point];
        for(;;){const e=nodes.get(id).edges.find(e=>!used.has(e));if(e===undefined)break;used.add(e);const [a,b]=segments[e];id=a===id?b:a;points.push(nodes.get(id).point);if(id===start)break;}
        if(points.length>1)lines.push({pressure:level,points});
      }
      for(const [id,n] of nodes)if(n.edges.length===1)walk(id);
      for(const [id,n] of nodes)if(n.edges.some(e=>!used.has(e)))walk(id);
    }
    return lines;
  }
  function frame(archive,time,interval=1){
    if(archiveRef!==archive){archiveRef=archive;decoded.clear();lastKey='';lastFrame=null;}
    const bracket=pair(archive,time);if(!bracket)return null;
    const key=time+'/'+interval;if(key===lastKey)return lastFrame;
    const [a,b]=bracket,p=unpack(a),q=unpack(b),f=(time-a.time)/(b.time-a.time),values=new Float32Array(p.length);
    for(let i=0;i<values.length;i++)values[i]=p[i]+(q[i]-p[i])*f;
    lastFrame={time,lines:contour(a.grid,values,interval),interpolated:true,from:a.time,to:b.time};lastKey=key;return lastFrame;
  }
  return {validate,canInterpolate,frame,contour};
});
