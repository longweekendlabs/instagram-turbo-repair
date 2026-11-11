const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {join}=require('node:path');
function fixture(){
  let now=0;const values=new Map();
  const storage={open:async()=>({match:async key=>values.get(key.url || key)?.clone(),put:async(key,value)=>{values.set(key.url || key,value.clone());},keys:async()=>[...values.keys()].map(url=>({url})),delete:async key=>values.delete(key.url || key)}),delete:async()=>values.clear()};
  const context=vm.createContext({Response});
  vm.runInContext(readFileSync(join(__dirname,'../extension/js/media-cache.js'),'utf8'),context);
  const create=options=>new context.LWLMediaCache({storage,now:()=>now,...options});
  return {create,values,advance:amount=>{now+=amount;}};
}
test('media cache persists across reader instances and preserves actual bytes',async()=>{
  const f=fixture();await f.create().put('example/media.jpg',new Blob(['actual media bytes']));
  assert.equal(await (await f.create().get('example/media.jpg')).text(),'actual media bytes');
  assert.ok([...f.values.keys()].every(key=>key.startsWith('https://lwl-media-cache.invalid/')));
});
test('media cache expires stale files',async()=>{
  const f=fixture(),cache=f.create({maxAge:10});await cache.put('old',new Blob(['old']));f.advance(11);
  assert.equal(await cache.get('old'),undefined);assert.equal(f.values.size,0);
});
test('media cache evicts the least recently used files to stay inside its byte limit',async()=>{
  const f=fixture(),cache=f.create({maxBytes:6});await cache.put('a',new Blob(['aaa']));f.advance(1);await cache.put('b',new Blob(['bbb']));f.advance(1);await cache.get('a');f.advance(1);await cache.put('c',new Blob(['ccc']));
  assert.equal(await cache.get('b'),undefined);assert.equal((await cache.get('a')).size,3);assert.equal((await cache.get('c')).size,3);
});
test('oversized media is not retained and clearing removes only the cache',async()=>{
  const f=fixture(),cache=f.create({maxBytes:2});await cache.put('large',new Blob(['large']));assert.equal(f.values.size,0);
  await cache.put('small',new Blob(['x']));await cache.clear();assert.equal(f.values.size,0);
});
