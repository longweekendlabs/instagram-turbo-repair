/* Inserted into the upstream bulk downloader class by build_local.py. */
static async downloadContent() {
  if (this.localBusy) return;
  this.localBusy = true;
  const controller=new AbortController();
  let progress, account, scanned = 0;
  try {
    const name = __turboLocalRepair.username();
    progress=new __lwlBulkProgress(name,()=>controller.abort());
    const headers = __turboLocalRepair.headers();
    this.localClient = await __turboLocalRepair.open(name, headers.appId, headers.wwwClaim,controller.signal);
    this.localFirstPage = await __turboLocalRepair.page(this.localClient);
    account = __turboLocalRepair.account(name, this.localFirstPage);
    const items = [], cursors = new Set;
    let cursor;
    do {
      controller.signal.throwIfAborted();
      if (location.pathname.split('/').filter(Boolean)[0]?.toLowerCase() !== name.toLowerCase()) {
        throw new Error('The open profile changed. Download stopped; return to the profile and start again.');
      }
      let count;
      [cursor, count] = await this.appendToItems(name, headers.appId, headers.wwwClaim, cursor, items);
      scanned += count;
      progress.update({phase:'scan',posts:scanned,files:items.length});
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error('Instagram repeated a pagination cursor. Stopped to avoid looping.');
        cursors.add(cursor);
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    } while (cursor !== undefined);
    if (!items.length) {
      progress.finish('stopped');
      await s.createAndAdd('Instagram returned no downloadable posts for this profile.', 'warn');
      return;
    }
    progress.update({phase:'download',completed:0,total:items.length});
    let summary={saved:0,skipped:0};
    await __lwlBrowserDownloads.download(items, account, (completed,total,stats)=>{summary=stats || {saved:completed,skipped:0};progress.update({phase:'download',completed,total,...summary});},
      {signal:controller.signal,requireProfileFolder:true});
    progress.finish('complete');
    await s.createAndAdd(`${summary.saved.toLocaleString()} files saved${summary.skipped?'; '+summary.skipped.toLocaleString()+' already on disk':''}. Use the browser's downloads to open the profile folder.`, 'default');
  } catch (error) {
    if(error.diagnostic && typeof chrome!=='undefined' && chrome.storage?.local){
      try{await chrome.storage.local.set({lastBatchDiagnostic:{version:chrome.runtime.getManifest().version,
        time:new Date().toISOString(),...error.diagnostic}});}catch{}
    }
    progress?.finish('stopped');
    if (error.name !== 'AbortError') {
      await s.createAndAdd(`Download All stopped: ${error.message}`, 'warn', true, null);
    }
  } finally {
    this.localFirstPage = undefined;
    this.localSeenMedia = undefined;
    this.localClient = undefined;
    this.localBusy = false;
  }
}
static async appendToItems(name, appId, wwwClaim, cursor, items) {
  const data = cursor === undefined && this.localFirstPage
    ? this.localFirstPage
    : await __turboLocalRepair.page(this.localClient, cursor);
  this.localFirstPage = undefined;
  this.localSeenMedia ||= new Set;
  for (const item of data.items) {
    for (const media of Je.getAllDownloadableMediaItems(item)) {
      media.owner_id=item.user?.pk || item.user?.id || item.owner?.pk || item.owner?.id ||
        (media.username?.toLowerCase()===name.toLowerCase()?this.localClient.id:undefined);
      media.taken_at ||= item.taken_at || 0;
      if (!media.url) throw new Error('A post has no downloadable media URL. This repair needs an update.');
      const key = String(media.pk || media.id || media.url);
      if (!this.localSeenMedia.has(key)) {
        this.localSeenMedia.add(key);
        items.push(media);
      }
    }
  }
  return [data.more_available ? String(data.next_max_id) : undefined, data.items.length];
}
