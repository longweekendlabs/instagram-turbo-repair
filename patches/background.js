const requestPrefix='lwl-native-download:';
const targetPrefix='lwl-filename:',savedPrefix='lwl-saved:',batchPrefix='lwl-batch:';
const waitingFilenames=new Map();
function finishFilename(url){
  if(!waitingFilenames.has(url))return;
  const timer=waitingFilenames.get(url);if(timer!==undefined)clearTimeout(timer);
  waitingFilenames.delete(url);
  if(!waitingFilenames.size)chrome.downloads.onDeterminingFilename.removeListener(determineOwnFilename);
}
function registerFilename(url){
  if(!waitingFilenames.size)chrome.downloads.onDeterminingFilename.addListener(determineOwnFilename);
  const timer=typeof setTimeout==='function'?setTimeout(()=>finishFilename(url),20000):undefined;
  waitingFilenames.set(url,timer);
}
function determineOwnFilename(item,suggest){
  if((item.byExtensionId && item.byExtensionId!==chrome.runtime.id) || !waitingFilenames.has(item.url)){suggest();return;}
  chrome.storage.session.get(targetPrefix+item.url).then(values=>{
    const target=values[targetPrefix+item.url];
    try{suggest(target?{filename:target.filename,conflictAction:'uniquify'}:undefined);}finally{finishFilename(item.url);}
  },()=>{try{suggest();}finally{finishFilename(item.url);}});return true;
}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function matchesDestination(actual,expected){
  const dot=expected.lastIndexOf('.');
  return new RegExp('(?:^|/)'+escapeRegex(expected.slice(0,dot))+'(?: \\(\\d+\\))?'+escapeRegex(expected.slice(dot))+'$').test(String(actual || '').replace(/\\/g,'/'));
}
async function removeRecord(key,value){await chrome.storage.session.remove(key);if(value.targetURL){finishFilename(value.targetURL);await chrome.storage.session.remove(targetPrefix+value.targetURL);}}
async function endBatch(token){
  await chrome.storage.session.remove(batchPrefix+token);
  const all=await chrome.storage.session.get(null);
  if(!Object.entries(all).some(([key,value])=>key.startsWith(batchPrefix) && value?.quiet))try{await chrome.downloads.setUiOptions({enabled:true});}catch{}
}
async function closeBatch(token,tabId){
  const all=await chrome.storage.session.get(null);
  for(const [key,value] of Object.entries(all))if(key.startsWith(requestPrefix) && value?.batch===token && value.tabId===tabId){
    await removeRecord(key,value);if(value.id!==undefined)try{await chrome.downloads.cancel(value.id);}catch{}
    if(value.managed)await releaseManaged(key.slice(requestPrefix.length));
  }
  await endBatch(token);
}
async function clearTab(tabId){
  const all=await chrome.storage.session.get(null);
  for(const [key,value] of Object.entries(all))if(value?.tabId===tabId){
    if(key.startsWith(batchPrefix))await endBatch(key.slice(batchPrefix.length));
    else if(key.startsWith(requestPrefix)){
      await removeRecord(key,value);
      if(value.id!==undefined)try{await chrome.downloads.cancel(value.id);}catch{}
      if(value.managed)await releaseManaged(key.slice(requestPrefix.length));
    }
  }
}
let creatingOffscreen;
async function ensureOffscreen(){
  const documentUrl=chrome.runtime.getURL('offscreen.html');
  if((await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[documentUrl]})).length)return;
  if(!creatingOffscreen)creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Save media with automatic date and profile folders.'}).finally(()=>{creatingOffscreen=undefined;});
  await creatingOffscreen;
}
async function releaseManaged(token){try{await chrome.runtime.sendMessage({target:'lwl-offscreen',type:'release',token});}catch{}}
function automaticPath(profile,name,date=new Date(),profileFolder=true){
  const year=date.getFullYear(),month=date.toLocaleString('en-US',{month:'long'}),day=[year,String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('.');
  const root=globalThis.__lwlPrivateConfig?.downloadRoot || 'Instagram';
  return `${root}/${year}, ${month}/${day} - IG/${profileFolder?profile+'/':''}${name}`;
}
async function managedResult(message,sender){
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('offscreen.html'))throw new Error('Invalid download worker.');
  const key=requestPrefix+message.token,value=(await chrome.storage.session.get(key))[key];
  if(!value?.managed){await releaseManaged(message.token);return {ok:false};}
  if(message.type==='lwlManagedFailed'){await chrome.storage.session.set({[key]:{...value,error:message.error}});return {ok:true};}
  if(!message.url?.startsWith('blob:'+chrome.runtime.getURL('')))throw new Error('Invalid local media URL.');
  const expected=automaticPath(value.profile,value.name,new Date(),value.profileFolder),updated={...value,targetURL:message.url,expected,cacheHit:!!message.cacheHit};
  await chrome.storage.session.set({[key]:updated,[targetPrefix+message.url]:{filename:expected}});
  registerFilename(message.url);
  let id;
  try{id=await chrome.downloads.download({url:message.url,filename:expected,saveAs:false,conflictAction:'uniquify'});}
  catch(error){
    finishFilename(message.url);
    if((await chrome.storage.session.get(key))[key])await chrome.storage.session.set({[key]:{...updated,error:'The browser could not start the media download.'}});
    else await chrome.storage.session.remove(targetPrefix+message.url);
    throw error;
  }
  // Stop may have arrived while the browser was starting the download.
  if(!(await chrome.storage.session.get(key))[key]){try{await chrome.downloads.cancel(id);}catch{}await chrome.storage.session.remove(targetPrefix+message.url);await releaseManaged(message.token);return {ok:false};}
  await chrome.storage.session.set({[key]:{...updated,id}});return {ok:true};
}
function instagramSender(sender) {
  try {return new URL(sender.url).origin==='https://www.instagram.com' && sender.id===chrome.runtime.id;}
  catch{return false;}
}
async function recordFor(token,sender){
  if(!/^[a-f0-9-]{36}$/.test(token || ''))throw new Error('Invalid download token.');
  const key=requestPrefix+token,value=(await chrome.storage.session.get(key))[key];
  if(!value || value.tabId!==sender.tab?.id)throw new Error('This download is unavailable.');
  return {key,value};
}
async function findItem(value){
  if(value.id!==undefined)return (await chrome.downloads.search({id:value.id}))[0];
  if(value.managed)return;
  const escaped=value.base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return (await chrome.downloads.search({urlRegex:'^'+escaped+'(?:#.*)?$',startedAfter:value.started,limit:1}))[0];
}
async function handle(message,sender){
  if(message.type==='lwlClearCache' && sender.id===chrome.runtime.id && sender.url===chrome.runtime.getURL('options.html')){
    await ensureOffscreen();
    const result=await chrome.runtime.sendMessage({target:'lwl-offscreen',type:'clear'});
    if(!result?.ok)throw new Error(result?.error || 'Could not clear the cache.');
    const all=await chrome.storage.local.get(null);for(const key of Object.keys(all))if(key.startsWith(savedPrefix))await chrome.storage.local.remove(key);
    return {ok:true};
  }
  if(!instagramSender(sender))throw new Error('Downloads must start from an Instagram tab.');
  if(message.type==='lwlBatchStart'){
    const entries=Object.entries(await chrome.storage.local.get(null)).filter(([key])=>key.startsWith(savedPrefix)).sort((a,b)=>b[1].time-a[1].time);
    for(const [key] of entries.slice(5000))await chrome.storage.local.remove(key);
    const token=crypto.randomUUID(),settings=await chrome.storage.local.get('quietDownloads');
    let quiet=false;if(message.quiet!==false && settings.quietDownloads!==false)try{await chrome.downloads.setUiOptions({enabled:false});quiet=true;}catch{}
    await chrome.storage.session.set({[batchPrefix+token]:{tabId:sender.tab.id,quiet}});
    return {ok:true,token,quiet};
  }
  if(message.type==='lwlBatchEnd'){
    const value=(await chrome.storage.session.get(batchPrefix+message.token))[batchPrefix+message.token];
    if(value && value.tabId!==sender.tab.id)throw new Error('Invalid batch.');
    await endBatch(message.token);return {ok:true};
  }
  if(message.type==='lwlDownloadMode')return {ok:true,mode:(await chrome.storage.local.get('folderMode')).folderMode==='organizer'?'organizer':'builtin'};
  if(message.type==='lwlLocalChunk' || message.type==='lwlLocalFinish'){
    const {value}=await recordFor(message.token,sender);
    if(!value.local)throw new Error('Invalid local video upload.');
    if(message.type==='lwlLocalChunk' && (typeof message.data!=='string' || message.data.length>700000))throw new Error('Invalid local video chunk.');
    const result=await chrome.runtime.sendMessage({target:'lwl-offscreen',type:message.type==='lwlLocalChunk'?'localChunk':'localFinish',token:message.token,data:message.data});
    if(!result?.ok)throw new Error(result?.error || 'Could not save the loaded video.');return {ok:true};
  }
  if(message.type==='lwlManagedDownload' || message.type==='lwlLocalDownload'){
    const local=message.type==='lwlLocalDownload';
    if(local && (!Number.isInteger(message.size) || message.size<1 || message.size>128*1024*1024))throw new Error('Invalid loaded video size.');
    const {profile,name}=message,url=new URL(message.url);
    if(!/^[a-zA-Z0-9._]{1,30}$/.test(profile || '') || ['.','..'].includes(profile) || !/^[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|webp|mp4|mov)$/.test(name || '') ||
      url.protocol!=='https:' || !['cdninstagram.com','cdninstagram.net','fbcdn.net','instagram.com'].some(domain=>url.hostname===domain || url.hostname.endsWith('.'+domain)) || !Number.isInteger(sender.tab?.id))throw new Error('Invalid Instagram media request.');
    if(message.batch && (await chrome.storage.session.get(batchPrefix+message.batch))[batchPrefix+message.batch]?.tabId!==sender.tab.id)throw new Error('Invalid batch.');
    const expected=automaticPath(profile,name,new Date(),message.profileFolder===true),savedKey=savedPrefix+expected,saved=(await chrome.storage.local.get(savedKey))[savedKey];
    if(saved){
      const item=(await chrome.downloads.search({id:saved.id}))[0];
      if(item?.state==='complete' && item.exists===true && matchesDestination(item.filename,expected))return {ok:true,skipped:true};
      await chrome.storage.local.remove(savedKey);
    }
    await ensureOffscreen();
    const token=crypto.randomUUID(),key=requestPrefix+token;
    await chrome.storage.session.set({[key]:{tabId:sender.tab.id,managed:true,local,profile,name,profileFolder:message.profileFolder===true,batch:message.batch,started:new Date().toISOString()}});
    try{const result=await chrome.runtime.sendMessage({target:'lwl-offscreen',type:local?'localStart':'start',size:message.size,token,url:url.href,key:profile+'/'+name});if(!result?.ok)throw new Error('Could not start the download worker.');}
    catch(error){await chrome.storage.session.remove(key);throw error;}
    return {ok:true,token};
  }
  if(message.type==='lwlDownload'){
    const url=new URL(message.url),match=url.hash.match(/^#lwl-instagram\/([a-zA-Z0-9._]{1,30})\/([a-zA-Z0-9._-]+)$/);
    if(url.protocol!=='blob:' || url.origin!=='https://www.instagram.com' || !match || ['.','..'].includes(match[1]) ||
       ['.','..'].includes(match[2]) || message.filename!==`${match[1]}/${match[2]}` || !Number.isInteger(sender.tab?.id))throw new Error('Invalid Instagram download request.');
    const token=crypto.randomUUID();
    await chrome.storage.session.set({[requestPrefix+token]:{tabId:sender.tab.id,base:url.href.split('#')[0],started:new Date().toISOString()}});
    return {ok:true,token};
  }
  const {key,value}=await recordFor(message.token,sender),item=await findItem(value);
  if(message.type==='lwlCancelDownload'){
    await removeRecord(key,value);
    if(item?.state==='in_progress')try{await chrome.downloads.cancel(item.id);}catch{}
    if(value.managed)await releaseManaged(message.token);
    return {ok:true};
  }
  if(value.error){await removeRecord(key,value);await releaseManaged(message.token);throw new Error(value.error);}
  if(!item){
    if(Date.now()-Date.parse(value.started)>(value.managed?150000:30000))throw new Error(value.managed?'The media download timed out.':'The browser did not start the download. Check whether it is asking to allow multiple downloads.');
    return {ok:true,state:'pending'};
  }
  if(['complete','interrupted'].includes(item.state)){
    if(value.managed && item.state==='complete' && matchesDestination(item.filename,value.expected))try{await chrome.storage.local.set({[savedPrefix+value.expected]:{id:item.id,time:Date.now()}});}catch{}
    await removeRecord(key,value);if(value.managed)await releaseManaged(message.token);
  }
  else if(value.id===undefined)await chrome.storage.session.set({[key]:{...value,id:item.id}});
  return {ok:true,state:item.state,error:item.error,filename:item.filename,cacheHit:!!value.cacheHit};
}
// Deliberately no filename listener at worker startup or while idle. It exists
// only from an owned download's registration until its filename callback answers.
chrome.runtime.onConnect?.addListener(port=>{
  if(!instagramSender(port.sender) || !port.name.startsWith(batchPrefix))return;
  port.onDisconnect.addListener(()=>{void closeBatch(port.name.slice(batchPrefix.length),port.sender.tab.id);});
});
chrome.tabs?.onRemoved.addListener(tabId=>{void clearTab(tabId);});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!['lwlDownload','lwlDownloadStatus','lwlCancelDownload','lwlDownloadMode','lwlManagedDownload','lwlManagedReady','lwlManagedFailed','lwlBatchStart','lwlBatchEnd','lwlClearCache','lwlLocalDownload','lwlLocalChunk','lwlLocalFinish'].includes(message?.type))return;
  (['lwlManagedReady','lwlManagedFailed'].includes(message.type)?managedResult(message,sender):handle(message,sender)).then(respond,error=>respond({ok:false,error:error.message}));return true;
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
