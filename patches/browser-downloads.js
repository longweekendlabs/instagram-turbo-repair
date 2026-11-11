/* Download through the browser so RegExp Download Organizer can apply its rules. */
globalThis.__lwlBrowserDownloads = (() => {
  function fileName(media) {
    const url = new URL(media.url);
    const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1];
    if (!extension || !/^(jpg|jpeg|png|webp|mp4|mov)$/i.test(extension)) {
      throw new Error('Unsupported media filename. No file was saved.');
    }
    let id = String(media.id || media.pk || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Instagram returned an invalid media ID.');
    if(!/^[a-zA-Z0-9._]{1,30}$/.test(media.username || ''))throw new Error('Invalid media owner.');
    if(!id.includes('_') && /^\d+$/.test(String(media.owner_id || '')))id+='_'+media.owner_id;
    return `${media.username}_${media.taken_at || 0}_${id}.${extension.toLowerCase()}`;
  }

  async function message(payload) {
    const result = await chrome.runtime.sendMessage(payload);
    if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reload Instagram and try again.');
    return result;
  }

  async function download(items,account,onProgress,options={}){
    const {mode}=await message({type:'lwlDownloadMode'});
    const controller=mode==='builtin'?new AbortController():null;
    const signal=controller?(options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal):options.signal;
    let completed=0,saved=0,skipped=0,cacheHits=0,batch,port;
    async function report(){await onProgress(completed,items.length,{saved,skipped,cacheHits});}
    async function one(media){
      signal?.throwIfAborted();
      const name=fileName(media);let url,token;
      try{
        if(mode==='builtin'){
          const result=await message({type:media.blob?'lwlLocalDownload':'lwlManagedDownload',url:media.url,profile:account.username,name,batch,profileFolder:!!options.requireProfileFolder,size:media.blob?.size});
          if(result.skipped){completed++;skipped++;await report();return false;}
          token=result.token;
          if(media.blob){
            for(let offset=0;offset<media.blob.size;offset+=512*1024){
              signal?.throwIfAborted();const bytes=new Uint8Array(await media.blob.slice(offset,offset+512*1024).arrayBuffer());
              let text='';for(let at=0;at<bytes.length;at+=8192)text+=String.fromCharCode(...bytes.subarray(at,at+8192));
              await message({type:'lwlLocalChunk',token,data:btoa(text)});
            }
            await message({type:'lwlLocalFinish',token});
          }
        }else{
          const response=media.blob?null:await fetch(media.url,{signal});
          if(response && !response.ok)throw new Error(`Instagram refused a media file (HTTP ${response.status}). ${saved} files saved.`);
          const blob=media.blob || await response.blob();
          if(!blob.size)throw new Error('Instagram returned an empty media file.');
          url=URL.createObjectURL(blob);
          const tagged=`${url}#lwl-instagram/${account.username}/${name}`;
          ({token}=await message({type:'lwlDownload',url:tagged,filename:`${account.username}/${name}`}));
          signal?.throwIfAborted();
          const anchor=document.createElement('a');anchor.href=tagged;anchor.download=name;anchor.style.display='none';
          anchor.addEventListener('click',event=>event.stopPropagation());document.body.appendChild(anchor);anchor.click();anchor.remove();
        }
        let finalPath,fromCache=false;
        while(true){
          signal?.throwIfAborted();
          const status=await message({type:'lwlDownloadStatus',token});
          if(status.state==='complete'){finalPath=status.filename;fromCache=!!status.cacheHit;token=undefined;break;}
          if(status.state==='interrupted')throw new Error(`Browser download stopped (${status.error || 'interrupted'}). ${saved} files saved.`);
          await new Promise(resolve=>setTimeout(resolve,mode==='builtin'?100:1000));
        }
        completed++;saved++;if(fromCache)cacheHits++;await report();
        const parts=String(finalPath || '').replace(/\\/g,'/').split('/'),actualName=parts.at(-1) || '';
        const dot=name.lastIndexOf('.'),stem=name.slice(0,dot),extension=name.slice(dot);
        const nameOK=actualName===name || (actualName.startsWith(stem+' (') && /^ \(\d+\)$/.test(actualName.slice(stem.length,-extension.length)) && actualName.endsWith(extension));
        const folderOK=parts.at(-2)===account.username;
        if(!nameOK || (options.requireProfileFolder && !folderOK)){
          throw Object.assign(new Error(`The saved filename or profile folder did not match the requested destination. Stopped after ${saved} saved file. Open Options to copy the failure details.`),
            {diagnostic:{kind:'download-routing',filenameMatched:nameOK,profileFolderMatched:folderOK,savedFiles:saved}});
        }
        return true;
      }finally{
        if(token)try{await message({type:'lwlCancelDownload',token});}catch{}
        if(url)URL.revokeObjectURL(url);
      }
    }
    try{
      if(mode==='builtin'){
        ({token:batch}=await message({type:'lwlBatchStart',quiet:!!options.requireProfileFolder || items.length>1}));
        if(chrome.runtime.connect)port=chrome.runtime.connect({name:'lwl-batch:'+batch});
        // Check the first actual save before allowing two concurrent transfers.
        let next=0;
        while(next<items.length && !await one(items[next++])){}
        async function run(){while(next<items.length){signal.throwIfAborted();await one(items[next++]);}}
        const workers=[run(),run()];
        try{await Promise.all(workers);}catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
      }else for(const media of items)await one(media);
      return completed;
    }finally{
      if(batch)try{await message({type:'lwlBatchEnd',token:batch});}catch{}
      port?.disconnect();
    }
  }

  return {download, fileName};
})();
