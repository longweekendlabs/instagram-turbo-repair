const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const {webcrypto}=require('node:crypto');
const root = join(__dirname, '..');
const adapter = readFileSync(join(root, 'extension/js/browser-downloads.js'), 'utf8');
const worker = readFileSync(join(root, 'extension/js/background.js'), 'utf8');

function harness({interrupt = false, mediaError = false, startError = false,missingFolder=false,wrongName=false,controller,uniquify=false} = {}) {
  let listener;
  const initiated = [], revoked = [], events = [], states = [];
  let statusCalls = 0;
  const sender = {id: 'our-addon', url: 'https://www.instagram.com/example/',tab:{id:12}};
  const session={};let objectURLs=0;
  const chrome = {
    runtime: {id: 'our-addon', onMessage: {addListener(fn) {listener = fn;}},
      sendMessage(message) {return new Promise(resolve => listener(message, sender, resolve));}},
    action: {onClicked: {addListener() {}}},
    storage:{local:{async get(){return {folderMode:'organizer'};}},session:{async get(key){return {[key]:session[key]};},async set(values){if(startError)throw new Error('Missing storage permission');Object.assign(session,values);},async remove(key){delete session[key];}}},
    downloads: {
      onDeterminingFilename:{addListener(){}},
      async download(){throw new Error('Must use native filename handoff');},
      async cancel(id){events.push('cancel');},
      async search({id,urlRegex}) {
        statusCalls++;
        const state = interrupt ? 'interrupted' : controller ? 'in_progress' : statusCalls % 2 ? 'in_progress' : 'complete';
        states.push(state);
        const index=id===undefined?initiated.length-1:id-1,item=initiated[index];
        if(!item || (urlRegex && !new RegExp(urlRegex).test(item.url.split('#')[0])))return [];
        if(controller && state==='in_progress')controller.abort();
        return [{id:index+1,state,filename:'/Downloads/date/'+(missingFolder?'':'example/')+(wrongName?'fixture-uuid.jpg':uniquify?item.filename.replace(/(\.[^.]+)$/,' (1)$1'):item.filename),error: interrupt ? 'USER_CANCELED' : undefined}];
      }
    }
  };
  const background = vm.createContext({chrome, URL,crypto:webcrypto});
  vm.runInContext(worker, background);
  class LocalURL extends URL {
    static createObjectURL() {events.push('blob'); return 'blob:https://www.instagram.com/fixture-uuid-'+(++objectURLs);}
    static revokeObjectURL(value) {revoked.push(value); events.push('revoke');}
  }
  const content = vm.createContext({chrome, URL: LocalURL,
    document:{body:{appendChild(){}},createElement(){return {style:{},addEventListener(){},remove(){},click(){initiated.push({url:this.href,filename:this.download});events.push('start');}};}},
    fetch: async () => ({ok: !mediaError, status: mediaError ? 403 : 200, blob: async () => ({size: 123})}),
    setTimeout: callback => callback()
  });
  vm.runInContext(adapter, content);
  return {api: content.__lwlBrowserDownloads, initiated, revoked, states, events, listener, sender};
}

const media = {url: 'https://scontent.example.fbcdn.net/a/photo.jpg?signature=unchanged', username: 'example', id: '123', taken_at: 1000};

test('browser queue includes organizer metadata, waits for completion, then releases each blob', async () => {
  const env = harness();
  const progress = [];
  const count = await env.api.download([media, {...media, id: '124'}], {username: 'example'}, (...values) => progress.push(values));
  assert.equal(count, 2);
  assert.equal(env.initiated[0].filename, 'example_1000_123.jpg');
  assert.equal(env.initiated[0].url, 'blob:https://www.instagram.com/fixture-uuid-1#lwl-instagram/example/example_1000_123.jpg');
  assert.deepEqual(env.states, ['in_progress', 'complete', 'in_progress', 'complete']);
  assert.deepEqual(env.events, ['blob', 'start', 'revoke', 'blob', 'start', 'revoke']);
  assert.equal(env.revoked.length, 2);
  assert.equal(progress.at(-1)[0], 2);
});

test('interrupted downloads stop the queue and release the blob without reporting success', async () => {
  const env = harness({interrupt: true});
  await assert.rejects(() => env.api.download([media, {...media, id:'124'}], {username:'example'}, () => {}), /USER_CANCELED/);
  assert.equal(env.initiated.length, 1);
  assert.equal(env.revoked.length, 1);
});

test('failed media response is not saved as an image', async () => {
  const env = harness({mediaError: true});
  await assert.rejects(() => env.api.download([media], {username:'example'}, () => {}), /403/);
  assert.equal(env.initiated.length, 0);
});

test('missing browser permission is surfaced and still releases the blob', async () => {
  const env = harness({startError: true});
  await assert.rejects(() => env.api.download([media], {username:'example'}, () => {}), /permission/);
  assert.equal(env.revoked.length, 1);
});

test('download worker rejects another origin and unsafe paths', async () => {
  const env = harness();
  const ask = (message, sender) => new Promise(resolve => env.listener(message, sender, resolve));
  let result = await ask({type:'lwlDownload', url:'blob:https://www.instagram.com/a#lwl-instagram/example/test.jpg', filename:'example/test.jpg'}, {id:'our-addon',url:'https://unrelated.example/'});
  assert.equal(result.ok, false);
  result = await ask({type:'lwlDownload', url:'blob:https://www.instagram.com/a#lwl-instagram/../test.jpg', filename:'../test.jpg'}, env.sender);
  assert.equal(result.ok, false);
  assert.equal(env.initiated.length, 0);
});

test('missing profile routing stops after the first saved file',async()=>{
  const env=harness({missingFolder:true});
  await assert.rejects(()=>env.api.download([media,{...media,id:'124'}],{username:'example'},()=>{},
    {requireProfileFolder:true}),error=>error.diagnostic?.kind==='download-routing' && error.diagnostic.filenameMatched && !error.diagnostic.profileFolderMatched);
  assert.equal(env.initiated.length,1);
  assert.equal(env.revoked.length,1);
});

test('a UUID filename stops the queue even if the folder is correct',async()=>{
  const env=harness({wrongName:true});
  await assert.rejects(()=>env.api.download([media,media],{username:'example'},()=>{},
    {requireProfileFolder:true}),/did not match the requested destination/);
  assert.equal(env.initiated.length,1);
});

test('Stop cancels the current native download and never starts the next file',async()=>{
  const controller=new AbortController(),env=harness({controller});
  await assert.rejects(()=>env.api.download([media,media],{username:'example'},()=>{},
    {signal:controller.signal}),{name:'AbortError'});
  assert.equal(env.initiated.length,1);
  assert.ok(env.events.includes('cancel'));
  assert.equal(env.revoked.length,1);
});

test('Organizer Uniquify suffixes are valid completed filenames',async()=>{
  const env=harness({uniquify:true});
  assert.equal(await env.api.download([media],{username:'example'},()=>{},{requireProfileFolder:true}),1);
});

test('filename preserves media owner, timestamp and composite ID like single-post downloads',()=>{
  const env=harness();
  const photo={...media,username:'sample_creator',taken_at:1700000000,id:'1234567890123456789',owner_id:'987654321'};
  assert.equal(env.api.fileName(photo),'sample_creator_1700000000_1234567890123456789_987654321.jpg');
  assert.equal(env.api.fileName({...photo,id:'1234567890123456789_987654321'}),env.api.fileName(photo));
});

test('screenshot date/profile rule works with the installed RegExp Organizer handler', async () => {
  const installed = require('./fixture-paths.cjs').organizerDir;
  let handler;
  const fields = new Map(['matcher','destination','preview','version'].map(id => [id, {}]));
  const ruleContext = vm.createContext({Date, document: {getElementById: id => fields.get(id), querySelectorAll: () => []}});
  vm.runInContext(readFileSync(join(root, 'extension/settings.js'), 'utf8'), ruleContext);
  const momentContext = vm.createContext({console});
  vm.runInContext(readFileSync(join(installed, 'js/moment-es.js'), 'utf8').replace('export default hooks;', 'globalThis.moment = hooks;'), momentContext);
  const rulesets = [{enabled:true, url: fields.get('matcher').value, pattern: fields.get('destination').value,
    'conflict-action':'uniquify'}, {enabled:true, url:'instagram', pattern:'wrong-generic-rule/'}];
  const chrome = {
    permissions: {contains: async () => false},
    downloads: {onDeterminingFilename: {addListener(fn) {handler = fn;}}},
    storage: {local: {get(keys, callback) {callback({rulesets});}}}
  };
  const context = vm.createContext({chrome, moment: momentContext.moment, console: {log(){},warn(){},error(){},debug(){}}});
  let manager = readFileSync(join(installed, 'manager.js'), 'utf8').replace("import moment from './js/moment-es.js';", '');
  manager = manager.slice(0, manager.lastIndexOf("chrome.storage.local.get(['version', 'showChangelog'])"));
  vm.runInContext(manager, context);
  const env = harness();
  await env.api.download([media], {username:'example'}, () => {});
  const item = env.initiated[0];
  // Use the blob's tentative UUID filename, not downloads.download's proposed filename.
  const suggestion = await new Promise(resolve => handler({url:item.url, finalUrl:item.url,
    filename:'fixture-uuid.jpg', mime:'image/jpeg', referrer:'', startTime:'2026-11-01T12:00:00+01:00'}, resolve));
  assert.equal(suggestion.filename, 'Instagram/2026, November/2026.11.01 - IG/example/example_1000_123.jpg');
  assert.equal(suggestion.conflictAction, 'uniquify');
});
