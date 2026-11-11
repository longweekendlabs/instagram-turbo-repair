const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lwl-video-'));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
const source=fs.readFileSync(path.join(__dirname,'../extension/js/loaded-video.js'),'utf8');
function command(program,args){const result=spawnSync(program,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;}
command('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=64x64:rate=5','-t','1','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','empty_moov+frag_keyframe+default_base_moof',path.join(directory,'video.mp4')]);
command('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','1','-vn','-c:a','aac','-movflags','empty_moov+frag_keyframe+default_base_moof',path.join(directory,'audio.mp4')]);
const video=new Uint8Array(fs.readFileSync(path.join(directory,'video.mp4'))),audio=new Uint8Array(fs.readFileSync(path.join(directory,'audio.mp4')));
function setup(pathname='/stories/highlights/12/'){
  let serial=0;
  class LocalURL extends URL{static createObjectURL(){return 'blob:https://www.instagram.com/fixture-'+(++serial);}}
  class MediaSource{constructor(){this.readyState='open';}addSourceBuffer(){return {updating:false,appendBuffer(data){if(data===null)throw new Error('native append failure');return 'native-result';}};}}
  const location={pathname};
  const context=vm.createContext({URL:LocalURL,MediaSource,Blob,ArrayBuffer,Uint8Array,DataView,Date,setTimeout,location,fetch:async()=>{throw new Error('Do not fetch a MediaSource blob');}});
  vm.runInContext(source,context);return {api:context.__lwlLoadedVideo,MediaSource,LocalURL,location};
}
async function checkMovie(blob,name){
  const file=path.join(directory,name);fs.writeFileSync(file,new Uint8Array(await blob.arrayBuffer()));
  const probe=JSON.parse(command('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
  command('ffmpeg',['-v','error','-i',file,'-f','null','-']);return probe;
}
test('separate captured MP4 video/audio buffers become one decodable movie with both tracks',async()=>{
  const env=setup(),blob=env.api.merge([video,audio]);
  const result=await checkMovie(blob,'merged.mp4');
  assert.equal(result.streams.filter(s=>s.codec_type==='video').length,1);
  assert.equal(result.streams.filter(s=>s.codec_type==='audio').length,1);
  assert.ok(Number(result.format.duration)>=1);
});
test('the exact MediaSource blob is recovered with no metadata or blob fetch',async()=>{
  const env=setup(),media=new env.MediaSource(),url=env.LocalURL.createObjectURL(media);
  const v=media.addSourceBuffer('video/mp4'),a=media.addSourceBuffer('audio/mp4');
  assert.equal(v.appendBuffer(video),'native-result');a.appendBuffer(audio);
  assert.throws(()=>v.appendBuffer(null),/native append failure/);
  media.readyState='ended';
  const element={currentSrc:url,duration:1,buffered:{length:1,start:()=>0,end:()=>1}};
  const blob=await env.api.capture(url,element),result=await checkMovie(blob,'captured.mp4');
  assert.equal(result.streams.length,2);
});
test('append captures its own byte copy, not later-mutated caller buffers',async()=>{
  const env=setup(),media=new env.MediaSource(),url=env.LocalURL.createObjectURL(media),v=media.addSourceBuffer('video/mp4');
  const copy=video.slice();v.appendBuffer(copy);copy.fill(0);media.readyState='ended';
  const blob=await env.api.capture(url,{currentSrc:url,duration:1,buffered:{length:1,start:()=>0,end:()=>1}});
  assert.equal((await checkMovie(blob,'copy.mp4')).streams[0].codec_type,'video');
});
test('truncated streams and unsupported absolute offsets are refused',()=>{
  const env=setup();assert.throws(()=>env.api.merge([video.slice(0,25)]),/Incomplete/);
  const altered=video.slice(),index=Buffer.from(altered).indexOf(Buffer.from('tfhd'));
  assert.ok(index>=0);altered[index+7]|=1;
  assert.throws(()=>env.api.merge([altered]),/absolute offsets/);
});
test('a complete ordinary MP4 Blob is preserved byte for byte',async()=>{
  const env=setup(),original=new Blob([video],{type:'video/mp4'}),url=env.LocalURL.createObjectURL(original);
  assert.deepEqual(new Uint8Array(await (await env.api.capture(url,{})).arrayBuffer()),video);
});
test('profile and post playback are untracked and opening a story enables capture in the same page',()=>{
  const env=setup('/example/');
  for(const pathname of ['/example/','/p/example/','/reel/example/']){
    env.location.pathname=pathname;
    const media=new env.MediaSource(),url=env.LocalURL.createObjectURL(media);
    assert.equal(media.addSourceBuffer('video/mp4').appendBuffer(video),'native-result');
    assert.equal(env.api.state(url).captureMapped,false);
  }
  env.location.pathname='/stories/highlights/12/';
  const media=new env.MediaSource(),url=env.LocalURL.createObjectURL(media);
  media.addSourceBuffer('video/mp4').appendBuffer(video);
  assert.equal(env.api.state(url).captureBuffers,1);
});
