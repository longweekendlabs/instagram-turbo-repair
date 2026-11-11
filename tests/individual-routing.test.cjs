const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('deployed legacy post, carousel and avatar helpers all use managed date-folder downloads',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extension/js/extension.js'),'utf8'),writes=[],warnings=[];
  const start=source.indexOf('async function Ie(item)'),end=source.indexOf('const Le=',start);
  const many=source.indexOf('async function Oe(items,account)',end),last=source.indexOf('function Me(e)',many);
  assert.ok(start>=0 && many>start);
  const context=vm.createContext({__lwlBrowserDownloads:{async download(...args){writes.push(args);}},s:{createAndAdd:async message=>warnings.push(message)}});
  vm.runInContext(source.slice(start,end)+source.slice(many,last),context);
  await context.Ie({id:'123',username:'example'});
  await context.Oe([{id:'124',username:'example'},{id:'125',username:'example'}]);
  await context.Ie({id:'',pk:'',username:'example'});
  assert.equal(writes.length,3);assert.equal(writes[1][0].length,2);assert.equal(writes[2][0][0].id,'profile');
  assert.ok(writes.every(args=>!args[3]?.requireProfileFolder));assert.deepEqual(warnings,[]);
});
