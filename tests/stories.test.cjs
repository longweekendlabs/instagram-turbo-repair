const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const root = join(__dirname, '..');
const source = readFileSync(join(root, 'extension/js/stories.js'), 'utf8');
const installed = join(require('./fixture-paths.cjs').upstreamDir,'js');

function photo(id = '123', username = 'example') {
  return {id, pk: id, user: {username}, media_type: 1, taken_at: 1000,
    image_versions2: {candidates: [{width:100, height:200, url:'https://scontent.cdninstagram.com/small.jpg'},
      {width:1080, height:1920, url:`https://scontent.cdninstagram.com/${id}.jpg`}]}};
}
function setup(responses = []) {
  const calls = [];
  const context = vm.createContext({URL, URLSearchParams, AbortSignal,
    __turboLocalRepair: {headers: () => ({appId:'fixture-app', wwwClaim:'0'}), open: async () => ({id:'999'})},
    fetch: async (url, options) => {
      calls.push({url, options});
      const next = responses.shift();
      assert.ok(next, 'Unexpected story request');
      return {status:next.status || 200, ok:!next.status || next.status < 400, url,
        json:async () => next.data};
    }
  });
  // Load the exact deployed module, skipping only automatic DOM startup for pure API tests.
  vm.runInContext(source.replace("if (typeof document !== 'undefined') __lwlStories.start();", ''), context);
  context.document = {cookie:'csrftoken=fixture-csrf'};
  return {api:context.__lwlStories, calls};
}

test('reproduces upstream tray-cache failure for a story outside the home tray', () => {
  const old = readFileSync(join(installed, 'extension.js'), 'utf8');
  const begin = old.indexOf('handleStoryDownloadRequest(e){');
  const end = old.indexOf('getDirHandleForStoryDownload()', begin);
  const alerts = [];
  const context = vm.createContext({s:{createAndAdd:message => alerts.push(message)}, g:{error:'error'}});
  const Controller = vm.runInContext(`(class {${old.slice(begin, end)}})`, context);
  const controller = new Controller();
  controller.userStoryReelsDataMap = {};
  controller.handleStoryDownloadRequest({username:'example', initial_media_id:'123'});
  assert.match(alerts[0], /Unable to download requested story/);
});

test('reproduces upstream numeric/string ID filtering bug', () => {
  const old = readFileSync(join(installed, 'inject.js'), 'utf8');
  const expression = old.match(/a\[0\]\.items\.filter\(\(e=>e\.pk===t\)\)/)[0];
  assert.equal(vm.runInNewContext(expression, {a:[{items:[{pk:123}]}], t:'123'}).length, 0);
});

test('single story loads by media ID without a home-tray or profile lookup', async () => {
  const env = setup([{data:{items:[photo('123')]}}]);
  const result = await env.api.resolve({username:'example',mediaId:'123'}, {}, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://scontent.cdninstagram.com/123.jpg');
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, 'https://www.instagram.com/api/v1/media/123/info/');
  assert.equal(env.calls[0].options.credentials, 'same-origin');
  assert.equal(env.calls[0].options.headers['x-csrftoken'], 'fixture-csrf');
});

test('numeric and composite IDs normalize while preserving large string IDs', async () => {
  const env = setup([{data:{items:[{...photo(),id:'123_999',pk:123}]}}]);
  assert.equal((await env.api.resolve({username:'example',mediaId:'123'}, {}, false)).items[0].id, '123');
  assert.equal(env.api.mediaId({id:'1234567891234567890_999'}), '1234567891234567890');
});

test('a video downloads its best video source rather than its poster', async () => {
  const item = {...photo(),media_type:2,video_versions:[
    {width:300,height:600,url:'https://scontent.fbcdn.net/small.mp4'},
    {width:1080,height:1920,url:'https://scontent.fbcdn.net/full.mp4'}]};
  const env = setup([{data:{items:[item]}}]);
  const result = await env.api.resolve({username:'example',mediaId:'123'}, {}, false);
  assert.equal(result.items[0].url, 'https://scontent.fbcdn.net/full.mp4');
  assert.throws(() => env.api.normalize({...item,video_versions:[]},'example'), /downloadable video/);
});

test('captured current ID stays fixed when the caller target changes while awaiting', async () => {
  const env = setup([{data:{items:[photo()]}}]);
  const target = {username:'example',mediaId:'123'};
  const pending = env.api.resolve(target, {}, false);
  target.mediaId = '456';
  assert.equal((await pending).items[0].id, '123');
});

test('media-info 404 falls back to exact ID in the requested reel, never the first item', async () => {
  const env = setup([{status:404}, {data:{reels:{'999':{user:{username:'example'},items:[photo('111'),photo('123')]}}}}]);
  const result = await env.api.resolve({username:'example',mediaId:'123'}, {}, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, '123');
  assert.ok(env.calls[1].url.endsWith('reel_ids=999'));
});

test('an HTTP 500 media-info response can fall back to the exact reel item', async () => {
  const env = setup([{status:500}, {data:{reels:{'999':{user:{username:'example'},items:[photo('111'),photo('123')]}}}}]);
  const result = await env.api.resolve({username:'example',mediaId:'123'}, {}, false);
  assert.equal(result.items[0].id,'123');
  assert.equal(env.calls.length,2);
});

test('current highlight photo uses a separate query when REST returns 500',async()=>{
  const env=setup([{status:500},{data:{data:{reels_media:[{id:'12',owner:{username:'example'},items:[
    {id:'111',display_url:'https://scontent.cdninstagram.com/other.jpg'},
    {id:'123',taken_at_timestamp:1000,display_resources:[{src:'https://scontent.cdninstagram.com/current.jpg',config_width:1080,config_height:1920}]}]}]}}}]);
  const result=await env.api.resolve({highlightId:'12'},{url:'https://scontent.cdninstagram.com/current.jpg?signature=fixture'},false);
  assert.equal(result.username,'example');assert.equal(result.items[0].id,'123');
  const query=new URL(env.calls[1].url);
  assert.equal(query.pathname,'/graphql/query/');
  assert.deepEqual(JSON.parse(query.searchParams.get('variables')).highlight_reel_ids,['12']);
});

test('highlight query never falls back after a rate limit or session rejection',async()=>{
  for(const status of [401,403,429]){
    const env=setup([{status,data:{message:status===401?'login_required':'restricted'}}]);
    await assert.rejects(()=>env.api.resolve({highlightId:'12'},{},false));assert.equal(env.calls.length,1);
  }
});

test('highlight query cannot save an unrelated reel or an ambiguous current asset',async()=>{
  for(const reel of [
    {id:'99',owner:{username:'example'},items:[photo('123')]},
    {id:'12',owner:{username:'example'},items:[photo('111'),photo('123')]}
  ]){
    const env=setup([{status:500},{data:{data:{reels_media:[reel]}}}]);
    await assert.rejects(()=>env.api.resolve({highlightId:'12'},{url:'https://scontent.cdninstagram.com/unknown.jpg'},false));
  }
});

test('GraphQL highlight video resources produce a video, never its poster',()=>{
  const env=setup();
  const result=env.api.normalize({id:'123',is_video:true,display_url:'https://scontent.cdninstagram.com/poster.jpg',video_resources:[{src:'https://scontent.fbcdn.net/current.mp4',config_width:1080,config_height:1920}]},'example');
  assert.equal(result.url,'https://scontent.fbcdn.net/current.mp4');
});

test('no-ID routes match the visible image asset rather than an arbitrary reel item', async () => {
  const env = setup([{data:{reels_media:[{id:'999',user:{username:'example'},items:[photo('111'),photo('123')]}]}}]);
  const result = await env.api.resolve({username:'example'}, {url:'https://scontent.cdninstagram.com/123.jpg?new-signature'}, false);
  assert.equal(result.items[0].id, '123');
});

test('ambiguous no-ID routes cannot silently save the wrong story', async () => {
  const env = setup([{data:{reels:{'999':{user:{username:'example'},items:[photo('111'),photo('123')]}}}}]);
  await assert.rejects(() => env.api.resolve({username:'example'}, {url:'blob:https://www.instagram.com/current'}, false), /identify the current story/);
});

test('all stories and highlights use the reel owner for organizer filenames', async () => {
  const env = setup([{data:{reels_media:[{id:'highlight:12',user:{username:'example'},items:[photo('111'),photo('123')]}]}}]);
  const result = await env.api.resolve({highlightId:'12'}, {}, true);
  assert.equal(result.username, 'example');
  assert.equal(result.items.length, 2);
  assert.ok(env.calls[0].url.endsWith('reel_ids=highlight%3A12'));
});

for (const [status, data, expected] of [[429,{},/429/],[401,{message:'login_required'},/session/],[400,{message:'challenge_required'},/account check/]]) {
  test(`HTTP ${status} stops immediately without falling back or retrying`, async () => {
    const env = setup([{status,data}]);
    await assert.rejects(() => env.api.resolve({username:'example',mediaId:'123'}, {}, false), expected);
    assert.equal(env.calls.length, 1);
  });
}

test('different story owner is rejected', async () => {
  const env = setup([{data:{items:[photo('123','different')]}}]);
  await assert.rejects(() => env.api.resolve({username:'example',mediaId:'123'}, {}, false), /different story owner/);
});

test('routes support short usernames and highlights without matching unrelated pages', () => {
  const {api} = setup();
  assert.equal(api.route('/stories/ab/123/').username, 'ab');
  assert.equal(api.route('/stories/highlights/12/').highlightId, '12');
  assert.equal(api.route('/stories/example/').username, 'example');
  assert.equal(api.route('/p/example/'), null);
});

test('build disables legacy tray controller and includes standalone story assets', () => {
  const built = readFileSync(join(root,'extension/js/extension.js'),'utf8');
  assert.ok(!built.includes('Unable to download requested story'));
  const manifest = JSON.parse(readFileSync(join(root,'extension/manifest.json')));
  assert.ok(manifest.content_scripts[0].js.includes('js/stories.js'));
  assert.ok(manifest.content_scripts[0].css.includes('css/stories.css'));
});
