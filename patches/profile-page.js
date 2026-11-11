/* Observe only the public descriptor of Instagram's own profile query. No auth fields. */
globalThis.__lwlProfilePage = (() => {
  const queries = new Map();
  function observe(body) {
    if (typeof body !== 'string' && !(body instanceof URLSearchParams)) return;
    const form = new URLSearchParams(body), doc = form.get('doc_id');
    if (!/^\d{8,30}$/.test(doc || '')) return;
    const friendly = form.get('fb_api_req_friendly_name') || '';
    if (friendly !== 'PolarisProfilePostsTabContentQuery_connection') return;
    let input;
    try {input=JSON.parse(form.get('variables'));} catch {return;}
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(input?.username || '') || !input.data || !Number.isInteger(input.first)) return;
    // New query documents may require new flags. Preserve boolean/numeric/null parameters
    // recursively rather than pairing a new document ID with the old document's flag list.
    function flags(value,depth=0){
      if(value===null || typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value)))return value;
      if(!value || typeof value!=='object' || Array.isArray(value) || depth>4)return undefined;
      const result={};
      for(const [key,child] of Object.entries(value)){
        if(!/^[a-zA-Z0-9_]{1,160}$/.test(key) || /token|password|secret|authorization|cookie|session|^(__proto__|constructor|prototype)$|^(after|before)$/i.test(key))continue;
        const copied=flags(child,depth+1);if(copied!==undefined)result[key]=copied;
      }
      return result;
    }
    const variables={...flags(input),username:input.username};
    queries.set(input.username.toLowerCase(),{doc,variables});
    while(queries.size>10)queries.delete(queries.keys().next().value);
  }
  function start() {
    window.addEventListener('message',event=>{
      if(event.source!==window || event.origin!==location.origin || event.data?.type!=='lwlReadProfileQuery' || !event.ports?.[0])return;
      const port=event.ports[0];
      port.postMessage(queries.get(String(event.data.username).toLowerCase()) || null);port.close();
    });
    const originalFetch=window.fetch;
    window.fetch=function(...args){
      try {if(new URL(typeof args[0]==='string'?args[0]:args[0]?.url,location.href).pathname==='/api/graphql')observe(args[1]?.body);}catch{}
      return Reflect.apply(originalFetch,this,args);
    };
    const originalOpen=XMLHttpRequest.prototype.open,originalSend=XMLHttpRequest.prototype.send;
    const paths=new WeakMap();
    XMLHttpRequest.prototype.open=function(method,url,...rest){
      try {paths.set(this,new URL(url,location.href).pathname);}catch{}
      return Reflect.apply(originalOpen,this,[method,url,...rest]);
    };
    XMLHttpRequest.prototype.send=function(body){
      try {if(paths.get(this)==='/api/graphql')observe(body);}catch{}
      return Reflect.apply(originalSend,this,[body]);
    };
  }
  return {observe,start,get:username=>queries.get(username.toLowerCase()) || null};
})();
__lwlProfilePage.start();
