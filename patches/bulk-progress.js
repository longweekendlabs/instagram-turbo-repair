globalThis.__lwlBulkProgress=class{
  constructor(username,stop){
    document.getElementById('lwl-bulk-progress')?.remove();
    this.username=username;this.completed=0;this.total=0;this.saved=0;this.skipped=0;
    this.element=document.createElement('div');this.element.id='lwl-bulk-progress';this.element.setAttribute('role','status');
    this.label=document.createElement('div');this.label.className='lwl-bulk-label';
    this.bar=document.createElement('div');this.bar.className='lwl-bulk-bar';this.fill=document.createElement('div');this.bar.appendChild(this.fill);
    this.button=document.createElement('button');this.button.type='button';this.button.textContent='Stop';
    this.button.addEventListener('click',()=>{this.button.disabled=true;this.label.textContent='Stopping download…';stop();});
    this.element.append(this.label,this.bar,this.button);document.body.appendChild(this.element);
    this.update({phase:'scan',posts:0,files:0});
  }
  update(state){
    if(state.phase==='scan'){
      this.label.textContent=`Finding posts for ${this.username} · ${state.posts} posts / ${state.files} files found`;
      this.bar.classList.add('indeterminate');this.bar.removeAttribute('aria-valuenow');
    }else{
      this.completed=state.completed;this.total=state.total;
      this.saved=state.saved??state.completed;this.skipped=state.skipped || 0;
      const percent=state.total?Math.floor(state.completed/state.total*100):0;
      this.label.textContent=`${this.username} · ${state.completed}/${state.total} files (${percent}%) · ${this.saved} saved${this.skipped?' · '+this.skipped+' already on disk':''}`;
      this.bar.classList.remove('indeterminate');this.bar.setAttribute('role','progressbar');this.bar.setAttribute('aria-label','Files saved');
      this.bar.setAttribute('aria-valuemin','0');this.bar.setAttribute('aria-valuemax','100');this.bar.setAttribute('aria-valuenow',String(percent));
      this.fill.style.width=percent+'%';
    }
  }
  finish(state){
    this.bar.classList.remove('indeterminate');
    if(state!=='complete' && !this.total)this.fill.style.width='0%';
    this.label.textContent=state==='complete'?`${this.username} · ${this.saved} saved${this.skipped?' · '+this.skipped+' already on disk':''}.`:`Download stopped · ${this.saved} ${this.saved===1?'file':'files'} saved.`;
    this.button.disabled=false;this.button.textContent='Close';
    const close=this.button.cloneNode(true);this.button.replaceWith(close);this.button=close;close.addEventListener('click',()=>this.element.remove());
  }
};
