/* Private local repair adapter. Runs in the extension's isolated content-script world. */
globalThis.__turboLocalRepair = (() => {
  function username(pathname = location.pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const name = parts[0];
    if (!name || !/^[a-zA-Z0-9._]{1,30}$/.test(name) ||
        ['accounts', 'explore', 'p', 'reel', 'reels', 'stories', 'direct'].includes(name.toLowerCase())) {
      throw new Error('Open an Instagram profile before using Download All.');
    }
    return name;
  }

  function headers(storage = sessionStorage) {
    return {
      appId: storage.getItem('__ig_app_id') || '936619743392459',
      wwwClaim: storage.getItem('__ig_www_claim') || storage.getItem('www-claim-v2') || '0'
    };
  }

  function failure(message, status) {
    return Object.assign(new Error(message), {status});
  }

  async function request(url, options, stage) {
    let response;
    try {
      const timeout=AbortSignal.timeout(30000);
      const signal=options.signal && typeof AbortSignal.any==='function'?AbortSignal.any([options.signal,timeout]):options.signal || timeout;
      response = await fetch(url, {...options, credentials: 'same-origin', signal});
    } catch (error) {
      if(options.signal?.aborted)throw error;
      throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'Instagram did not respond within 30 seconds. Try again later.'
        : 'Could not reach Instagram. Check the connection and reload the profile.');
    }
    if (response.status === 429) throw new Error('Instagram rate-limited this request (HTTP 429). Stop and try again later.');
    if (/\/(accounts\/login|challenge|checkpoint)(\/|$)/.test(new URL(response.url || url).pathname)) {
      throw new Error('Instagram redirected this request to login or an account check. Complete it on Instagram and reload.');
    }
    // Classify HTTP failures before trying to parse an HTML error page as JSON.
    if (response.status === 404) throw failure(`Instagram's ${stage} URL is unavailable (HTTP 404).`, 404);
    if (response.status === 401) throw new Error('Instagram rejected the tab session. Sign in on Instagram and reload the profile.');
    return response;
  }

  async function json(response, stage) {
    let data;
    try { data = await response.json(); } catch (error) {
      if(error.name==='AbortError')throw error;
      throw new Error(`Instagram returned a non-JSON response for ${stage} (HTTP ${response.status}).`);
    }
    if (data?.challenge || data?.challenge_url || data?.checkpoint_url ||
        /challenge_required|checkpoint_required/.test(data?.message || '')) {
      throw new Error('Instagram requires an account check. Complete it on Instagram before retrying.');
    }
    if (data?.message === 'login_required') {
      throw new Error('Instagram rejected the tab session. Sign in on Instagram and reload the profile.');
    }
    if (!response.ok) throw new Error(`Instagram refused ${stage} (HTTP ${response.status}).`);
    return data;
  }

  function profileData(html, name) {
    // A fresh request for the target profile avoids stale data after Instagram's SPA navigation.
    // Keep numeric IDs as strings; converting a large ID to Number can lose precision.
    const text = html.replace(/\\"/g, '"');
    const ids = new Set([...text.matchAll(/"profile_id"\s*:\s*"?(\d+)"?/g)].map(match => match[1]));
    const tokens = {};
    for (const [key, pattern] of [
      ['fb_dtsg', /"DTSGInitialData",\[\],\{[^{}]*"token":"([^"]+)"/],
      ['lsd', /"LSD",\[\],\{[^{}]*"token":"([^"]+)"/],
      ['av', /"IG_USER_EIMU":"?(\d+)/]
    ]) {
      const match = text.match(pattern);
      if (match) tokens[key] = match[1];
    }
    return {name, id: ids.size === 1 ? [...ids][0] : undefined, tokens};
  }

  function apiHeaders(client) {
    const result = {
      accept: '*/*', 'x-ig-app-id': client.appId, 'x-ig-www-claim': client.wwwClaim || '0',
      'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '129477'
    };
    // Read only the normal non-HttpOnly CSRF cookie, and send it only back to Instagram.
    const csrf = (typeof document !== 'undefined' ? document.cookie : '')
      .split(';').map(value => value.trim()).find(value => value.startsWith('csrftoken='));
    if (csrf) result['x-csrftoken'] = csrf.slice('csrftoken='.length);
    return result;
  }

  async function open(name, appId, wwwClaim,signal) {
    username(`/${name}/`);
    const url = `https://www.instagram.com/${encodeURIComponent(name)}/`;
    const response = await request(url, {headers: {accept: 'text/html'},signal}, 'profile page');
    if (!response.ok) throw new Error(`Instagram refused the profile page (HTTP ${response.status}).`);
    if (new URL(response.url || url).pathname.toLowerCase() !== `/${name.toLowerCase()}/`) {
      throw new Error('Instagram redirected to a different profile. Reload the intended profile.');
    }
    const client = {...profileData(await response.text(), name), appId, wwwClaim, signal, mode: 'rest'};
    if (!client.id) {
      // Search results are accepted only when the username matches exactly, never the first result.
      const search = new URL('https://www.instagram.com/web/search/topsearch/');
      search.searchParams.set('query', name);
      let searchResponse;
      try { searchResponse = await request(search.href, {headers: apiHeaders(client),signal}, 'profile search'); }
      catch (error) { if (error.status !== 404) throw error; }
      if (searchResponse) {
        const data = await json(searchResponse, 'profile search');
        const user = data.users?.map(result => result.user)
          .find(user => user?.username?.toLowerCase() === name.toLowerCase());
        if (user && /^\d+$/.test(String(user.pk || user.id))) client.id = String(user.pk || user.id);
      }
      if (!client.id) {
        if (client.tokens.lsd && client.tokens.av) client.mode = 'graphql';
        else throw new Error('Could not resolve this profile ID from the page or exact-name search. This repair needs an update.');
      }
    }
    return client;
  }

  async function currentQuery(name) {
    if(typeof window==='undefined' || typeof MessageChannel==='undefined')return null;
    return new Promise(resolve=>{
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();resolve(null);},700);
      channel.port1.onmessage=event=>{
        clearTimeout(timer);channel.port1.close();
        const query=event.data;
        resolve(/^\d{8,30}$/.test(query?.doc || '') && query.variables?.username?.toLowerCase()===name.toLowerCase()?query:null);
      };
      window.postMessage({type:'lwlReadProfileQuery',username:name},location.origin,[channel.port2]);
    });
  }

  function queryRestriction(result) {
    const errors=Array.isArray(result?.errors)?result.errors:[];
    const text=errors.map(error=>[error.message,error.summary,error.description,error.extensions?.code].filter(Boolean).join(' ')).join(' ');
    if(/rate.?limit|please wait|try again later|feedback_required/i.test(text))return new Error('Instagram temporarily restricted this profile query. Stop and try again later.');
    if(/login_required|not authenticated|unauthenticated/i.test(text))return new Error('Instagram rejected the session for the profile query. Reload Instagram and sign in if requested.');
    if(/challenge_required|checkpoint|account check/i.test(text))return new Error('Instagram requires an account check before the profile query can run. Open Instagram and complete it first.');
    if(/private[ _]?(profile|account)|permission|not authorized|access denied/i.test(text))return new Error('Instagram denied access to this profile query. Check that its posts are visible to your signed-in account.');
    return null;
  }

  function queryFailure(result,doc) {
    const restriction=queryRestriction(result);if(restriction)return restriction;
    const errors=Array.isArray(result?.errors)?result.errors:[];
    const text=errors.map(error=>[error.message,error.summary,error.description,error.extensions?.code].filter(Boolean).join(' ')).join(' ');
    const codes=[...new Set(errors.map(error=>error.code || error.extensions?.code).map(String).filter(code=>/^[a-zA-Z0-9_-]{1,32}$/.test(code) && code!=='undefined'))];
    const kind=/execution error|execution_error/i.test(text)?'execution error':/persisted.?query|document|query.*not found/i.test(text)?'unavailable query':'unrecognized response';
    const fields=Object.keys(result?.data || {}).filter(key=>/^[a-zA-Z0-9_]{1,100}$/.test(key)).slice(0,3);
    const connection=result?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
    const diagnostic={query:doc,errorCount:errors.length,codes,dataFields:fields,
      connectionType:type(connection),connectionFields:Object.keys(connection || {}).filter(key=>/^[a-zA-Z0-9_]{1,100}$/.test(key)).slice(0,16),
      edgesType:type(connection?.edges),nodesType:type(connection?.nodes),itemsType:type(connection?.items),
      paginationType:type(connection?.page_info),paginationFields:Object.keys(connection?.page_info || {}).filter(key=>/^[a-zA-Z0-9_]{1,100}$/.test(key)).slice(0,12),
      hasNextType:type(connection?.page_info?.has_next_page),
      severities:errors.map(error=>String(error.severity || '')).filter(value=>/^[A-Z_]{1,20}$/.test(value))};
    return Object.assign(new Error(`Instagram profile query failed: ${kind}${codes.length?' (code '+codes.join(', ')+')':''}. Query ${doc}; timeline ${diagnostic.connectionType}; rows ${diagnostic.edgesType}; pagination ${diagnostic.hasNextType}; errors ${errors.length}. Details are available in the addon's Options.`),{diagnostic,canUseReference:errors.length===0});
  }

  function connectionData(result,doc,profileName) {
    const restriction=queryRestriction(result);if(restriction)throw restriction;
    const data=result?.data;
    const key='xdt_api__v1__feed__user_timeline_graphql_connection';
    const connection=data?.[key];
    const errors=Array.isArray(result?.errors)?result.errors:[];
    const rows=Array.isArray(connection?.edges)?connection.edges:Array.isArray(connection?.nodes)?connection.nodes:connection?.items;
    const more=connection?.page_info?.has_next_page ?? connection?.more_available;
    if(!Array.isArray(rows) || typeof more!=='boolean' || (!rows.length && (errors.length || more)))throw queryFailure(result,doc);
    function invalid(field,path){
      const error=queryFailure(result,doc);
      error.message=`Instagram returned incomplete media data: ${field} at ${path}. The scan stopped before downloading a partial profile. Details are available in the addon's Options.`;
      error.canUseReference=false;
      if(error.diagnostic)error.diagnostic.mediaIssue={field,path};
      throw error;
    }
    function sources(list,path,field){
      if(!Array.isArray(list) || !list.length)invalid(field,path);
      return list.map(source=>{
        let url;
        try{url=new URL(source?.url);}catch{invalid(field,path);}
        if(url.protocol!=='https:')invalid(field,path);
        return {...source,url:url.href,width:Number(source.width)||0,height:Number(source.height)||0};
      });
    }
    function normalize(item,path,owner,parentTime=0){
      if(!item || typeof item!=='object')invalid('post object',path);
      const id=String(item.id || item.pk || '');
      if(!/^[a-zA-Z0-9_-]+$/.test(id))invalid('media ID',path);
      const username=item.user?.username || item.owner?.username || owner;
      if(!/^[a-zA-Z0-9._]{1,30}$/.test(username || ''))invalid('media owner',path);
      const taken_at=item.taken_at || item.taken_at_timestamp || parentTime;
      const normalized={...item,id,pk:item.pk || id,user:{...item.user,username},taken_at};
      if(item.carousel_media!==undefined && item.carousel_media!==null){
        if(!Array.isArray(item.carousel_media) || !item.carousel_media.length)invalid('carousel items',path);
        normalized.carousel_media=item.carousel_media.map((child,index)=>normalize(child,`${path}/slide ${index+1}`,username,taken_at));
      }else if(item.media_type===2 || item.is_video || item.video_versions?.length){
        const versions=item.video_versions?.length?item.video_versions:item.video_url?[{url:item.video_url}]:undefined;
        normalized.video_versions=sources(versions,path,'video source');
      }else{
        normalized.image_versions2={...item.image_versions2,candidates:sources(item.image_versions2?.candidates,path,'image source')};
        // An empty video_versions array is truthy in the upstream parser: remove it for photos.
        delete normalized.video_versions;
      }
      return normalized;
    }
    const items=rows.map((edge,index)=>normalize(edge?.node?.media || edge?.node || edge?.media || edge,`post ${index+1}`,profileName));
    return {items,more_available:more,next_max_id:connection?.page_info?.end_cursor ?? connection?.next_max_id};
  }

  async function graphql(client, cursor) {
    if(!client.queryChecked){client.pageQuery=await currentQuery(client.name);client.queryChecked=true;}
    const variables = client.pageQuery ? JSON.parse(JSON.stringify(client.pageQuery.variables)) : {
      data: {count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true,
        latest_besties_reel_media: true, latest_reel_media: true},
      first: 12, include_multi_captions: true, username: client.name,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
      __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
      __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false
    };
    if (cursor !== undefined) variables.after = cursor;
    const doc=client.pageQuery?.doc || '29104886249145907';
    const body = new URLSearchParams({doc_id: doc, variables: JSON.stringify(variables),
      fb_api_req_friendly_name:'PolarisProfilePostsTabContentQuery_connection',
      server_timestamps: 'true', ...client.tokens});
    const response = await request('https://www.instagram.com/api/graphql', {
      method: 'POST', signal:client.signal, headers: {...apiHeaders(client), 'content-type': 'application/x-www-form-urlencoded',
        'x-fb-lsd': client.tokens.lsd}, body: body.toString()
    }, 'web profile query');
    const result = await json(response, 'web profile query');
    try{return connectionData(result,doc,client.name);}catch(error){
      // A page query with a structurally incompatible, error-free result can use the known
      // reference query once, before pagination. Never retry access/rate/account rejections.
      if(client.pageQuery && doc!=='29104886249145907' && cursor===undefined && error.canUseReference){
        client.pageQuery=null;
        try{return await graphql(client,cursor);}catch(referenceError){
          if(referenceError.diagnostic)referenceError.diagnostic.observedQueryFailure=error.diagnostic;
          throw referenceError;
        }
      }
      throw error;
    }
  }

  async function page(client, cursor) {
    let data;
    if (client.mode === 'graphql') data = await graphql(client, cursor);
    else {
      if (!/^\d+$/.test(client.id || '')) throw new Error('Invalid numeric profile ID.');
      const url = new URL(`/api/v1/feed/user/${client.id}/`, 'https://www.instagram.com');
      url.searchParams.set('count', '12');
      if (cursor !== undefined) url.searchParams.set('max_id', cursor);
      try {
        const response = await request(url.href, {headers: apiHeaders(client),signal:client.signal}, 'numeric profile feed');
        const claim = response.headers?.get('x-ig-set-www-claim');
        if (claim) client.wwwClaim = claim;
        data = await json(response, 'numeric profile feed');
      } catch (error) {
        // Only switch before page one. REST and GraphQL cursors are not interchangeable.
        if (error.status !== 404 || cursor !== undefined || !client.tokens.lsd || !client.tokens.av) throw error;
        client.mode = 'graphql';
        data = await graphql(client, cursor);
      }
    }
    if (!data || data.status === 'fail' || !Array.isArray(data.items)) {
      throw new Error('Instagram returned an unsupported profile feed. This repair needs an update; your sign-in may be fine.');
    }
    if (data.more_available && (data.next_max_id === undefined || data.next_max_id === null || data.next_max_id === '' ||
        String(data.next_max_id) === String(cursor))) {
      throw new Error('Instagram returned an invalid pagination cursor. Stopped to avoid repeating requests.');
    }
    return data;
  }

  function account(name, data) {
    const user = data.user || data.items.map(item => item.user).find(user => user?.username?.toLowerCase() === name.toLowerCase());
    if (user?.username && user.username.toLowerCase() !== name.toLowerCase()) {
      throw new Error('Instagram returned a different profile. Reload the intended profile before retrying.');
    }
    return {
      username: name,
      profilePicUrl: user?.profile_pic_url || '',
      totalPosts: Number(user?.media_count || data.num_results || data.items.length) || 0
    };
  }

  return { username, headers, open, page, account, profileData, connectionData };
})();
