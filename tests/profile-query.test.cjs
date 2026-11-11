const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {MessageChannel}=require('node:worker_threads');
const root=join(__dirname,'..');
const apiSource=readFileSync(join(root,'extension/js/local-bulk-api.js'),'utf8');
const pageSource=readFileSync(join(root,'extension/js/profile-page.js'),'utf8');
const key='xdt_api__v1__feed__user_timeline_graphql_connection';
function media(){return {id:'123',pk:'123',user:{username:'example'},image_versions2:{candidates:[{url:'https://scontent.cdninstagram.com/a.jpg'}]}};}
function result(){return {data:{[key]:{edges:[{node:media()}],page_info:{has_next_page:false,end_cursor:null}}}};}
function api(){const context=vm.createContext({URL,URLSearchParams});vm.runInContext(apiSource,context);return context.__turboLocalRepair;}
function page(){const context=vm.createContext({URL,URLSearchParams,Reflect});vm.runInContext(pageSource.replace('__lwlProfilePage.start();',''),context);return {api:context.__lwlProfilePage,context};}
function form(){return new URLSearchParams({doc_id:'55555555555555',fb_api_req_friendly_name:'PolarisProfilePostsTabContentQuery_connection',
  fb_dtsg:'must-not-be-retained',lsd:'must-not-be-retained',variables:JSON.stringify({username:'example',first:12,after:'old-cursor',
    data:{count:12,include_relationship_info:true,secret:'must-not-be-retained'},include_multi_captions:true,
    __relay_internal__pv__CurrentProfileFlag:true,password:'must-not-be-retained'})});}

test('optional comments errors no longer reject complete downloadable post data',()=>{
  const data=result();data.errors=[{message:'Optional preview failed',path:[key,'edges',0,'node','preview_comments']}];
  assert.equal(api().connectionData(data,'12345678').items.length,1);
});
test('an actually missing media source is never treated as a complete profile',()=>{
  const data=result();data.errors=[{message:'execution error',code:1357004,path:[key,'edges',0,'node','image_versions2']}];
  data.data[key].edges[0].node.image_versions2=null;
  assert.throws(()=>api().connectionData(data,'12345678'),/incomplete media data.*image source/);
});
test('soft HTTP-200 restrictions, login and account checks get specific messages',()=>{
  for(const [message,expected] of [['Please wait a few minutes before you try again',/temporarily restricted/],
    ['login_required',/session/],['challenge_required',/account check/],['access denied for private account',/denied access/]]){
    assert.throws(()=>api().connectionData({errors:[{message}]},'12345678'),expected);
  }
});
test('unknown responses expose schema keys and safe codes, never raw response content',()=>{
  assert.throws(()=>api().connectionData({data:{unexpected_connection:null},errors:[{message:'secret-value-not-for-display',code:12345}]},'12345678'),error=>{
    assert.match(error.message,/12345.*12345678/);
    assert.ok(error.diagnostic.dataFields.includes('unexpected_connection'));
    assert.ok(!error.message.includes('secret-value-not-for-display'));return true;
  });
});
test('wrapped post nodes are accepted, incomplete media stops the scan',()=>{
  const data=result();data.data[key].edges=[{node:{media:media()}}];
  assert.equal(api().connectionData(data,'12345678').items[0].id,'123');
  data.data[key].edges=[{node:{id:'123'}}];
  assert.throws(()=>api().connectionData(data,'12345678'),/incomplete media/);
});
test('observed profile query descriptor excludes auth, unrelated variables and old cursors',()=>{
  const {api}=page();api.observe(form());const query=api.get('example');
  assert.equal(query.doc,'55555555555555');
  assert.equal(query.variables.after,undefined);
  assert.equal(query.variables.__relay_internal__pv__CurrentProfileFlag,true);
  assert.ok(!JSON.stringify(query).includes('must-not-be-retained'));
  assert.equal(api.get('another-account'),null);
});
test('story and unrelated queries cannot replace the profile descriptor',()=>{
  const {api}=page();const body=form();body.set('fb_api_req_friendly_name','PolarisStoriesQuery');api.observe(body);
  assert.equal(api.get('example'),null);
});

test('new page-query flags, null parameters and observed counts survive descriptor capture',()=>{
  const {api}=page(),body=form(),variables=JSON.parse(body.get('variables'));
  variables.first=24;variables.data.count=24;variables.new_required_profile_flag=true;
  variables.data.new_filter_enabled=false;variables.new_nullable_parameter=null;
  body.set('variables',JSON.stringify(variables));api.observe(body);
  const query=api.get('example');
  assert.equal(query.variables.first,24);
  assert.equal(query.variables.data.count,24);
  assert.equal(query.variables.new_required_profile_flag,true);
  assert.equal(query.variables.data.new_filter_enabled,false);
  assert.equal(query.variables.new_nullable_parameter,null);
});

test('nodes and items connections work only with explicit pagination state',()=>{
  const data=result(),connection=data.data[key];
  delete connection.edges;connection.nodes=[media()];
  assert.equal(api().connectionData(data,'12345678').items.length,1);
  delete connection.nodes;connection.items=[media()];delete connection.page_info;
  assert.throws(()=>api().connectionData(data,'12345678'),/pagination undefined/);
  connection.more_available=false;
  assert.equal(api().connectionData(data,'12345678').more_available,false);
});

test('null timeline diagnostics retain only shape metadata despite viewer data',()=>{
  const data={data:{[key]:null,xdt_viewer:{username:'private-fixture-name',sessionid:'private-fixture-session'}}};
  assert.throws(()=>api().connectionData(data,'29224840567111233'),error=>{
    assert.equal(error.diagnostic.connectionType,'null');
    assert.equal(error.diagnostic.edgesType,'undefined');
    assert.equal(error.diagnostic.errorCount,0);
    assert.ok(!JSON.stringify(error.diagnostic).includes('private-fixture'));
    return true;
  });
});

test('warning-only root errors do not discard a complete timeline',()=>{
  const data=result();data.errors=[{severity:'WARNING',message:'Optional field warning'}];
  assert.equal(api().connectionData(data,'12345678').items.length,1);
});

test('four unclassified query errors do not discard structurally complete downloadable posts',()=>{
  const data=result();data.errors=Array.from({length:4},()=>({severity:'CRITICAL',message:'Fixture presentation field failed'}));
  const parsed=api().connectionData(data,'29224840567111233');
  assert.equal(parsed.items.length,1);
  assert.equal(parsed.items[0].image_versions2.candidates[0].url,'https://scontent.cdninstagram.com/a.jpg');
});

test('restrictions still stop a response even when complete post data is present',()=>{
  const data=result();data.errors=[{message:'feedback_required',path:[key,'edges',0,'node','preview_comments']}];
  assert.throws(()=>api().connectionData(data,'12345678'),/temporarily restricted/);
});

test('one missing post is not silently filtered out of an otherwise usable page',()=>{
  const data=result();data.data[key].edges.push({node:null});data.errors=[{message:'Fixture data failure'}];
  assert.throws(()=>api().connectionData(data,'12345678'),error=>{
    assert.match(error.message,/incomplete media data: .* at post 2/);
    assert.equal(error.diagnostic.mediaIssue.path,'post 2');return true;
  });
});

test('modern owner fields and empty video arrays normalize for the actual download parser',()=>{
  const data=result(),node=data.data[key].edges[0].node;
  node.owner=node.user;delete node.user;node.video_versions=[];
  const parsed=api().connectionData(data,'12345678');
  assert.equal(parsed.items[0].user.username,'example');
  assert.equal(parsed.items[0].video_versions,undefined);
});

test('carousel child media inherits owner/timestamp and every slide is validated',()=>{
  const data=result();data.data[key].edges=[{node:{id:'parent',user:{username:'example'},taken_at:1000,
    carousel_media:[{id:'child',image_versions2:{candidates:[{url:'https://scontent.cdninstagram.com/child.jpg'}]}}]}}];
  const parsed=api().connectionData(data,'12345678');
  assert.equal(parsed.items[0].carousel_media[0].user.username,'example');
  assert.equal(parsed.items[0].carousel_media[0].taken_at,1000);
  data.data[key].edges[0].node.carousel_media.push({id:'missing'});
  assert.throws(()=>api().connectionData(data,'12345678'),/image source at post 1\/slide 2/);
});

test('a video with only a poster is rejected rather than downloaded as an image',()=>{
  const data=result();data.data[key].edges[0].node.media_type=2;
  assert.throws(()=>api().connectionData(data,'12345678'),/video source/);
});

test('empty rows accompanied by query errors cannot report a successful empty profile',()=>{
  const data=result();data.data[key].edges=[];data.errors=[{message:'Fixture data error'}];
  assert.throws(()=>api().connectionData(data,'12345678'),/profile query failed/);
});

test('incompatible observed first-page schema uses the reference query once and pins that mode',async()=>{
  const {api:bridge}=page();bridge.observe(form());const docs=[];
  const context=vm.createContext({URL,URLSearchParams,MessageChannel,setTimeout,clearTimeout,AbortSignal,
    location:{origin:'https://www.instagram.com'},window:{postMessage(message,origin,ports){ports[0].postMessage(bridge.get(message.username));ports[0].close();}},
    fetch:async(url,options)=>{const form=new URLSearchParams(options.body);docs.push(form.get('doc_id'));
      return {ok:true,status:200,url,json:async()=>docs.length===1?{data:{[key]:null,xdt_viewer:{}}}:result()};}});
  vm.runInContext(apiSource,context);
  const client={name:'example',mode:'graphql',tokens:{},appId:'fixture',wwwClaim:'0'};
  await context.__turboLocalRepair.page(client);
  await context.__turboLocalRepair.page(client,'reference-next');
  assert.deepEqual(docs,['55555555555555','29104886249145907','29104886249145907']);
});

test('reference fallback never retries account restrictions',async()=>{
  const {api:bridge}=page();bridge.observe(form());let calls=0;
  const context=vm.createContext({URL,URLSearchParams,MessageChannel,setTimeout,clearTimeout,AbortSignal,
    location:{origin:'https://www.instagram.com'},window:{postMessage(message,origin,ports){ports[0].postMessage(bridge.get(message.username));ports[0].close();}},
    fetch:async(url)=>{calls++;return {ok:true,status:200,url,json:async()=>({errors:[{message:'feedback_required'}]})};}});
  vm.runInContext(apiSource,context);
  await assert.rejects(()=>context.__turboLocalRepair.page({name:'example',mode:'graphql',tokens:{},appId:'fixture',wwwClaim:'0'}),/temporarily restricted/);
  assert.equal(calls,1);
});

test('Options reveals stored diagnostics and copies exactly the safe saved record',async()=>{
  const elements=new Map(['matcher','destination','preview','version','failure-details','failure-section','status'].map(id=>[id,{hidden:true}]));
  const diagnostic={version:'fixture',query:'29224840567111233',connectionType:'null',errorCount:0};
  let click,copied;
  const button={dataset:{copy:'failure-details'},addEventListener(event,callback){click=callback;}};
  const context=vm.createContext({Date,document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[button]},
    chrome:{runtime:{getManifest:()=>({version:'fixture'})},storage:{local:{get:async()=>({lastBatchDiagnostic:diagnostic})}}},
    navigator:{clipboard:{writeText:async value=>{copied=value;}}}});
  vm.runInContext(readFileSync(join(root,'extension/settings.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('failure-section').hidden,false);
  await click();assert.deepEqual(JSON.parse(copied),diagnostic);
});
test('batch request uses the page-observed query ID and its own current pagination cursor',async()=>{
  const {api:bridge}=page();bridge.observe(form());let sent;
  const context=vm.createContext({URL,URLSearchParams,MessageChannel,setTimeout,clearTimeout,AbortSignal,
    location:{origin:'https://www.instagram.com'},window:{postMessage(message,origin,ports){ports[0].postMessage(bridge.get(message.username));ports[0].close();}},
    fetch:async(url,options)=>{sent=new URLSearchParams(options.body);return {ok:true,status:200,url,json:async()=>result()};}});
  vm.runInContext(apiSource,context);
  await context.__turboLocalRepair.page({name:'example',mode:'graphql',tokens:{},appId:'fixture',wwwClaim:'0'},'current-cursor');
  assert.equal(sent.get('doc_id'),'55555555555555');
  const variables=JSON.parse(sent.get('variables'));
  assert.equal(variables.after,'current-cursor');
  assert.equal(variables.username,'example');
  assert.equal(variables.__relay_internal__pv__CurrentProfileFlag,true);
});
test('passive profile observer preserves the original fetch promise and arguments',()=>{
  const {api,context}=page();const pending=Promise.resolve({});let captured;
  context.location={origin:'https://www.instagram.com',href:'https://www.instagram.com/example/'};
  context.window={addEventListener(){},fetch(...args){captured=args;return pending;}};
  context.XMLHttpRequest={prototype:{open(){},send(){}}};
  api.start();const body=form().toString(),options={method:'POST',body};
  assert.equal(context.window.fetch('https://www.instagram.com/api/graphql',options),pending);
  assert.equal(captured[1],options);
  assert.equal(api.get('example').doc,'55555555555555');
});
