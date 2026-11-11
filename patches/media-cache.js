/* Cache keys contain stable media names, never signed CDN URLs or session credentials. */
globalThis.LWLMediaCache=class{
  constructor({storage=globalThis.caches,now=()=>Date.now(),maxBytes=512*1024*1024,maxAge=7*86400000}={}){
    this.storage=storage;this.now=now;this.maxBytes=maxBytes;this.maxAge=maxAge;this.writes=Promise.resolve();
  }
  url(key){return 'https://lwl-media-cache.invalid/'+encodeURIComponent(key);}
  async get(key){
    const cache=await this.storage.open('lwl-media-v1'),url=this.url(key),response=await cache.match(url);
    if(!response)return;
    if(this.now()-Number(response.headers.get('x-lwl-used'))>this.maxAge){await cache.delete(url);return;}
    const blob=await response.blob();await this.put(key,blob);return blob;
  }
  put(key,blob){
    const write=this.writes.catch(()=>{}).then(async()=>{
      if(blob.size>this.maxBytes)return;
      const cache=await this.storage.open('lwl-media-v1');
      await cache.put(this.url(key),new Response(blob,{headers:{'x-lwl-used':String(this.now()),'x-lwl-size':String(blob.size)}}));
      await this.trim(cache);
    });this.writes=write;return write;
  }
  async trim(cache){
    const rows=await Promise.all((await cache.keys()).map(async request=>{const response=await cache.match(request);return {request,used:Number(response.headers.get('x-lwl-used')),size:Number(response.headers.get('x-lwl-size'))};}));
    let total=rows.reduce((sum,row)=>sum+row.size,0);
    for(const row of rows.sort((a,b)=>a.used-b.used))if(this.now()-row.used>this.maxAge || total>this.maxBytes){await cache.delete(row.request);total-=row.size;}
  }
  async clear(){await this.writes.catch(()=>{});await this.storage.delete('lwl-media-v1');}
};
