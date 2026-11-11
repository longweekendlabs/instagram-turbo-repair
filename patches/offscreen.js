/* Own-origin blobs keep the generic Instagram organizer rule out of automatic downloads. */
const jobs=new Map();
const mediaCache=new LWLMediaCache();
async function fetchMedia(token,url,key){
  const controller=new AbortController(),job={controller};jobs.set(token,job);
  try{
    const host=new URL(url);
    if(host.protocol!=='https:' || !['cdninstagram.com','cdninstagram.net','fbcdn.net','instagram.com'].some(domain=>host.hostname===domain || host.hostname.endsWith('.'+domain)))throw new Error('Unsupported Instagram media host.');
    let blob=await mediaCache.get(key).catch(()=>undefined),cacheHit=!!blob;
    controller.signal.throwIfAborted();
    if(!blob){
      const response=await fetch(url,{credentials:'omit',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
      if(!response.ok)throw new Error(`Instagram refused a media file (HTTP ${response.status}).`);
      blob=await response.blob();
      if(blob.size)await mediaCache.put(key,blob).catch(()=>{});
    }
    controller.signal.throwIfAborted();
    if(!blob.size)throw new Error('Instagram returned an empty media file.');
    job.url=URL.createObjectURL(blob);
    const result=await chrome.runtime.sendMessage({type:'lwlManagedReady',token,url:job.url,cacheHit});
    if(!result?.ok)release(token);
  }catch(error){
    if(!controller.signal.aborted)await chrome.runtime.sendMessage({type:'lwlManagedFailed',token,error:
      /^(Instagram refused|Instagram returned|Unsupported Instagram)/.test(error.message)?error.message:'Could not fetch the media file. Check the connection and try again.'}).catch(()=>{});
    release(token);
  }
}
function release(token){const job=jobs.get(token);if(!job)return;job.controller.abort();if(job.url)URL.revokeObjectURL(job.url);jobs.delete(token);}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || message?.target!=='lwl-offscreen')return;
  if(message.type==='localStart'){jobs.set(message.token,{controller:new AbortController(),parts:[],received:0,size:message.size,key:message.key});respond({ok:true});return;}
  if(message.type==='localChunk'){
    try{const job=jobs.get(message.token);if(!job?.parts)throw new Error('Local video upload is unavailable.');
      const text=atob(message.data),bytes=Uint8Array.from(text,char=>char.charCodeAt(0));
      if(job.received+bytes.length>job.size)throw new Error('Local video upload is too large.');
      job.parts.push(bytes);job.received+=bytes.length;respond({ok:true});
    }catch(error){respond({ok:false,error:error.message});}return;
  }
  if(message.type==='localFinish'){
    (async()=>{const job=jobs.get(message.token);if(!job?.parts || job.received!==job.size)throw new Error('The loaded video upload is incomplete.');
      const blob=new Blob(job.parts,{type:'video/mp4'});job.parts=undefined;
      await mediaCache.put(job.key,blob).catch(()=>{});job.controller.signal.throwIfAborted();job.url=URL.createObjectURL(blob);
      return await chrome.runtime.sendMessage({type:'lwlManagedReady',token:message.token,url:job.url,cacheHit:false});
    })().then(respond,error=>{release(message.token);respond({ok:false,error:error.message});});return true;
  }
  if(message.type==='start'){void fetchMedia(message.token,message.url,message.key);respond({ok:true});}
  if(message.type==='release'){release(message.token);respond({ok:true});}
  if(message.type==='clear'){mediaCache.clear().then(()=>respond({ok:true}),()=>respond({ok:false,error:'Could not clear the media cache.'}));return true;}
});
