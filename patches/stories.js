/* Story downloading independent of Instagram's home-story tray and private UI modules. */
globalThis.__lwlStories = (() => {
  const origin = 'https://www.instagram.com';
  const usernamePattern = /^[a-zA-Z0-9._]{1,30}$/;
  let toolbar, status, observer, timer, scheduled, currentKey, busy = false;
  let readDiagnostic;

  function route(pathname = location.pathname) {
    const match = pathname.match(/^\/stories\/([a-zA-Z0-9._]{1,30})(?:\/(\d+))?\/?$/);
    if (!match) return null;
    if (match[1] === 'highlights') return match[2] ? {highlightId: match[2]} : null;
    return {username: match[1], mediaId: match[2]};
  }

  function mediaId(item) {
    const value = String(item?.id || item?.pk || '').split('_')[0];
    return /^\d+$/.test(value) ? value : undefined;
  }

  function mediaURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['instagram.com', 'cdninstagram.com', 'cdninstagram.net', 'fbcdn.net']
        .some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) ? url.href : undefined;
    } catch { return undefined; }
  }

  function best(candidates) {
    return (candidates || []).map(item=>({...item,url:item.url || item.src,width:item.width || item.config_width,height:item.height || item.config_height})).filter(item => mediaURL(item.url))
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0]?.url;
  }

  function normalize(item, username) {
    if (!usernamePattern.test(username || '')) throw new Error('Could not identify the story owner.');
    const isVideo = item.media_type === 2 || item.is_video || item.video_versions?.length > 0 || item.video_resources?.length>0;
    const url = isVideo ? best([...(item.video_versions || []),...(item.video_resources || [])]) || mediaURL(item.video_url)
      : best(item.image_versions2?.candidates || item.display_resources) || mediaURL(item.display_url);
    if (!url) throw new Error(isVideo ? 'Instagram did not return a downloadable video for this story.' : 'Instagram did not return a story image.');
    const id = mediaId(item);
    if (!id) throw new Error('Instagram returned an invalid story ID.');
    return {id, pk: id, username, taken_at: item.taken_at || item.taken_at_timestamp || 0, url};
  }

  async function request(path) {
    const stage = path.startsWith('/api/v1/media/') ? 'story metadata' : 'story reel';
    const captured = __turboLocalRepair.headers();
    const headers = {'x-ig-app-id': captured.appId, 'x-ig-www-claim': captured.wwwClaim,
      'x-requested-with': 'XMLHttpRequest', accept: 'application/json'};
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('csrftoken='));
    if (csrf) headers['x-csrftoken'] = csrf.slice(10);
    let response;
    try {
      response = await fetch(origin + path, {headers, credentials: 'same-origin', signal: AbortSignal.timeout(30000)});
    } catch (error) {
      throw new Error(/Timeout|Abort/.test(error.name) ? 'Instagram did not respond within 30 seconds.' : 'Could not reach Instagram.');
    }
    if (response.status === 429) throw new Error('Instagram rate-limited story downloads (HTTP 429). Try again later.');
    if (/\/(accounts\/login|challenge|checkpoint)(\/|$)/.test(new URL(response.url || origin + path).pathname)) {
      throw new Error('Instagram requires a login or account check. Complete it on Instagram first.');
    }
    if (response.status === 404) throw Object.assign(new Error('This story is unavailable (HTTP 404). It may have expired.'), {status: 404});
    if (response.status >= 500) throw Object.assign(new Error(`Instagram's ${stage} request failed (HTTP ${response.status}).`), {status:response.status});
    let data;
    try { data = await response.json(); } catch { throw Object.assign(new Error(`Instagram returned non-JSON ${stage} data (HTTP ${response.status}).`),{diagnostic:{status:response.status,stage,nonJSON:true}}); }
    if (data?.challenge || data?.checkpoint_url || /challenge_required|checkpoint_required/.test(data?.message || '')) {
      throw new Error('Instagram requires an account check before downloading this story.');
    }
    if (response.status === 401 || data?.message === 'login_required') throw new Error('Instagram rejected the current session. Sign in and reload Instagram.');
    if(data?.errors?.length)throw new Error('Instagram rejected the highlight query. Complete any account check on Instagram and try again.');
    if (!response.ok || data?.status === 'fail') throw new Error(`Instagram refused the story request (HTTP ${response.status}).`);
    return data;
  }

  async function reel(target) {
    let key;
    if (target.highlightId) key = 'highlight:' + target.highlightId;
    else {
      const headers = __turboLocalRepair.headers();
      const profile = await __turboLocalRepair.open(target.username, headers.appId, headers.wwwClaim);
      if (!/^\d+$/.test(profile.id || '')) throw new Error('Could not resolve the story owner ID.');
      key = profile.id;
    }
    let data,result;
    try{data=await request('/api/v1/feed/reels_media/?reel_ids=' + encodeURIComponent(key));}
    catch(error){
      if(!target.highlightId || (error.status!==404 && !(error.status>=500)))throw error;
      const variables={reel_ids:[],tag_names:[],location_ids:[],highlight_reel_ids:[target.highlightId],precomposed_overlay:false};
      data=await request('/graphql/query/?'+new URLSearchParams({query_hash:'45246d3fe16ccc6577e0bd297a5db1ab',variables:JSON.stringify(variables)}));
      result=data.data?.reels_media?.find(item=>[target.highlightId,key].includes(String(item.id)));
    }
    result ||= data.reels?.[key] || (Array.isArray(data.reels_media) && data.reels_media.find(item => String(item.id) === key));
    if (!result || !Array.isArray(result.items) || !result.items.length) throw new Error('Instagram returned no accessible stories. They may have expired.');
    const username = result.user?.username || result.owner?.username || target.username;
    if(!usernamePattern.test(username || ''))throw new Error('Could not identify the highlight owner.');
    if (target.username && username?.toLowerCase() !== target.username.toLowerCase()) throw new Error('Instagram returned a different story owner.');
    return {username, items: result.items};
  }

  function sameAsset(left, right) {
    try { return new URL(left).origin + new URL(left).pathname === new URL(right).origin + new URL(right).pathname; }
    catch { return false; }
  }

  async function loaded(target, snapshot, all) {
    if (typeof window === 'undefined' || typeof MessageChannel === 'undefined') return null;
    const payload = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {channel.port1.close(); resolve(null);},1000);
      channel.port1.onmessage = event => {clearTimeout(timer); channel.port1.close(); resolve(event.data);};
      window.postMessage({type:'lwlReadLoadedStory',target,pathname:location.pathname,all,
        snapshot:{url:snapshot?.url,poster:snapshot?.poster,id:snapshot?.id}},location.origin,[channel.port2]);
    });
    if (!payload) return null;
    readDiagnostic=payload.diagnostic;
    const username = payload.username || target.username;
    if (!usernamePattern.test(username || '') || (target.username && username.toLowerCase() !== target.username.toLowerCase())) return null;
    const raw = all ? payload.items : payload.current ? [payload.current] : [];
    if (!Array.isArray(raw) || !raw.length) return all?null:displayed({...target,username},snapshot);
    if (!all && (target.mediaId || snapshot?.id) && mediaId(raw[0]) !== (target.mediaId || snapshot.id)) return null;
    try {return {username, items:raw.map(item=>normalize(item,username))};} catch {return all?null:displayed({...target,username},snapshot);}
  }

  function displayed(target,snapshot) {
    if (!snapshot?.fromViewer || !usernamePattern.test(target.username || '')) return null;
    const url = mediaURL(snapshot.url);
    if (!url) return null;
    // A video poster must never stand in for the actual video.
    if (snapshot.isVideo && !/\.(mp4|mov)$/i.test(new URL(url).pathname)) return null;
    let hash = 2166136261;
    for (const char of new URL(url).pathname) hash = Math.imul(hash ^ char.charCodeAt(0),16777619);
    const id = target.mediaId || snapshot.id || 'visible-' + (hash >>> 0).toString(16);
    return {username:target.username,items:[{id,pk:id,username:target.username,taken_at:0,url}]};
  }

  async function resolve(target, snapshot, all) {
    readDiagnostic=undefined;
    target = {...target};
    snapshot = snapshot && {...snapshot};
    const alreadyLoaded = await loaded(target,snapshot,all);
    if (alreadyLoaded) return alreadyLoaded;
    if(!all && snapshot?.isVideo && snapshot.fromViewer && snapshot.url?.startsWith('blob:') && typeof window!=='undefined' && typeof MessageChannel!=='undefined'){
      if(status)status.textContent='Saving buffered video…';
      const payload=await new Promise(resolve=>{
        const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve({error:'Loaded-video recovery timed out. Let the video finish buffering, then try again.'});},22000);
        channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};
        window.postMessage({type:'lwlCaptureLoadedVideo',target,pathname:location.pathname,snapshot:{url:snapshot.url,id:snapshot.id,poster:snapshot.poster}},location.origin,[channel.port2]);
      });
      if(payload.error)throw Object.assign(new Error(payload.error),{diagnostic:{loadedVideoRecovery:true,captureMapped:!!payload.diagnostic?.captureMapped,captureBuffers:Number.isInteger(payload.diagnostic?.captureBuffers)?payload.diagnostic.captureBuffers:0,captureOverflow:!!payload.diagnostic?.captureOverflow}});
      if(!usernamePattern.test(payload.username || '') || !payload.blob?.size || payload.blob.size>128*1024*1024)throw new Error('The loaded video could not be recovered.');
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',await payload.blob.arrayBuffer()));
      const id=target.mediaId || snapshot.id || 'loaded_'+Array.from(digest.slice(0,12),n=>n.toString(16).padStart(2,'0')).join('');
      return {username:payload.username,items:[{username:payload.username,id,pk:id,taken_at:0,url:origin+'/lwl-loaded-video.mp4',blob:payload.blob}]};
    }
    if (!all) {
      const visible = displayed(target,snapshot);
      if (visible) return visible;
    }
    // Capture the requested ID before awaiting: stories can advance while a request runs.
    const id = target.mediaId || snapshot?.id;
    if (!all && id) {
      let data;
      try { data = await request(`/api/v1/media/${id}/info/`); }
      catch (error) { if (error.status !== 404 && !(error.status >= 500)) throw error; }
      const item = data?.items?.find(item => mediaId(item) === id);
      if (item) {
        const owner = item.user?.username || target.username;
        if (target.username && owner?.toLowerCase() !== target.username.toLowerCase()) throw new Error('Instagram returned a different story owner.');
        return {username: owner, items: [normalize(item, owner)]};
      }
    }
    const result = await reel(target);
    if (all) return {username: result.username, items: result.items.map(item => normalize(item, result.username))};
    let matches = id ? result.items.filter(item => mediaId(item) === id) : [];
    if (!id && snapshot) matches = result.items.filter(item => {
      const candidates = [...(item.video_versions || item.video_resources || []), ...(item.image_versions2?.candidates || item.display_resources || [])];
      if(item.display_url)candidates.push({url:item.display_url});
      if(item.video_url)candidates.push({url:item.video_url});
      return candidates.some(candidate => sameAsset(candidate.url || candidate.src, snapshot.url) || sameAsset(candidate.url || candidate.src, snapshot.poster));
    });
    if (matches.length !== 1) throw new Error('Could not identify the current story. Open that story directly, then try again.');
    return {username: result.username, items: [normalize(matches[0], result.username)]};
  }

  function visibleMedia() {
    const candidates = [];
    for (const element of document.querySelectorAll('video, img')) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width < 120 || rect.height < 180 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = width * height;
      if (!area) continue;
      candidates.push({element, rect, area, url: element.currentSrc || element.src,
        poster: element.poster, id: mediaId({id: element.getAttribute('__igdl_id')}),
        fromViewer:true,isVideo:element.tagName === 'VIDEO'});
    }
    candidates.sort((a, b) => b.area - a.area || (b.element.tagName === 'VIDEO') - (a.element.tagName === 'VIDEO'));
    return candidates[0];
  }

  async function download(all) {
    if (busy) return;
    const target = route(), snapshot = visibleMedia();
    if (!target || !snapshot) return;
    busy = true;
    refresh();
    status.textContent = all ? 'Finding stories…' : 'Finding current story…';
    try {
      const result = await resolve(target, snapshot, all);
      let already=0;
      await __lwlBrowserDownloads.download(result.items, {username: result.username}, (done, total,stats) => {
        already=stats?.skipped || 0;
        status.textContent = `${done}/${total} files${already?' · '+already+' already on disk':''}…`;
      });
      status.textContent = already===result.items.length?'Already saved in today’s date folder.':`${result.items.length-already} saved${already?' · '+already+' already on disk':''}.`;
    } catch (error) {
      status.textContent = error.message;
      if(typeof chrome!=='undefined' && chrome.storage?.local){
        const safe={};for(const field of ['viewerVideo','sourceKind','hasPoster','playerCandidates','matchedPlayer','hasOwner','currentFound','currentVideoSources'])if(readDiagnostic?.[field]!==undefined)safe[field]=readDiagnostic[field];
        try{await chrome.storage.local.set({lastStoryDiagnostic:{version:chrome.runtime.getManifest().version,time:new Date().toISOString(),kind:'story-resolution',...safe,...error.diagnostic}});status.textContent+=' Open addon Options to copy failure details.';}catch{}
      }
    } finally {
      busy = false;
      refresh();
    }
  }

  function createToolbar() {
    toolbar = document.createElement('div');
    toolbar.id = 'lwl-story-downloads';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'LWL story downloads');
    for (const [all, title] of [[false, 'Download current story'], [true, 'Download all stories']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>${all ? '<path d="M17 2h5v6m-3-3 3 3"/>' : ''}</svg>`;
      for (const event of ['pointerdown', 'mousedown', 'touchstart']) button.addEventListener(event, event => {event.stopPropagation();}, true);
      button.addEventListener('keydown', event => {if (['Enter', ' '].includes(event.key)) event.stopPropagation();});
      button.addEventListener('click', event => {event.preventDefault(); event.stopPropagation(); void download(all);}, true);
      toolbar.appendChild(button);
    }
    status = document.createElement('div');
    status.className = 'lwl-story-status'; status.setAttribute('role', 'status');
    toolbar.appendChild(status);
  }

  function refresh() {
    scheduled = undefined;
    const current = route(), media = current && visibleMedia();
    if (!current || !media || !document.body) {
      toolbar?.remove();
      if (timer) {clearInterval(timer); timer = undefined;}
      return;
    }
    if (!toolbar) createToolbar();
    const key = JSON.stringify(current);
    if (!busy && currentKey !== key) {status.textContent = ''; currentKey = key;}
    const parent = document.fullscreenElement || document.body;
    if (toolbar.parentElement !== parent) parent.appendChild(toolbar);
    const left = Math.max(8, Math.min(innerWidth - 104, media.rect.right - 104));
    const top = Math.max(52, Math.min(innerHeight - 110, media.rect.top + 64));
    const position = `left:${Math.round(left)}px;top:${Math.round(top)}px`;
    if (toolbar.getAttribute('style') !== position) toolbar.setAttribute('style', position);
    for (const button of toolbar.querySelectorAll('button')) if (button.disabled !== busy) button.disabled = busy;
    if (!timer) timer = setInterval(refresh, 800);
  }

  function schedule() {
    if (scheduled === undefined) scheduled = setTimeout(refresh, 120);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(records => {
      if (!route() && !toolbar?.isConnected) return;
      if (records.some(record => !toolbar?.contains(record.target))) schedule();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'style', 'class', 'hidden']});
    for (const event of ['locationchange', 'popstate', 'resize']) window.addEventListener(event, schedule);
    window.addEventListener('keydown', event => {
      if (route() && event.ctrlKey && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault(); event.stopImmediatePropagation(); void download(false);
      }
    }, true);
    refresh();
  }

  return {route, mediaId, normalize, resolve, visibleMedia, start, refresh, download};
})();
if (typeof document !== 'undefined') __lwlStories.start();
