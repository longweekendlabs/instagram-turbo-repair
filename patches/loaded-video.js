/* Recover clear MP4 bytes already appended to the exact page MediaSource. */
globalThis.__lwlLoadedVideo=(()=>{
  const sources=new WeakMap(),urls=new Map(),limit=128*1024*1024;
  let retained=0;
  const onStoryRoute=()=>location.pathname.startsWith('/stories/');
  const ascii=(data,at,n)=>String.fromCharCode(...data.subarray(at,at+n));
  function boxes(data,start=0,end=data.length){
    const result=[];let at=start;const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    while(at<end){
      if(end-at<8)throw new Error('Incomplete MP4 box.');
      let size=view.getUint32(at),header=8;
      if(size===1){if(end-at<16)throw new Error('Incomplete MP4 box.');size=Number(view.getBigUint64(at+8));header=16;}
      if(size===0)size=end-at;
      if(!Number.isSafeInteger(size) || size<header || at+size>end)throw new Error('Incomplete MP4 data.');
      result.push({type:ascii(data,at+4,4),start:at,end:at+size,header});at+=size;
    }return result;
  }
  function join(parts){const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
  function box(type,parts){const data=join(parts),out=new Uint8Array(data.length+8);new DataView(out.buffer).setUint32(0,out.length);for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);out.set(data,8);return out;}
  const bytes=(data,node)=>data.slice(node.start,node.end);
  function children(data,node){return boxes(data,node.start+node.header,node.end);}
  function set32(data,at,value){new DataView(data.buffer,data.byteOffset,data.byteLength).setUint32(at,value);}
  function get32(data,at){return new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(at);}
  function merge(streams){
    if(!streams.length || streams.length>4)throw new Error('No complete captured video streams.');
    const parsed=streams.map(data=>({data,nodes:boxes(data)}));
    let next=1,sequence=1;const tracks=[],extendsBoxes=[],segments=[];let ftyp,header;
    for(const {data,nodes} of parsed){
      const movies=nodes.filter(n=>n.type==='moov');
      if(movies.length!==1 || !nodes.some(n=>n.type==='ftyp') || !nodes.some(n=>n.type==='moof'))throw new Error('Unsupported captured MP4 layout.');
      const movie=movies[0],parts=children(data,movie),ids=new Map();
      // Refuse encrypted sample entries; this handles only media available in clear form.
      let text='';for(let at=movie.start;at<movie.end;at+=8192)text+=ascii(data,at,Math.min(8192,movie.end-at));
      if(/encv|enca|pssh/.test(text))throw new Error('Encrypted captured media is unsupported.');
      ftyp ||= bytes(data,nodes.find(n=>n.type==='ftyp'));
      const mvhd=parts.find(n=>n.type==='mvhd');if(!mvhd)throw new Error('Missing MP4 movie header.');header ||= bytes(data,mvhd);
      for(const track of parts.filter(n=>n.type==='trak')){
        const copy=bytes(data,track),tkhd=children(copy,boxes(copy)[0]).find(n=>n.type==='tkhd');
        if(!tkhd)throw new Error('Missing MP4 track header.');
        const at=tkhd.start+tkhd.header+(copy[tkhd.start+tkhd.header]===1?20:12),old=get32(copy,at),id=next++;
        ids.set(old,id);set32(copy,at,id);tracks.push(copy);
      }
      const mvex=parts.find(n=>n.type==='mvex');if(!mvex)throw new Error('Missing fragment initialization.');
      for(const trex of children(data,mvex).filter(n=>n.type==='trex')){
        const copy=bytes(data,trex),id=ids.get(get32(copy,trex.header+4));if(!id)throw new Error('Unknown MP4 track.');set32(copy,trex.header+4,id);extendsBoxes.push(copy);
      }
      for(let i=0;i<nodes.length;i++)if(nodes[i].type==='moof'){
        if(nodes[i+1]?.type!=='mdat')throw new Error('Missing fragment samples.');
        const fragment=bytes(data,nodes[i]),root=boxes(fragment)[0];
        for(const child of children(fragment,root)){
          if(child.type==='mfhd')set32(fragment,child.start+child.header+4,sequence++);
          if(child.type==='traf')for(const field of children(fragment,child))if(field.type==='tfhd'){
            const flags=get32(fragment,field.start+field.header)&0xffffff;
            if((flags&1) || !(flags&0x020000))throw new Error('Captured fragment has unsupported absolute offsets.');
            const at=field.start+field.header+4,id=ids.get(get32(fragment,at));if(!id)throw new Error('Unknown fragment track.');set32(fragment,at,id);
          }
        }
        segments.push(fragment,bytes(data,nodes[++i]));
      }
    }
    set32(header,header.length-4,next);
    return new Blob([ftyp,box('moov',[header,...tracks,box('mvex',extendsBoxes)]),...segments],{type:'video/mp4'});
  }
  function record(source){let r=sources.get(source);if(!r){r={source,buffers:[],size:0,overflow:false};sources.set(source,r);}return r;}
  function drop(r){if(!r || r.pinned)return;retained-=r.size;r.size=0;r.blob=undefined;for(const b of r.buffers || [])b.parts=[];r.overflow=true;}
  function start(){
    const create=URL.createObjectURL;
    URL.createObjectURL=function(value){
      const url=Reflect.apply(create,this,arguments);
      if(!onStoryRoute())return url;
      if(typeof MediaSource!=='undefined' && value instanceof MediaSource)urls.set(url,record(value));
      else if(value instanceof Blob && /video\/mp4/.test(value.type) && value.size<=limit){
        if(retained+value.size>limit)for(const old of urls.values()){drop(old);if(retained+value.size<=limit)break;}
        if(retained+value.size<=limit){urls.set(url,{blob:value,size:value.size});retained+=value.size;}
      }
      while(urls.size>8){const first=[...urls].find(([,value])=>!value.pinned);if(!first)break;drop(first[1]);urls.delete(first[0]);}
      return url;
    };
    if(typeof MediaSource==='undefined')return;
    const add=MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer=function(mime){
      const buffer=Reflect.apply(add,this,arguments);
      const r=sources.get(this);
      if(!onStoryRoute() || !r)return buffer;
      const entry={buffer,mime,parts:[]};r.buffers.push(entry);
      const append=buffer.appendBuffer;
      buffer.appendBuffer=function(value){
        const result=Reflect.apply(append,this,arguments);
        if(!onStoryRoute())return result;
        try{
          if(!r.overflow){const source=ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
            if(retained+source.length>limit)for(const old of urls.values()){if(old!==r)drop(old);if(retained+source.length<=limit)break;}
            if(retained+source.length>limit){drop(r);r.overflow=true;}
            else{const copy=source.slice();entry.parts.push(copy);r.size+=copy.length;retained+=copy.length;}
          }
        }catch{r.overflow=true;}
        return result;
      };
      return buffer;
    };
  }
  async function capture(url,element){
    const r=urls.get(url);
    if(!r){
      // Some players use an ordinary Blob rather than MediaSource.
      let response;try{response=await fetch(url);}catch{throw new Error('The loaded video was created before capture was active. Reload Instagram and reopen it.');}const blob=await response.blob();
      if(!response.ok || !blob.size || blob.size>limit)throw new Error('The loaded video is not available as a file. Reload Instagram and reopen the video.');
      const data=new Uint8Array(await blob.arrayBuffer());if(!boxes(data).some(n=>n.type==='moov'))throw new Error('The loaded video has no complete MP4 initialization.');
      return new Blob([blob],{type:'video/mp4'});
    }
    if(r.overflow)throw new Error('The loaded video bytes are no longer retained. Reload Instagram and reopen the video.');
    if(r.blob){const data=new Uint8Array(await r.blob.arrayBuffer()),types=boxes(data).map(n=>n.type);if(!types.includes('moov') || !types.includes('mdat'))throw new Error('The loaded video file is incomplete.');return r.blob;}
    r.pinned=true;
    try{
      const deadline=Date.now()+15000;
      function complete(){const ranges=element.buffered,duration=element.duration;return r.source.readyState==='ended' && Number.isFinite(duration) && duration>0 && ranges?.length===1 && ranges.start(0)<=.1 && ranges.end(0)>=duration-.15 && r.buffers.every(b=>!b.buffer.updating);}
      while(!complete() && Date.now()<deadline && !r.overflow){if((element.currentSrc || element.src)!==url)throw new Error('The selected video changed while buffering. Open it again and retry.');await new Promise(resolve=>setTimeout(resolve,200));}
      if(r.overflow)throw new Error('The loaded-video capture exceeded its memory limit.');
      if(!complete())throw new Error('The video is not fully buffered yet. Let it play once, then download it.');
      if(r.buffers.some(b=>!/(?:audio|video)\/mp4/.test(b.mime)))throw new Error('This loaded video format is unsupported.');
      return merge(r.buffers.map(b=>join(b.parts)));
    }finally{r.pinned=false;}
  }
  function state(url){const r=urls.get(url);return {captureMapped:!!r,captureBuffers:r?.buffers?.length || 0,captureOverflow:!!r?.overflow};}
  return {start,capture,merge,boxes,state};
})();
__lwlLoadedVideo.start();
