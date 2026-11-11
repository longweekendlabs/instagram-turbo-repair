const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');

test('deployed post observer scans a shared subtree once and skips unchanged media IDs',()=>{
  const source=readFileSync(join(__dirname,'../extension/js/inject.js'),'utf8');
  const scanStart=source.indexOf('function writePostId(');
  const scanEnd=source.indexOf('!function e(){try{sessionStorage.setItem',scanStart);
  const observerStart=source.indexOf('const pendingRoots = new Set()');
  const observerEnd=source.indexOf(';!function e(){try{const e=document.querySelector("body")',observerStart);
  assert.ok(scanStart>=0 && scanEnd>scanStart && observerStart>=0 && observerEnd>observerStart);
  let queries=0,writes=0,id,observe,options;
  const scheduled=[];
  const post={getAttribute:()=>id,setAttribute(name,value){id=String(value);writes++;}};
  const root={isConnected:true,querySelectorAll(selector){queries++;return selector==='article'?[post]:[];}};
  const child={...root,parentElement:root};
  const context=vm.createContext({
    r:()=> '123',t:()=>true,
    setTimeout(fn){scheduled.push(fn);return scheduled.length;},
    MutationObserver:class{constructor(fn){observe=fn;}observe(node,value){options=value;}}
  });
  vm.runInContext(source.slice(scanStart,scanEnd)+source.slice(observerStart,observerEnd)+';a.observe({},o);',context);
  assert.ok(!options.attributeFilter.includes('__igdl_id'));
  const records=Array.from({length:500},(_,i)=>({type:'childList',target:i%2?root:child}));
  observe(records);
  assert.equal(queries,0);
  assert.equal(scheduled.length,1);
  scheduled.shift()();
  assert.equal(queries,6);
  assert.equal(writes,1);
  observe(records);
  scheduled.shift()();
  assert.equal(queries,12);
  assert.equal(writes,1);
});
