const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const root = join(__dirname, '..');
const built = readFileSync(join(root, 'extension/js/extension.js'), 'utf8');
const upstream = readFileSync(join(require('./fixture-paths.cjs').upstreamDir,'js/extension.js'), 'utf8');
const adapter = readFileSync(join(root, 'extension/js/local-bulk-api.js'), 'utf8');
const first = built.indexOf('static async downloadContent()');
const methods = built.slice(first, built.indexOf('createDownloadButton(){', first));
const parserStart = built.indexOf('static getBestMediaUrl');
const parser = built.slice(parserStart, built.indexOf('static getIgId', parserStart));

function response(data, status = 200, url = 'https://www.instagram.com/api/v1/feed/user/1234567891234567890/') {
  return {status, ok: status >= 200 && status < 300, url, json: async () => data};
}
function image(id) {
  return {id, pk: id, taken_at: 1000, user: {username: 'example'},
    image_versions2: {candidates: [{width: 100, height: 100, url: `https://cdn.example/${id}-small.jpg`},
      {width: 1200, height: 1600, url: `https://cdn.example/${id}.jpg`}]}};
}
function setup(responses = [], options = {}) {
  const calls = [], alerts = [], writes = [], progress = [];
  const directory = {requestPermission: async () => 'granted'};
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, AbortController, location: {pathname: '/example/'}, sessionStorage: {getItem: () => null},
    document: {cookie: 'unrelated=ignored; csrftoken=test-only-csrf'},
    fetch: async (url, options) => {
      calls.push({url, options});
      if (url === 'https://www.instagram.com/example/') return profileResponse;
      if (!responses.length) throw new Error('Unexpected request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    setTimeout: callback => {callback();},
    window: {showDirectoryPicker: async () => {calls.push('picker'); return directory;}},
    We: class {async getDownloadDirectoryHandle() {return undefined;} async setDownloadDirectoryHandle() {}},
    Ne: class {async updateProgress(item) {progress.push(item);}},
    __lwlBulkProgress:class{constructor(name,stop){context.stop=stop;}update(state){progress.push({...state,isLast:state.phase==='download' && state.completed===state.total});if(options.stopDuringScan && state.phase==='scan')context.stop();}finish(state){progress.push({...progress.at(-1),state,isLast:true});}},
    s: {createAndAdd: async (message, type) => {if (type === 'warn') alerts.push(message);}},
    __lwlBrowserDownloads: {download: async (items, account, onProgress,downloadOptions) => {
      writes.push({items, account,downloadOptions});
      for (let n = 1; n <= items.length; n++) await onProgress(n, items.length);
    }}
  });
  const profileResponse = options.profileResponse || {
    status: 200, ok: true, url: 'https://www.instagram.com/example/',
    text: async () => options.profileHtml ?? '<script>{"profile_id":"1234567891234567890"}</script>'
  };
  vm.runInContext(adapter, context);
  vm.runInContext(`globalThis.Je = class {${parser}}; globalThis.Bulk = class {${methods}}`, context);
  return {context, api: context.__turboLocalRepair, Bulk: context.Bulk, calls, alerts, writes, progress};
}

test('reproduces the upstream missing-claim crash and verifies the deployed fix', () => {
  function getter(source) {
    const start = source.indexOf('static getWwwClaim()');
    const end = source.indexOf('static getAppId()', start);
    const context = vm.createContext({sessionStorage: {getItem: () => null}, De: fn => fn({setExtra() {}})});
    return vm.runInContext(`(class {${source.slice(start, end)}}).getWwwClaim`, context);
  }
  assert.throws(() => getter(upstream)(), /length/);
  assert.equal(getter(built)(), null);
});

test('missing captured headers use initial claim without claiming the user is signed out', () => {
  const {api} = setup();
  const values = api.headers();
  assert.equal(values.wwwClaim, '0');
  assert.equal(values.appId, '936619743392459');
  assert.equal(api.username('/example/reels/'), 'example');
  assert.throws(() => api.username('/accounts/login/'), /profile/);
});

test('deployed bulk workflow uses browser downloads, reuses page one, and handles carousel/video', async () => {
  const video = {id: 'video', pk: 'video', taken_at: 1000,
    video_versions: [{width: 1080, height: 1920, url: 'https://cdn.example/video.mp4'}]};
  const carousel = {id: 'carousel', user: {username: 'example'}, carousel_media: [image('slide'), video]};
  const env = setup([
    response({items: [image('one'), carousel], user: {username: 'example', media_count: 3}, more_available: true, next_max_id: 'page 2&x'}),
    response({items: [image('one'), image('last')], more_available: false})
  ]);
  await env.Bulk.downloadContent();
  assert.ok(!env.calls.includes('picker'));
  assert.equal(env.calls.length, 3);
  assert.ok(!env.calls.some(call => call.url?.includes('web_profile_info')));
  assert.ok(!env.calls.some(call => call.url?.includes('/username/')));
  assert.equal(new URL(env.calls[1].url).pathname, '/api/v1/feed/user/1234567891234567890/');
  const second = new URL(env.calls[2].url);
  assert.equal(second.searchParams.get('max_id'), 'page 2&x');
  assert.equal(env.calls[1].options.credentials, 'same-origin');
  assert.equal(env.calls[1].options.headers['x-ig-www-claim'], '0');
  assert.equal(env.calls[1].options.headers['x-csrftoken'], 'test-only-csrf');
  assert.equal(env.alerts.length, 0);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].items.length, 4);
  assert.equal(env.writes[0].items[0].url, 'https://cdn.example/one.jpg');
  assert.equal(env.writes[0].items[2].url, 'https://cdn.example/video.mp4');
  assert.equal(env.progress.at(-1).completed, 4);
  assert.equal(env.progress.at(-1).isLast, true);
  assert.equal(env.Bulk.localBusy, false);
  assert.equal(env.writes[0].downloadOptions.requireProfileFolder,true);
  assert.equal(env.writes[0].items[0].owner_id,'1234567891234567890');
  assert.ok(env.progress.filter(state=>state.phase==='scan').every(state=>state.total===undefined));
  assert.equal(env.progress.find(state=>state.phase==='download').completed,0);
});

test('Stop during scanning prevents the next page and all file downloads',async()=>{
  const env=setup([response({items:[image('one')],more_available:true,next_max_id:'next'})],{stopDuringScan:true});
  await env.Bulk.downloadContent();
  assert.equal(env.calls.length,2);
  assert.equal(env.writes.length,0);
  assert.equal(env.alerts.length,0);
  assert.equal(env.progress.at(-1).state,'stopped');
  assert.equal(env.Bulk.localBusy,false);
});

test('Stop aborts an in-flight profile request without a failure warning',async()=>{
  const env=setup();
  let requestedSignal;
  env.context.fetch=async(url,options)=>new Promise((resolve,reject)=>{
    requestedSignal=options.signal;
    requestedSignal.addEventListener('abort',()=>reject(Object.assign(new Error('Stopped'),{name:'AbortError'})),{once:true});
  });
  const running=env.Bulk.downloadContent();
  env.context.stop();
  await running;
  assert.equal(requestedSignal.aborted,true);
  assert.equal(env.writes.length,0);
  assert.equal(env.alerts.length,0);
  assert.equal(env.Bulk.localBusy,false);
});

for (const [label, result, expected] of [
  ['rate limit', response({}, 429), /429/],
  ['expired login', response({message: 'login_required'}, 401), /session/],
  ['challenge', response({message: 'challenge_required'}, 400), /account check/],
  ['forbidden', response({}, 403), /403/],
  ['HTML 404 feed', {...response(null, 404), json: async () => {throw new Error('Must not parse this error page');}}, /numeric profile feed.*404/],
  ['login redirect', response({}, 200, 'https://www.instagram.com/accounts/login/'), /redirected/],
  ['changed response', response({data: {user: {}}}), /unsupported/],
  ['malformed cursor', response({items: [], more_available: true}), /cursor/],
  ['HTML response', {...response(null), json: async () => {throw new Error('HTML');}}, /non-JSON/],
  ['network failure', new Error('network failed'), /connection/],
  ['timeout', Object.assign(new Error('timeout'), {name: 'TimeoutError'}), /30 seconds/]
]) {
  test(`${label} produces a specific error, no retries and no downloads`, async () => {
    const env = setup([result]);
    await env.Bulk.downloadContent();
    assert.equal(env.alerts.length, 1);
    assert.match(env.alerts[0], expected);
    assert.equal(env.calls.length, 2);
    assert.equal(env.writes.length, 0);
    assert.equal(env.Bulk.localBusy, false);
  });
}

test('a later-page rate limit stops without writing an incomplete batch', async () => {
  const env = setup([
    response({items: [image('one')], more_available: true, next_max_id: 'next'}),
    response({}, 429)
  ]);
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /429/);
  assert.equal(env.writes.length, 0);
  assert.equal(env.progress.at(-1).isLast, true);
});

test('a pagination cycle cannot loop forever', async () => {
  const env = setup([
    response({items: [image('one')], more_available: true, next_max_id: 'A'}),
    response({items: [image('two')], more_available: true, next_max_id: 'B'}),
    response({items: [image('three')], more_available: true, next_max_id: 'A'})
  ]);
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /repeated/);
  assert.equal(env.calls.length, 4);
  assert.equal(env.writes.length, 0);
});

test('a remembered folder is ignored and no folder picker opens in browser mode', async () => {
  const env = setup([response({items: [image('one')], more_available: false})]);
  env.context.window.showDirectoryPicker = async () => {throw new Error('Picker must not open');};
  env.context.We = class {async getDownloadDirectoryHandle() {throw new Error('Legacy storage must not be read');}};
  await env.Bulk.downloadContent();
  assert.equal(env.calls.length, 2);
  assert.equal(env.writes.length, 1);
  assert.equal(env.alerts.length, 0);
});

test('a mismatched account fails before downloading media', async () => {
  const env = setup([response({items: [image('one')], user: {username: 'different'}})]);
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /different profile/);
  assert.equal(env.writes.length, 0);
});

test('empty accounts complete without a download writer call', async () => {
  const env = setup([response({items: [], more_available: false})]);
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /no downloadable posts/);
  assert.equal(env.writes.length, 0);
});

test('repair has distinct identity and no enabled analytics initializer', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json')));
  assert.equal(manifest.version, JSON.parse(readFileSync(join(root,'branding/app.json'))).version);
  assert.equal(manifest.name, 'LWL Instagram Downloader');
  assert.ok(manifest.permissions.includes('downloads'));
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.content_scripts[0].js[0], 'js/local-bulk-api.js');
  for (const file of ['extension.js', 'background.js', 'options.js']) {
    const source = readFileSync(join(root, 'extension/js', file), 'utf8');
    assert.ok(!source.includes('({dsn:"https://'));
    if (file === 'background.js') assert.ok(!source.includes('google-analytics'));
  }
});

test('profile ID parsing preserves numeric precision and handles escaped page data', () => {
  const {api} = setup();
  assert.equal(api.profileData('{"profile_id":1234567891234567890}', 'example').id, '1234567891234567890');
  assert.equal(api.profileData(String.raw`{\"profile_id\":\"1234567891234567890\"}`, 'example').id, '1234567891234567890');
  assert.equal(api.profileData('{"profile_id":"111","nested":{"profile_id":"222"}}', 'example').id, undefined);
});

test('missing page ID resolves through exact-name search rather than first search result', async () => {
  const env = setup([
    response({users: [{user: {username: 'someone-else', pk: '111'}}, {user: {username: 'Example', pk: '222'}}]}),
    response({items: [image('one')], more_available: false})
  ], {profileHtml: '<html>No numeric profile ID</html>'});
  await env.Bulk.downloadContent();
  assert.ok(env.calls[1].url.includes('/web/search/topsearch/'));
  assert.equal(new URL(env.calls[2].url).pathname, '/api/v1/feed/user/222/');
  assert.equal(env.writes.length, 1);
});

test('unmatched search result never downloads another profile', async () => {
  const env = setup([response({users: [{user: {username: 'other', pk: '111'}}]})], {profileHtml: '<html></html>'});
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /resolve this profile ID/);
  assert.equal(env.writes.length, 0);
});

test('profile-page 404 is reported directly without a misleading sign-in or JSON error', async () => {
  const env = setup([], {profileResponse: {...response(null, 404), url: 'https://www.instagram.com/example/'}});
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /profile page URL.*404/);
  assert.doesNotMatch(env.alerts[0], /non-JSON|Sign in/);
  assert.equal(env.calls.length, 1);
});

const tokenHtml = '<script>{"profile_id":"1234567891234567890",' +
  '"modules":[["LSD",[],{"token":"fixture-lsd"}],["DTSGInitialData",[],{"token":"fixture-dtsg"}]],"IG_USER_EIMU":"999"}</script>';
function queryPage(items, more = false, cursor = null) {
  return response({data: {xdt_api__v1__feed__user_timeline_graphql_connection: {
    edges: items.map(node => ({node})), page_info: {has_next_page: more, end_cursor: cursor}
  }}}, 200, 'https://www.instagram.com/api/graphql');
}

test('numeric feed 404 switches once to the current web query and keeps its pagination mode', async () => {
  const env = setup([
    {...response(null, 404), json: async () => {throw new Error('Do not parse 404 HTML');}},
    queryPage([image('one')], true, 'query-cursor'), queryPage([image('two')])
  ], {profileHtml: tokenHtml});
  await env.Bulk.downloadContent();
  assert.equal(env.alerts.length, 0);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].items.length, 2);
  assert.equal(env.calls.length, 4);
  assert.equal(env.calls[2].url, 'https://www.instagram.com/api/graphql');
  assert.equal(env.calls[2].options.method, 'POST');
  const form = new URLSearchParams(env.calls[2].options.body);
  assert.equal(form.get('doc_id'), '29104886249145907');
  assert.equal(form.get('lsd'), 'fixture-lsd');
  assert.equal(JSON.parse(form.get('variables')).username, 'example');
  const nextForm = new URLSearchParams(env.calls[3].options.body);
  assert.equal(JSON.parse(nextForm.get('variables')).after, 'query-cursor');
});

test('web query fallback never runs for rate limits', async () => {
  const env = setup([response({}, 429)], {profileHtml: tokenHtml});
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /429/);
  assert.equal(env.calls.length, 2);
});

test('a later REST page 404 never mixes REST and GraphQL cursors', async () => {
  const env = setup([
    response({items: [image('one')], more_available: true, next_max_id: 'rest-next'}), response({}, 404)
  ], {profileHtml: tokenHtml});
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /numeric profile feed.*404/);
  assert.equal(env.calls.length, 3);
  assert.ok(!env.calls.some(call => call.url?.includes('/api/graphql')));
  assert.equal(env.writes.length, 0);
});

test('unsupported web-query response is explicit and cannot look like an empty successful download', async () => {
  const env = setup([response({}, 404), response({errors: [{message: 'fixture error'}]})], {profileHtml: tokenHtml});
  await env.Bulk.downloadContent();
  assert.match(env.alerts[0], /profile query failed.*unrecognized response/);
  assert.equal(env.writes.length, 0);
});

test('batch workflow downloads a complete GraphQL page despite four unrelated query errors',async()=>{
  const node=image('one');node.owner=node.user;delete node.user;node.video_versions=[];
  const data={data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:[{node}],page_info:{has_next_page:false,end_cursor:null}}},
    errors:Array.from({length:4},()=>({severity:'CRITICAL',message:'Fixture presentation field error'}))};
  const env=setup([response({},404),response(data)],{profileHtml:tokenHtml});
  await env.Bulk.downloadContent();
  assert.equal(env.alerts.length,0);
  assert.equal(env.writes.length,1);
  assert.equal(env.writes[0].items[0].url,'https://cdn.example/one.jpg');
  assert.equal(env.writes[0].items[0].username,'example');
});
