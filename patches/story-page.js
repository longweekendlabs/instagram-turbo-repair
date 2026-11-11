/* MAIN-world bridge: read already-loaded story media, never cookies or account tokens. */
globalThis.__lwlStoryPage = (() => {
  const media = new Map(), reels = new Map();
  const userPattern = /^[a-zA-Z0-9._]{1,30}$/;
  const cacheLimit = 200;

  function idOf(value) {
    for (const candidate of [value?.id, value?.pk]) {
      const id = String(candidate || '').split('_')[0];
      if (/^\d+$/.test(id)) return id;
    }
  }
  function urlOf(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['instagram.com','cdninstagram.com','cdninstagram.net','fbcdn.net']
        .some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : undefined;
    } catch { return undefined; }
  }
  function sameAsset(a, b) {
    try { const x = new URL(a), y = new URL(b); return x.origin + x.pathname === y.origin + y.pathname; }
    catch { return false; }
  }
  function ownerOf(value, fallback) {
    const name = value?.user?.username || value?.owner?.username || fallback;
    return userPattern.test(name || '') ? name : undefined;
  }
  function clean(value, fallback) {
    if (!value || typeof value !== 'object') return null;
    const id = idOf(value);
    const images = value.image_versions2?.candidates || value.display_resources;
    const photos = (Array.isArray(images) ? images : [])
      .filter(item => urlOf(item.url || item.src)).map(item => ({url:item.url || item.src,
        width:item.width || item.config_width || 0, height:item.height || item.config_height || 0}));
    if (urlOf(value.display_url)) photos.push({url:value.display_url, width:0, height:0});
    const videos = [...(Array.isArray(value.video_versions)?value.video_versions:[]),...(Array.isArray(value.video_resources)?value.video_resources:[])].filter(item => urlOf(item.url || item.src))
      .map(item => ({url:item.url || item.src,width:item.width || item.config_width || 0,height:item.height || item.config_height || 0}));
    if (urlOf(value.video_url)) videos.push({url:value.video_url,width:0,height:0});
    if (!id || (!photos.length && !videos.length)) return null;
    return {id, pk:id, user:{username:ownerOf(value,fallback)},
      media_type:value.media_type === 2 || value.is_video || videos.length ? 2 : 1,
      taken_at:value.taken_at || value.taken_at_timestamp || 0,
      image_versions2:{candidates:photos}, video_versions:videos};
  }
  function remember(item) {
    const old = media.get(item.id);
    if (!item.user.username && old?.user.username) item.user.username = old.user.username;
    // A later thumbnail-only response must not downgrade a known video to its poster.
    if (old?.media_type === 2) item.media_type = 2;
    if (!item.video_versions.length && old?.video_versions.length) item.video_versions = old.video_versions;
    media.delete(item.id); media.set(item.id,item);
    while (media.size > cacheLimit) media.delete(media.keys().next().value);
  }
  function playback(value,fallback){
    if(!value || typeof value!=='object')return null;
    const versions=[];
    const fields=['video_url','videoUrl','videoURL','playable_url','playable_url_quality_hd','browser_native_hd_url','browser_native_sd_url','progressive_url'];
    const seen=new WeakSet();let budget=100;
    function walk(node,depth){
      if(!node || typeof node!=='object' || seen.has(node) || depth>5 || --budget<0)return;
      seen.add(node);
      for(const field of fields)if(urlOf(node[field]))versions.push({url:node[field],width:node.width || 0,height:node.height || 0});
      for(const field of ['videoDeliveryLegacyFields','videoDeliveryResponseFragment','videoDeliveryResponseResult','progressive_urls','video_versions','video_resources']){
        const child=node[field];if(Array.isArray(child))for(const entry of child){if(entry && urlOf(entry.url || entry.src))versions.push({url:entry.url || entry.src,width:entry.width || 0,height:entry.height || 0});walk(entry,depth+1);}else walk(child,depth+1);
      }
    }
    walk(value,0);
    if(!versions.length)return null;
    return {id:idOf(value) || idOf({id:value.videoID || value.video_id}),user:{username:ownerOf(value,fallback)},media_type:2,taken_at:value.taken_at || 0,
      image_versions2:{candidates:[{url:value.poster || value.thumbnailUrl || value.thumbnail_src || value.preferred_thumbnail?.image?.uri}]},video_versions:versions};
  }
  function collect(root, fallback, defaultKey) {
    const seen = new WeakSet(); let remaining = 12000;
    function walk(value, owner, key, depth) {
      if (!value || typeof value !== 'object' || seen.has(value) || --remaining < 0 || depth > 14) return;
      seen.add(value);
      if (Array.isArray(value)) {for (const child of value) walk(child,owner,key,depth+1); return;}
      owner = ownerOf(value,owner);
      const reelId = String(value.id || '');
      const items = Array.isArray(value.items) ? value.items : undefined;
      if (items && (reelId.startsWith('highlight:') || (defaultKey === 'highlight:' + reelId))) key = reelId.startsWith('highlight:') ? reelId : defaultKey;
      else if (items && owner) key = 'user:' + owner.toLowerCase();
      const item = clean(value,owner);
      if (item) remember(item);
      if (items && key) {
        const list = items.map(item => clean(item,owner)).filter(Boolean);
        if (list.length) reels.set(key,list.slice(0,cacheLimit));
        while (reels.size > 20) reels.delete(reels.keys().next().value);
      }
      for (const [name,child] of Object.entries(value)) {
        if (!['return','child','sibling','stateNode','_owner','ref'].includes(name)) walk(child,owner,key,depth+1);
      }
    }
    walk(root,fallback,undefined,0);
  }

  function visible(snapshot={}) {
    let chosen;
    for (const element of document.querySelectorAll('video, img')) {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (rect.width < 120 || rect.height < 180 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const area = Math.max(0,Math.min(rect.right,innerWidth)-Math.max(0,rect.left)) *
        Math.max(0,Math.min(rect.bottom,innerHeight)-Math.max(0,rect.top));
      const matches=!!snapshot.url && snapshot.url===(element.currentSrc || element.src);
      if (area && (!chosen || (matches && !chosen.matches) || (matches===chosen.matches && (area>chosen.area || (area===chosen.area && element.tagName==='VIDEO' && chosen.element.tagName!=='VIDEO'))))) chosen = {element,area,matches};
    }
    return chosen?.element;
  }
  function ownerFromHeader(element) {
    const rect = element.getBoundingClientRect(), names = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      let path;try{const url=new URL(anchor.getAttribute('href'),location.origin);if(url.origin!==location.origin)continue;path=url.pathname;}catch{continue;}
      const match = path.match(/^\/(?:stories\/)?([a-zA-Z0-9._]{1,30})\/?$/);
      const r = anchor.getBoundingClientRect();
      if (match && !['stories','highlights','explore','accounts','direct'].includes(match[1]) && r.width && r.height &&
          r.top >= rect.top && r.bottom < rect.top + 110 && r.left >= rect.left && r.right <= rect.right) names.add(match[1]);
    }
    return names.size === 1 ? [...names][0] : undefined;
  }
  function read(request) {
    const target = request.target || {}, snapshot = request.snapshot || {};
    const key = target.highlightId ? 'highlight:' + target.highlightId : 'user:' + String(target.username).toLowerCase();
    const element = visible(snapshot), owner = target.username || (element && ownerFromHeader(element));
    let direct;const players=[];
    const diagnostic={viewerVideo:element?.tagName==='VIDEO',sourceKind:snapshot.url?.startsWith('blob:')?'blob':urlOf(snapshot.url)?'https':'other',hasPoster:!!snapshot.poster,playerCandidates:0,matchedPlayer:false};
    // Inspect props attached to this media element, then a bounded number of parent fibers.
    // Only sanitized media records survive; no React tree or raw response leaves this world.
    if (element) {
      const sameView = request.pathname === location.pathname &&
        (!snapshot.url || snapshot.url === (element.currentSrc || element.src));
      for (let node=element,up=0;node && up<8;node=node.parentElement,up++) {
        for (const property of Object.keys(node)) {
          if (!property.startsWith('__reactFiber$') && !property.startsWith('__reactProps$')) continue;
          let fiber = node[property];
          for (let depth=0;fiber && depth<24;fiber=fiber.return,depth++) {
            const props = fiber.memoizedProps || fiber;
            collect(props,owner,key);
            if(sameView && element.tagName==='VIDEO')for(const field of ['videoData','video','playerVideo','playbackData']){
              const candidate=playback(props[field],ownerOf(props,owner));if(candidate)players.push(candidate);
            }
            if (sameView && !direct) {
              for (const field of ['currentStory','currentMedia','storyItem','reelItem','media','item','story']) {
                const item = clean(props[field],ownerOf(props,owner)) || clean(props[field]?.media,ownerOf(props,owner));
                if (item) {direct=item; remember(item); break;}
              }
            }
          }
        }
      }
    }
    let budget = 4 * 1024 * 1024;
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (script.textContent.length > budget) continue;
      budget -= script.textContent.length;
      try {collect(JSON.parse(script.textContent),owner,key);} catch {}
    }
    if (direct) direct = media.get(direct.id) || direct;
    diagnostic.playerCandidates=players.length;
    // A nearby player is usable only when its media ID or poster identifies this item.
    const matchingPlayers=players.filter(player=>(player.id && player.id===(target.mediaId || snapshot.id || direct?.id)) ||
      player.image_versions2.candidates.some(photo=>photo.url && snapshot.poster && sameAsset(photo.url,snapshot.poster)));
    const unique=new Map();
    for(const player of matchingPlayers){const key=player.id || direct?.id || player.video_versions.map(v=>v.url).sort().join('|');const old=unique.get(key);unique.set(key,old?{...old,video_versions:[...old.video_versions,...player.video_versions]}:player);}
    if(unique.size===1){
      const player=[...unique.values()][0],id=target.mediaId || snapshot.id || direct?.id || player.id;
      if(id){direct={...player,id,pk:id,user:{username:player.user.username || direct?.user.username || owner}};remember(direct);diagnostic.matchedPlayer=true;}
    }
    const id = target.mediaId || snapshot.id;
    let current = id ? media.get(id) : undefined;
    if (!id) {
      const matches = [...media.values()].filter(item => [...item.video_versions,...item.image_versions2.candidates]
        .some(candidate => sameAsset(candidate.url,snapshot.url) || sameAsset(candidate.url,snapshot.poster)));
      current = matches.length === 1 ? matches[0] : direct;
    }
    if (!current?.user.username && current && owner) current = {...current,user:{username:owner}};
    if (target.username && current?.user.username?.toLowerCase() !== target.username.toLowerCase()) current = undefined;
    const items = reels.get(key) || [];
    diagnostic.hasOwner=!!(current?.user.username || items[0]?.user.username || owner);
    diagnostic.currentFound=!!current;diagnostic.currentVideoSources=current?.video_versions.length || 0;
    return {current:current || null, items, username:current?.user.username || items[0]?.user.username || owner,diagnostic};
  }
  function storyResponse(url) {
    try {
      const path = new URL(url,location.href).pathname;
      return /reels_media|reel_media/.test(path) || (location.pathname.startsWith('/stories/') && /graphql/.test(path));
    } catch {return false;}
  }
  function start() {
    window.addEventListener('message',event => {
      if(event.source===window && event.origin===location.origin && event.data?.type==='lwlCaptureLoadedVideo' && event.ports?.[0]){
        const port=event.ports[0],request=event.data,element=visible(request.snapshot);
        if(request.pathname!==location.pathname || element?.tagName!=='VIDEO' || (element.currentSrc || element.src)!==request.snapshot?.url){port.postMessage({error:'The current video changed. Open it and try again.'});port.close();return;}
        const data=read(request);
        if(!data.username){port.postMessage({error:'Could not identify the video owner.'});port.close();return;}
        const resume=element.paused===false;element.pause?.();
        Promise.resolve().then(()=>__lwlLoadedVideo.capture(request.snapshot.url,element)).then(blob=>port.postMessage({blob,username:data.username}),error=>port.postMessage({error:error.message,diagnostic:typeof __lwlLoadedVideo!=='undefined'?__lwlLoadedVideo.state(request.snapshot.url):{captureMapped:false}})).finally(()=>{port.close();if(resume && (element.currentSrc || element.src)===request.snapshot.url)element.play?.().catch(()=>{});});
        return;
      }
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'lwlReadLoadedStory' || !event.ports?.[0]) return;
      const port = event.ports[0];
      try {port.postMessage(read(event.data));} catch {port.postMessage({current:null,items:[]});}
      finally {port.close();}
    });
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const pending = Reflect.apply(originalFetch,this,args);
      if (storyResponse(typeof args[0] === 'string' ? args[0] : args[0]?.url)) {
        pending.then(response => {
          if (response.ok && /json/.test(response.headers.get('content-type') || '')) {
            response.clone().text().then(text => {if (text.length <= 4*1024*1024) collect(JSON.parse(text));}).catch(()=>{});
          }
        }).catch(()=>{});
      }
      return pending;
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method,url,...rest) {
      if (storyResponse(url)) this.addEventListener('load',() => {
        try {
          if (this.status === 200 && this.responseType === 'json') collect(this.response);
          else if (this.status === 200 && (!this.responseType || this.responseType === 'text') && this.responseText.length <= 4*1024*1024) collect(JSON.parse(this.responseText));
        } catch {}
      },{once:true});
      return Reflect.apply(originalOpen,this,[method,url,...rest]);
    };
  }
  return {clean,collect,read,start};
})();
__lwlStoryPage.start();
