const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const {MessageChannel} = require('node:worker_threads');
const root = join(__dirname,'..');
const pageSource = readFileSync(join(root,'extension/js/story-page.js'),'utf8');
const contentSource = readFileSync(join(root,'extension/js/stories.js'),'utf8');
function item(id='123') {return {id,pk:id,user:{username:'example'},media_type:2,
  image_versions2:{candidates:[{url:`https://scontent.cdninstagram.com/${id}.jpg`,width:1080,height:1920}]},
  video_versions:[{url:`https://scontent.fbcdn.net/${id}.mp4`,width:1080,height:1920}],taken_at:1000};}

function bridgeSetup({video=true}={}) {
  const current = item(), other = item('456');
  if (!video) {current.media_type=1; current.video_versions=[];}
  const element = {currentSrc:video?'blob:https://www.instagram.com/live-video':'https://scontent.cdninstagram.com/123.jpg',
    getBoundingClientRect:()=>({left:10,top:10,right:370,bottom:650,width:360,height:640}),
    __reactFiber$fixture:{memoizedProps:{currentStory:current,reel:{id:'highlight:12',user:{username:'example'},items:[current,other]}}}};
  const context = vm.createContext({URL,Reflect,location:{origin:'https://www.instagram.com',href:'https://www.instagram.com/stories/highlights/12/',pathname:'/stories/highlights/12/'},
    innerWidth:1280,innerHeight:720,getComputedStyle:()=>({opacity:'1'}),
    document:{querySelectorAll:selector=>selector==='video, img'?[element]:[]}});
  vm.runInContext(pageSource.replace('__lwlStoryPage.start();',''),context);
  return {api:context.__lwlStoryPage,element,context};
}

test('reads the actual current highlight video from DOM-attached props without metadata requests',()=>{
  const env=bridgeSetup();
  const result=env.api.read({target:{highlightId:'12'},pathname:'/stories/highlights/12/',snapshot:{url:env.element.currentSrc}});
  assert.equal(result.current.id,'123');
  assert.equal(result.current.video_versions[0].url,'https://scontent.fbcdn.net/123.mp4');
  assert.equal(result.username,'example');
  assert.equal(result.items.length,2);
});

test('all-highlight records come only from the matching reel',()=>{
  const env=bridgeSetup();
  env.api.collect({id:'highlight:other',user:{username:'different'},items:[{...item('789'),user:{username:'different'}}]});
  const result=env.api.read({target:{highlightId:'12'},pathname:'/stories/highlights/12/',snapshot:{url:env.element.currentSrc}});
  assert.equal(result.items.length,2);
  assert.ok(result.items.every(item=>item.user.username==='example'));
});

test('later thumbnail-only data cannot replace a known story video',()=>{
  const env=bridgeSetup();
  env.api.collect(item());
  env.api.collect({...item(),media_type:1,video_versions:[]});
  env.element.__reactFiber$fixture={memoizedProps:{}};
  const result=env.api.read({target:{username:'example',mediaId:'123'},snapshot:{},pathname:'/stories/example/123/'});
  assert.equal(result.current.media_type,2);
  assert.equal(result.current.video_versions[0].url,'https://scontent.fbcdn.net/123.mp4');
});

test('a changed route cannot silently select the next highlight video',()=>{
  const env=bridgeSetup();
  const result=env.api.read({target:{highlightId:'11'},pathname:'/stories/highlights/11/',snapshot:{url:'blob:https://www.instagram.com/previous'}});
  assert.equal(result.current,null);
  assert.equal(result.items.length,0);
});

test('cached page responses are sanitized and bounded',()=>{
  const env=bridgeSetup();
  env.element.__reactFiber$fixture={memoizedProps:{}};
  for(let n=0;n<240;n++) env.api.collect({...item(String(1000+n)),password:'do-not-export',sessionid:'do-not-export'});
  const old=env.api.read({target:{mediaId:'1000',username:'example'},snapshot:{},pathname:'/stories/example/1000/'});
  assert.equal(old.current,null);
  const last=env.api.read({target:{mediaId:'1239',username:'example'},snapshot:{},pathname:'/stories/example/1239/'});
  assert.equal(last.current.id,'1239');
  assert.ok(!JSON.stringify(last).includes('do-not-export'));
});

test('loaded highlight bridge avoids an HTTP 500 endpoint altogether, through real MessageChannel replies',async()=>{
  const page=bridgeSetup();let apiCalls=0;
  const context=vm.createContext({URL,MessageChannel,setTimeout,clearTimeout,
    location:{origin:'https://www.instagram.com',pathname:'/stories/highlights/12/'},
    window:{postMessage(message,origin,ports){ports[0].postMessage(page.api.read(message));ports[0].close();}},
    fetch:async()=>{apiCalls++;throw new Error('HTTP 500 endpoint should not be requested');}});
  vm.runInContext(contentSource.replace("if (typeof document !== 'undefined') __lwlStories.start();",''),context);
  const result=await context.__lwlStories.resolve({highlightId:'12'},{url:page.element.currentSrc,isVideo:true,fromViewer:true},false);
  assert.equal(result.items[0].url,'https://scontent.fbcdn.net/123.mp4');
  assert.equal(apiCalls,0);
});

test('a directly displayed normal-story photo works even without bridge or metadata',async()=>{
  const context=vm.createContext({URL});
  vm.runInContext(contentSource.replace("if (typeof document !== 'undefined') __lwlStories.start();",''),context);
  const result=await context.__lwlStories.resolve({username:'example',mediaId:'123'},
    {url:'https://scontent.cdninstagram.com/123.jpg',fromViewer:true},false);
  assert.equal(result.items[0].url,'https://scontent.cdninstagram.com/123.jpg');
});

test('current highlight photo can use a header owner without React metadata',async()=>{
  const page=bridgeSetup({video:false});delete page.element.__reactFiber$fixture;
  const anchor={getAttribute:()=> 'https://www.instagram.com/stories/example/',getBoundingClientRect:()=>({top:20,bottom:50,left:20,right:100,width:80,height:30})};
  page.context.document.querySelectorAll=selector=>selector==='video, img'?[page.element]:selector==='a[href]'?[anchor]:[];
  const context=vm.createContext({URL,MessageChannel,setTimeout,clearTimeout,
    location:{origin:'https://www.instagram.com',pathname:'/stories/highlights/12/'},
    window:{postMessage(message,origin,ports){ports[0].postMessage(page.api.read(message));ports[0].close();}},
    fetch:async()=>{throw new Error('Already visible highlight must not call the failing API');}});
  vm.runInContext(contentSource.replace("if (typeof document !== 'undefined') __lwlStories.start();",''),context);
  const result=await context.__lwlStories.resolve({highlightId:'12'},{url:page.element.currentSrc,fromViewer:true,isVideo:false},false);
  assert.equal(result.username,'example');assert.equal(result.items[0].url,page.element.currentSrc);
});

test('passive fetch observation preserves the original promise and response',async()=>{
  let listener;const response={ok:true,headers:{get:()=> 'application/json'},clone:()=>({text:async()=>JSON.stringify({items:[item()]})})};
  const pending=Promise.resolve(response);
  const env=bridgeSetup();
  const xhr={prototype:{open(){}}};
  env.context.window={fetch:()=>pending,addEventListener(type,fn){listener=fn;}};
  env.context.XMLHttpRequest=xhr;
  env.api.start();
  assert.equal(env.context.window.fetch('https://www.instagram.com/api/graphql'),pending);
  assert.equal(await pending,response);
  assert.equal(typeof listener,'function');
});

test('empty legacy video arrays do not hide populated resource lists',()=>{
  const page=bridgeSetup();
  const result=page.api.clean({...item(),video_versions:[],video_resources:[{src:'https://scontent.fbcdn.net/resource.mp4',config_width:1080,config_height:1920}]});
  assert.equal(result.video_versions[0].url,'https://scontent.fbcdn.net/resource.mp4');
});

test('blob-backed highlight resolves an ID-matched player URL without metadata requests',async()=>{
  const page=bridgeSetup();page.element.tagName='VIDEO';
  const raw=item();raw.video_versions=[];
  page.element.__reactFiber$fixture.memoizedProps={currentStory:raw,videoData:{id:'123',videoDeliveryLegacyFields:{browser_native_hd_url:'https://scontent.fbcdn.net/player.mp4'}}};
  const result=page.api.read({target:{highlightId:'12'},pathname:'/stories/highlights/12/',snapshot:{url:page.element.currentSrc}});
  assert.equal(result.current.video_versions[0].url,'https://scontent.fbcdn.net/player.mp4');
  assert.equal(result.diagnostic.matchedPlayer,true);
  assert.ok(!JSON.stringify(result.diagnostic).includes('example'));
  const context=vm.createContext({URL,MessageChannel,setTimeout,clearTimeout,location:{origin:'https://www.instagram.com',pathname:'/stories/highlights/12/'},
    window:{postMessage(message,origin,ports){ports[0].postMessage(page.api.read(message));ports[0].close();}},fetch:async()=>{throw new Error('Must not request metadata for resolved playback');}});
  vm.runInContext(contentSource.replace("if (typeof document !== 'undefined') __lwlStories.start();",''),context);
  const download=await context.__lwlStories.resolve({highlightId:'12'},{url:page.element.currentSrc,isVideo:true,fromViewer:true},false);
  assert.equal(download.items[0].url,'https://scontent.fbcdn.net/player.mp4');
});

test('an unrelated nearby player cannot replace the current highlight video',()=>{
  const page=bridgeSetup();page.element.tagName='VIDEO';
  const raw=item();raw.video_versions=[];
  page.element.__reactFiber$fixture.memoizedProps={currentStory:raw,videoData:{id:'456',videoURL:'https://scontent.fbcdn.net/wrong.mp4'}};
  const result=page.api.read({target:{highlightId:'12'},pathname:'/stories/highlights/12/',snapshot:{url:page.element.currentSrc}});
  assert.equal(result.diagnostic.matchedPlayer,false);
  assert.equal(result.current.video_versions.length,0);
});

test('the clicked video wins over an equally sized poster image listed first',()=>{
  const page=bridgeSetup();page.element.tagName='VIDEO';
  const poster={tagName:'IMG',currentSrc:'https://scontent.cdninstagram.com/poster.jpg',getBoundingClientRect:page.element.getBoundingClientRect};
  page.context.document.querySelectorAll=selector=>selector==='video, img'?[poster,page.element]:[];
  const result=page.api.read({target:{highlightId:'12'},pathname:'/stories/highlights/12/',snapshot:{url:page.element.currentSrc}});
  assert.equal(result.diagnostic.viewerVideo,true);
  assert.equal(result.current.video_versions[0].url,'https://scontent.fbcdn.net/123.mp4');
});

test('the reported blob/no-poster/no-player case recovers bytes through the real message bridge',async()=>{
  const {webcrypto}=require('node:crypto');
  const page=bridgeSetup();page.element.tagName='VIDEO';delete page.element.__reactFiber$fixture;
  const anchor={getAttribute:()=>'/example/',getBoundingClientRect:()=>({top:20,bottom:40,left:20,right:100,width:80,height:20})};
  page.context.document.querySelectorAll=selector=>selector==='video, img'?[page.element]:selector==='a[href]'?[anchor]:[];
  let listener,captures=0;
  page.context.window={fetch:async()=>{throw new Error('No metadata request allowed');},addEventListener(type,fn){if(type==='message')listener=fn;}};
  page.context.XMLHttpRequest={prototype:{open(){}}};
  page.context.__lwlLoadedVideo={capture:async url=>{assert.equal(url,page.element.currentSrc);captures++;return new Blob(['recovered bytes'],{type:'video/mp4'});}};
  page.api.start();
  const context=vm.createContext({URL,MessageChannel,setTimeout,clearTimeout,crypto:webcrypto,
    location:{origin:'https://www.instagram.com',pathname:'/stories/highlights/12/'},
    window:{postMessage(data,origin,ports){listener({source:page.context.window,origin,data,ports});}},
    fetch:async()=>{throw new Error('Must not use the failing metadata endpoint');}});
  vm.runInContext(contentSource.replace("if (typeof document !== 'undefined') __lwlStories.start();",''),context);
  const resolve=()=>context.__lwlStories.resolve({highlightId:'12'},{url:page.element.currentSrc,isVideo:true,fromViewer:true},false);
  const result=await resolve();assert.equal(await result.items[0].blob.text(),'recovered bytes');
  page.element.currentSrc='blob:https://www.instagram.com/reloaded-video';const second=await resolve();
  assert.equal(second.items[0].id,result.items[0].id);assert.equal(captures,2);
});
