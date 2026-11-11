const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=join(__dirname,'..');
function organizer(rules=[{enabled:true,url:'instagram',pattern:'Instagram/${date:YYYY, MMMM}/${date:YYYY.MM.DD} - IG/'}]){
  const installed=require('./fixture-paths.cjs').organizerDir;
  const momentContext=vm.createContext({});
  vm.runInContext(readFileSync(join(installed,'js/moment-es.js'),'utf8').replace('export default hooks;','globalThis.moment=hooks;'),momentContext);
  let handler;
  const chrome={permissions:{contains:async()=>false},downloads:{onDeterminingFilename:{addListener(fn){handler=fn;}}},storage:{local:{get(keys,callback){callback({rulesets:rules});}}}};
  let source=readFileSync(join(installed,'manager.js'),'utf8').replace("import moment from './js/moment-es.js';",'');
  source=source.slice(0,source.lastIndexOf("chrome.storage.local.get(['version', 'showChangelog'])"));
  vm.runInContext(source,vm.createContext({chrome,moment:momentContext.moment,console:{log(){},warn(){},error(){},debug(){}}}));
  return item=>new Promise(resolve=>handler(item,resolve));
}
async function harness({fetchStatus=200,waitForAbort=false,override=false,holdDownload=false}={}){
  let workerListener,offscreenListener,filenameListener,lastFilenameListener,tabRemoved;const listenerEvents=[];
  const session={},local={},saved=[],revoked=[],fetches=[],cancelled=[],suggestions=[],ui=[],blobs=[];
  const control={override,fetchStatus};
  const sender={id:'our-addon',url:'https://www.instagram.com/example/',tab:{id:12}};
  const ask=(message,identity=sender)=>new Promise(resolve=>workerListener(message,identity,resolve));
  const applyOrganizer=organizer();
  const chrome={
    runtime:{id:sender.id,getURL:path=>'chrome-extension://our-addon/'+path.replace(/^\//,''),getContexts:async()=>[{}],
      onMessage:{addListener(fn){workerListener=fn;}},sendMessage:message=>new Promise(resolve=>offscreenListener(message,{id:sender.id},resolve))},
    action:{onClicked:{addListener(){}}},
    storage:{local:{get:async key=>key===null?{...local}:{[key]:local[key]},set:async data=>Object.assign(local,data),remove:async key=>{delete local[key];}},session:{get:async key=>key===null?{...session}:{[key]:session[key]},set:async data=>Object.assign(session,data),remove:async key=>{delete session[key];}}},
    downloads:{onDeterminingFilename:{addListener(fn){assert.equal(filenameListener,undefined);filenameListener=lastFilenameListener=fn;listenerEvents.push('add');},removeListener(fn){assert.equal(filenameListener,fn);filenameListener=undefined;listenerEvents.push('remove');}},async setUiOptions({enabled}){ui.push(enabled);},async download(options){
      const suggestion=await applyOrganizer({url:options.url,finalUrl:options.url,filename:'random-uuid.jpg',mime:'image/jpeg',referrer:'',startTime:'2026-11-04T12:00:00+01:00'});
      suggestions.push(suggestion);
      // Reproduce the real UUID result when the API filename is ignored. The new
      // handler must supply the target explicitly, instead of this mock trusting it.
      const own=await new Promise(resolve=>filenameListener({url:options.url,byExtensionId:sender.id},resolve));
      if(control.startError)throw new Error('Native download start failed');
      if(control.delayStart)await new Promise((resolve,reject)=>{control.rejectStart=reject;});
      saved.push({...options,state:holdDownload || (control.holdAfterFirst && saved.length>0)?'in_progress':'complete',exists:true,id:saved.length+1,filename:'/Downloads/'+(control.override?'wrong/photo.jpg':own?.filename || suggestion?.filename || 'random-uuid.jpeg')});return saved.length;
    },async search({id}){return saved.filter(item=>item.id===id);},async cancel(id){cancelled.push(id);}},
    offscreen:{async createDocument(){}},tabs:{onRemoved:{addListener(fn){tabRemoved=fn;}}}
  };
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:[2026,10,4,12]));}static now(){return new FixedDate().valueOf();}}
  vm.runInContext(readFileSync(join(root,'extension/js/background.js'),'utf8'),vm.createContext({chrome,URL,Date:FixedDate,crypto:webcrypto,setTimeout,clearTimeout}));
  const offscreenChrome={runtime:{id:sender.id,onMessage:{addListener(fn){offscreenListener=fn;}},sendMessage:message=>ask(message,{id:sender.id,url:chrome.runtime.getURL('offscreen.html')})}};
  let blobIndex=0;
  class BlobURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:chrome-extension://our-addon/fixture-'+(++blobIndex);}static revokeObjectURL(url){revoked.push(url);}}
  let fetchAborted=false;
  const cacheMap=new Map(),cacheStorage={open:async()=>({match:async request=>cacheMap.get(request.url || request)?.clone(),put:async(request,response)=>{cacheMap.set(request.url || request,response.clone());},delete:async request=>cacheMap.delete(request.url || request),keys:async()=>[...cacheMap.keys()].map(url=>({url}))}),delete:async()=>cacheMap.clear()};
  const offscreenContext=vm.createContext({chrome:offscreenChrome,URL:BlobURL,AbortController,AbortSignal,caches:cacheStorage,Response,Blob,atob,fetch:async(url,options)=>{
    fetches.push({url,options});
    if(waitForAbort)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{fetchAborted=true;reject(Object.assign(new Error('Stopped'),{name:'AbortError'}));},{once:true}));
    return {ok:control.fetchStatus===200,status:control.fetchStatus,blob:async()=>new Blob(['x'.repeat(100)],{type:'image/jpeg'})};
  }});
  vm.runInContext(readFileSync(join(root,'extension/js/media-cache.js'),'utf8'),offscreenContext);
  vm.runInContext(readFileSync(join(root,'extension/js/offscreen.js'),'utf8'),offscreenContext);
  const content=vm.createContext({chrome:{runtime:{sendMessage:ask}},URL,AbortController,AbortSignal,btoa,fetch:()=>{throw new Error('Automatic mode must fetch in its own origin');},document:{createElement(){throw new Error('Automatic mode must not click a page link');}},setTimeout:callback=>setImmediate(callback)});
  vm.runInContext(readFileSync(join(root,'extension/js/browser-downloads.js'),'utf8'),content);
  return {api:content.__lwlBrowserDownloads,ask,saved,revoked,fetches,cancelled,suggestions,session,local,control,ui,blobs,get filenameListener(){return lastFilenameListener;},activeFilenameListener:()=>filenameListener,listenerEvents,tabRemoved,fetchAborted:()=>fetchAborted};
}
const media={username:'example',taken_at:1000,id:'123',owner_id:'456',url:'https://scontent.example.cdninstagram.com/photo.jpg?signature=unchanged'};
test('recovered video bytes cross the worker/offscreen bridge without any CDN fetch',async()=>{
  const env=await harness(),blob=new Blob(['loaded video bytes'.repeat(40000)],{type:'video/mp4'});
  const count=await env.api.download([{...media,id:'loaded_fixture',url:'https://www.instagram.com/lwl-loaded-video.mp4',blob}],{username:'example'},()=>{});
  assert.equal(count,1);assert.equal(env.fetches.length,0);
  assert.equal(await env.blobs[0].text(),await blob.text());
  assert.equal(env.saved[0].filename,'/Downloads/Instagram/2026, November/2026.11.04 - IG/example_1000_loaded_fixture.mp4');
  assert.deepEqual(env.session,{});
});
test('automatic routing is enabled with no saved setting and ignores the existing generic Organizer rule',async()=>{
  const env=await harness();
  assert.equal((await env.ask({type:'lwlDownloadMode'})).mode,'builtin');
  assert.equal(await env.api.download([media,{...media,id:'124'}],{username:'example'},()=>{},{requireProfileFolder:true}),2);
  assert.equal(env.saved[0].filename,'/Downloads/Instagram/2026, November/2026.11.04 - IG/example/example_1000_123_456.jpg');
  assert.ok(env.saved.every(item=>item.url.startsWith('blob:chrome-extension://our-addon/') && item.saveAs===false && item.conflictAction==='uniquify'));
  assert.ok(env.suggestions.every(value=>value===undefined));
  assert.equal(env.fetches[0].url,media.url);
  assert.equal(env.fetches[0].options.credentials,'omit');
  assert.equal(env.revoked.length,2);
  assert.deepEqual(env.session,{});
  assert.deepEqual(env.ui,[false,true]);
});
test('automatic media HTTP failures stop without creating a browser download',async()=>{
  const env=await harness({fetchStatus:403});
  await assert.rejects(()=>env.api.download([media,media],{username:'example'},()=>{}),/403/);
  assert.equal(env.saved.length,0);
  assert.equal(env.fetches.length,1);
  assert.deepEqual(env.session,{});
});
test('Stop aborts an offscreen fetch and discards its session record',async()=>{
  const env=await harness({waitForAbort:true});
  const result=await env.ask({type:'lwlManagedDownload',url:media.url,profile:'example',name:'example_1000_123.jpg'});
  assert.equal(result.ok,true);
  assert.equal((await env.ask({type:'lwlCancelDownload',token:result.token})).ok,true);
  assert.equal(env.fetchAborted(),true);
  assert.deepEqual(env.session,{});
  assert.equal(env.saved.length,0);
});
test('automatic mode rejects a non-Instagram host before opening a downloader',async()=>{
  const env=await harness();
  const result=await env.ask({type:'lwlManagedDownload',url:'https://unrelated.example/photo.jpg',profile:'example',name:'photo.jpg'});
  assert.equal(result.ok,false);
  assert.equal(env.fetches.length,0);
});
test('Stop cancels an active automatic browser download and releases the offscreen blob',async()=>{
  const env=await harness({holdDownload:true});
  const result=await env.ask({type:'lwlManagedDownload',url:media.url,profile:'example',name:'photo.jpg'});
  while((await env.ask({type:'lwlDownloadStatus',token:result.token})).state!=='in_progress')await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await env.ask({type:'lwlCancelDownload',token:result.token})).ok,true);
  assert.deepEqual(env.cancelled,[1]);
  assert.equal(env.revoked.length,1);
  assert.deepEqual(env.session,{});
});
test('an unrelated global renaming rule still cannot silently redirect the full queue',async()=>{
  const env=await harness({override:true});
  await assert.rejects(()=>env.api.download([media,media],{username:'example'},()=>{}),/did not match the requested destination/);
  assert.equal(env.saved.length,1);
  assert.deepEqual(env.ui,[false,true]);
});

test('repeating a completed batch skips confirmed files without a new fetch or browser download',async()=>{
  const env=await harness();
  await env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true});
  let last;
  await env.api.download([media],{username:'example'},(done,total,stats)=>{last=stats;},{requireProfileFolder:true});
  assert.equal(env.saved.length,1);
  assert.equal(env.fetches.length,1);
  assert.equal(last.skipped,1);
  assert.equal(last.saved,0);
});

test('single downloads use the date folder and profile Download All uses its handle subfolder',async()=>{
  const env=await harness();
  await env.api.download([media],{username:'example'},()=>{});
  assert.equal(env.saved[0].filename,'/Downloads/Instagram/2026, November/2026.11.04 - IG/example_1000_123_456.jpg');
  await env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true});
  assert.equal(env.saved[1].filename,'/Downloads/Instagram/2026, November/2026.11.04 - IG/example/example_1000_123_456.jpg');
});

test('a deleted output is recreated from cached media without fetching Instagram again',async()=>{
  const env=await harness();
  await env.api.download([media],{username:'example'},()=>{});
  env.saved[0].exists=false;
  let last;
  await env.api.download([media],{username:'example'},(done,total,stats)=>{last=stats;});
  assert.equal(env.saved.length,2);
  assert.equal(env.fetches.length,1);
  assert.equal(last.cacheHits,1);
  assert.equal(last.skipped,0);
});

test('a failed routing attempt reuses the cached media when retried',async()=>{
  const env=await harness({override:true});
  await assert.rejects(()=>env.api.download([media],{username:'example'},()=>{}),/did not match/);
  env.control.override=false;
  await env.api.download([media],{username:'example'},()=>{});
  assert.equal(env.saved.length,2);
  assert.equal(env.fetches.length,1);
});

test('filename handler ignores unknown blobs and all downloads belonging to other extensions',async()=>{
  const env=await harness();
  assert.equal(env.activeFilenameListener(),undefined);
  await env.api.download([media],{username:'example'},()=>{});
  const ask=item=>new Promise(resolve=>env.filenameListener(item,resolve));
  assert.equal(await ask({byExtensionId:'someone-else',url:'blob:chrome-extension://our-addon/fixture-1'}),undefined);
  assert.equal(await ask({byExtensionId:'our-addon',url:'blob:chrome-extension://our-addon/unregistered'}),undefined);
  assert.equal(await ask({url:'blob:https://www.instagram.com/fixture'}),undefined);
  assert.equal(env.activeFilenameListener(),undefined);
});

test('RegExp Organizer exclusively handles unrelated downloads before and after LWL activity',async()=>{
  const env=await harness(),route=organizer([{enabled:true,url:'^https://media\\.example\\.com/',pattern:'Media/${date:YYYY.MM.DD}/${filename}'}]);
  const item={url:'https://media.example.com/video.mp4',finalUrl:'https://media.example.com/video.mp4',filename:'video.mp4',referrer:'',mime:'video/mp4',startTime:'2026-11-05T12:00:00+01:00'};
  for(let round=0;round<2;round++){
    assert.equal(env.activeFilenameListener(),undefined);
    assert.equal((await route(item)).filename,'Media/2026.11.05/video.mp4');
    if(!round)await env.api.download([media],{username:'example'},()=>{});
  }
  assert.deepEqual(env.listenerEvents,['add','remove']);
});

test('the global filename listener is removed even while an LWL file remains in progress',async()=>{
  const env=await harness({holdDownload:true});
  const result=await env.ask({type:'lwlManagedDownload',url:media.url,profile:'example',name:'photo.jpg'});
  while(!env.saved.length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.saved[0].state,'in_progress');assert.equal(env.activeFilenameListener(),undefined);
  await env.ask({type:'lwlCancelDownload',token:result.token});
  assert.equal(env.activeFilenameListener(),undefined);
});

test('quiet browser UI is restored after a media-fetch failure',async()=>{
  const env=await harness({fetchStatus:403});
  await assert.rejects(()=>env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true}),/403/);
  assert.deepEqual(env.ui,[false,true]);
  assert.deepEqual(env.session,{});
});

test('optional quiet-mode opt-out does not hide the browser UI',async()=>{
  const env=await harness();env.local.quietDownloads=false;
  await env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true});
  assert.ok(!env.ui.includes(false));
});

test('clearing cache resets tracking while preserving the downloaded files',async()=>{
  const env=await harness();
  await env.api.download([media],{username:'example'},()=>{});
  const result=await env.ask({type:'lwlClearCache'},{id:'our-addon',url:'chrome-extension://our-addon/options.html'});
  assert.equal(result.ok,true);
  assert.equal(env.saved.length,1);
  await env.api.download([media],{username:'example'},()=>{});
  assert.equal(env.fetches.length,2);
});

test('two transfers run together only after the first new save is verified',{timeout:2000},async()=>{
  const env=await harness();env.control.holdAfterFirst=true;
  const items=Array.from({length:5},(_,index)=>({...media,id:String(123+index)}));
  const running=env.api.download(items,{username:'example'},()=>{});
  while(env.saved.length<3)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.saved.filter(item=>item.state==='in_progress').length,2);
  assert.equal(env.saved.length,3);
  assert.equal(env.fetches.length,3);
  env.control.holdAfterFirst=false;for(const item of env.saved)item.state='complete';
  assert.equal(await running,5);
});

test('Stop cancels the active transfer and restores quiet UI',{timeout:2000},async()=>{
  const env=await harness({holdDownload:true}),controller=new AbortController();
  const running=env.api.download([media,media],{username:'example'},()=>{},{signal:controller.signal,requireProfileFolder:true});
  while(!env.saved.length)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(()=>running,{name:'AbortError'});
  assert.deepEqual(env.cancelled,[1]);
  assert.deepEqual(env.ui,[false,true]);
  assert.deepEqual(env.session,{});
});

test('closing the profile tab aborts its media fetch and restores quiet UI',{timeout:2000},async()=>{
  const env=await harness({waitForAbort:true});
  const batch=await env.ask({type:'lwlBatchStart',quiet:true});
  await env.ask({type:'lwlManagedDownload',url:media.url,profile:'example',name:'photo.jpg',batch:batch.token});
  while(!env.fetches.length)await new Promise(resolve=>setImmediate(resolve));
  env.tabRemoved(12);
  while(!env.fetchAborted() || env.ui.at(-1)!==true)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(env.session,{});
});

test('a browser download startup failure releases the blob and restores quiet UI',async()=>{
  const env=await harness();env.control.startError=true;
  await assert.rejects(()=>env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true}),/could not start/);
  assert.equal(env.revoked.length,1);
  assert.deepEqual(env.ui,[false,true]);
  assert.deepEqual(env.session,{});
});

test('Stop during browser startup cannot resurrect a cancelled session record',{timeout:2000},async()=>{
  const env=await harness();env.control.delayStart=true;
  const result=await env.ask({type:'lwlManagedDownload',url:media.url,profile:'example',name:'photo.jpg'});
  while(!env.control.rejectStart)await new Promise(resolve=>setImmediate(resolve));
  await env.ask({type:'lwlCancelDownload',token:result.token});env.control.rejectStart(new Error('Cancelled start'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(env.session,{});
  assert.equal(env.revoked.length,1);
});
