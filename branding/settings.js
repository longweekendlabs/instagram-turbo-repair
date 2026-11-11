const matcher = '^blob:https://www\\.instagram\\.com/[^#]+#lwl-instagram/([^/]+)/([^/]+)$';
const downloadRoot=globalThis.__lwlPrivateConfig?.downloadRoot || 'Instagram';
const destination = downloadRoot+'/${date:YYYY, MMMM}/${date:YYYY.MM.DD} - IG/${url:1}/${url:2}';
document.getElementById('matcher').value = matcher;
document.getElementById('destination').value = destination;
const date = new Date();
const month = date.toLocaleString('en-US', {month:'long'});
const day = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('.');
document.getElementById('preview').textContent = `${downloadRoot}/${date.getFullYear()}, ${month}/${day} - IG/profile_name/profile_name_…jpg`;
document.getElementById('version').textContent = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
  ? `Version ${chrome.runtime.getManifest().version}` : 'Local build preview';
if(typeof chrome!=='undefined' && chrome.storage?.local && document.getElementById('failure-details')){
  chrome.storage.local.get(['lastBatchDiagnostic','lastStoryDiagnostic']).then(values=>{
    const lastBatchDiagnostic=[values.lastBatchDiagnostic,values.lastStoryDiagnostic].filter(Boolean).sort((a,b)=>String(b.time || '').localeCompare(String(a.time || '')))[0];
    if(lastBatchDiagnostic){document.getElementById('failure-details').value=JSON.stringify(lastBatchDiagnostic,null,2);document.getElementById('failure-section').hidden=false;}
  }).catch(()=>{});
}
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  const field = document.getElementById(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(field.value);
    document.getElementById('status').textContent = 'Copied.';
  } catch {
    field.focus(); field.select();
    document.getElementById('status').textContent = 'Text selected. Press Ctrl+C to copy.';
  }
});

const modeSelect=document.getElementById('folder-mode');
function showMode(mode){
  if(!modeSelect)return;
  modeSelect.value=mode;
  document.getElementById('organizer-rule').hidden=mode!=='organizer';
  document.getElementById('mode-status').textContent=mode==='organizer'?'Organizer mode requires the profile rule below.':'Automatic folders are enabled. No Organizer rule setup is needed.';
}
if(modeSelect){
  showMode('builtin');
  if(typeof chrome!=='undefined' && chrome.storage?.local){
    chrome.storage.local.get('folderMode').then(result=>showMode(result.folderMode==='organizer'?'organizer':'builtin')).catch(()=>{});
    modeSelect.addEventListener('change',async()=>{
      const mode=modeSelect.value==='organizer'?'organizer':'builtin';
      try{await chrome.storage.local.set({folderMode:mode});showMode(mode);}
      catch{document.getElementById('mode-status').textContent='Could not save the folder setting. Reload this page and try again.';}
    });
  }
}
const quietSetting=document.getElementById('quiet-downloads'),clearCache=document.getElementById('clear-cache');
if(typeof chrome!=='undefined' && chrome.storage?.local && quietSetting){
  chrome.storage.local.get('quietDownloads').then(values=>{quietSetting.checked=values.quietDownloads!==false;}).catch(()=>{});
  quietSetting.addEventListener('change',async()=>{
    try{await chrome.storage.local.set({quietDownloads:quietSetting.checked});}
    catch{quietSetting.checked=!quietSetting.checked;document.getElementById('mode-status').textContent='Could not save the quiet download setting.';}
  });
}
if(clearCache)clearCache.addEventListener('click',async()=>{
  clearCache.disabled=true;
  const status=document.getElementById('cache-status');
  try{
    const result=await chrome.runtime.sendMessage({type:'lwlClearCache'});
    if(!result?.ok)throw new Error(result?.error || 'Could not clear the cache.');
    status.textContent='Download cache cleared. Your downloaded files are unchanged.';
  }catch(error){status.textContent=error.message;}
  finally{clearCache.disabled=false;}
});
