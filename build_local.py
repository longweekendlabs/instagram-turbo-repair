"""Build a private unpacked repair from the installed Turbo extension. No profile mutations."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import os

ROOT = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get('LWL_UPSTREAM_DIR', ROOT / '.local/upstream'))
OUTPUT = ROOT / 'extension'
APP = json.loads((ROOT / 'branding/app.json').read_text())


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one patch target: {old[:70]}')
    return text.replace(old, new, 1)


def main():
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    if manifest['version'] != '4.12.16':
        raise RuntimeError('Only the inspected upstream version is supported')
    source = (SOURCE / 'js/extension.js').read_text()
    start = source.index('static downloadContent(){', source.index('let et=Ze=class extends p{'))
    end = source.index('createDownloadButton(){', start)
    methods = (ROOT / 'patches/bulk-methods.js').read_text()
    source = source[:start] + methods + source[end:]
    # Route legacy individual-post and carousel buttons through the same verified
    # destination handler. Their native anchor path bypassed automatic folder routing.
    start = source.index('function Ie(e){')
    end = source.index('const Le=', start)
    source = source[:start] + '''async function Ie(item){if(!item.id && !item.pk)item={...item,id:"profile"};try{await __lwlBrowserDownloads.download([item],{username:item.username},()=>{});}catch(error){await s.createAndAdd(error.message,"warn");}}''' + source[end:]
    start = source.index('function Oe(', source.index('async function Ie(item)'))
    end = source.index('function Me(e)', start)
    source = source[:start] + '''async function Oe(items,account){if(!items.length)return;try{await __lwlBrowserDownloads.download(items,{username:account?.username || items[0].username},()=>{});}catch(error){await s.createAndAdd(error.message,"warn");}}''' + source[end:]
    # Replace only the legacy story controller. The independent controller below follows SPA
    # navigation itself, without the tray map, private require() modules, or header selectors.
    story_start = source.index('let gt=class extends p{')
    story_end = source.index('gt=e([w],gt);', story_start)
    source = source[:story_start] + 'let gt=class{init(){}remove(){}};' + source[story_end:]
    # Independent upstream bug: missing session claim must not dereference null.length.
    source = replace_once(source, 'setExtra("hasNonZeroWwwClaim",e.length>1)',
                          'setExtra("hasNonZeroWwwClaim",!!e&&e.length>1)')
    source = source.replace('({dsn:"https://', '({enabled:!1,dsn:"https://')
    source = source.replace('Turbo Downloader has been updated.', 'LWL Instagram Downloader has been updated.')
    source = replace_once(source, 'r.onclick=()=>t(this,void 0,void 0,(function*(){r.classList.add("loading");try{yield Ze.downloadContent()}',
                          'r.onclick=()=>t(this,void 0,void 0,(function*(){if(Ze.localBusy)return;r.classList.add("loading");try{yield Ze.downloadContent()}')

    # Copy package assets only, never local extension storage or cookies.
    # Clean only this generated output. Never traverse or update the loaded Prod copy.
    if OUTPUT.is_symlink():
        raise RuntimeError('Build output must not be a symlink')
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir()
    # Explicit package assets only; never copy arbitrary browser/package side files.
    assets = ['css/extension.css', 'css/options.css', 'js/inject.js',
              'js/options_listener_inject.js', 'js/options.js',
              'js/options.js.LICENSE.txt', 'js/extension.js.LICENSE.txt',
              'js/background.js.LICENSE.txt', 'icons/igdl2-128.png',
              'icons/close_black_24dp.svg', 'icons/download_all_white.svg',
              'icons/download_black.svg', 'icons/download_white.svg',
              'icons/download_all_black.svg']
    for name in assets:
        target = OUTPUT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / name, target)
    (OUTPUT / 'js/extension.js').write_text(source)
    inject_path = OUTPUT / 'js/inject.js'
    inject = inject_path.read_text()
    start = inject.index('const o={attributes:!0,childList:!0,subtree:!0},a=new MutationObserver')
    end = inject.index(';!function e(){try{const e=document.querySelector("body")', start)
    observer = (ROOT / 'patches/post-observer.js').read_text()
    inject = inject[:start] + observer + inject[end:]
    start = inject.index('function s(e){let n=e.querySelectorAll(')
    end = inject.index('!function e(){try{sessionStorage.setItem', start)
    scan = inject[start:end].replace('e.setAttribute("__igdl_id",n)', 'writePostId(e,n)')
    write_id = '''function writePostId(element,id){
      if(element.getAttribute("__igdl_id")!==String(id))element.setAttribute("__igdl_id",id);
    }'''
    inject_path.write_text(inject[:start] + write_id + scan + inject[end:])
    shutil.copy2(ROOT / 'patches/bulk-api.js', OUTPUT / 'js/local-bulk-api.js')
    shutil.copy2(ROOT / 'patches/browser-downloads.js', OUTPUT / 'js/browser-downloads.js')
    shutil.copy2(ROOT / 'patches/bulk-progress.js', OUTPUT / 'js/bulk-progress.js')
    shutil.copy2(ROOT / 'patches/bulk-progress.css', OUTPUT / 'css/bulk-progress.css')
    shutil.copy2(ROOT / 'patches/background.js', OUTPUT / 'js/background.js')
    shutil.copy2(ROOT / 'patches/offscreen.js', OUTPUT / 'js/offscreen.js')
    shutil.copy2(ROOT / 'patches/media-cache.js', OUTPUT / 'js/media-cache.js')
    shutil.copy2(ROOT / 'patches/offscreen.html', OUTPUT / 'offscreen.html')
    shutil.copy2(ROOT / 'patches/lwl-notifications.css', OUTPUT / 'css/lwl-notifications.css')
    shutil.copy2(ROOT / 'patches/stories.js', OUTPUT / 'js/stories.js')
    shutil.copy2(ROOT / 'patches/story-page.js', OUTPUT / 'js/story-page.js')
    shutil.copy2(ROOT / 'patches/loaded-video.js', OUTPUT / 'js/loaded-video.js')
    shutil.copy2(ROOT / 'patches/profile-page.js', OUTPUT / 'js/profile-page.js')
    shutil.copy2(ROOT / 'patches/stories.css', OUTPUT / 'css/stories.css')
    shutil.copy2(SOURCE / 'options.html', OUTPUT / 'legacy-options.html')
    for name in ['settings.html', 'settings.css', 'settings.js']:
        target = 'options.html' if name == 'settings.html' else name
        shutil.copy2(ROOT / 'branding' / name, OUTPUT / target)
    shutil.copy2(ROOT / 'branding/mark.svg', OUTPUT / 'icons/lwl-mark.svg')
    for size in [16, 32, 48, 128, 512]:
        subprocess.run(['convert', '-background', 'none', str(ROOT / 'branding/mark.svg'),
                        '-resize', f'{size}x{size}', str(OUTPUT / f'icons/lwl-{size}.png')], check=True, capture_output=True)
    shutil.copy2(OUTPUT / 'icons/lwl-512.png', OUTPUT / 'icons/igdl2.png')
    for path in (OUTPUT / 'js').glob('*.js'):
        text = path.read_text().replace('({dsn:"https://', '({enabled:!1,dsn:"https://')
        text = re.sub(r'dsn:"https://[^"\s]+"', 'dsn:""', text)
        path.write_text(re.sub(r'\n?//# sourceMappingURL=.*', '', text))
    manifest.pop('key', None)
    manifest.pop('update_url', None)
    manifest['name'] = APP['name']
    manifest['description'] = APP['tagline']
    manifest['version'] = APP['version']
    manifest['permissions'] = ['storage', 'downloads', 'downloads.ui', 'offscreen']
    manifest['minimum_chrome_version'] = '116'
    for resource in manifest['web_accessible_resources']:
        resource['matches'] = ['*://*.instagram.com/*']
    manifest['icons'] = {str(size): f'icons/lwl-{size}.png' for size in [16, 32, 48, 128]}
    manifest['action'] = {'default_title': APP['name'] + ' settings'}
    manifest['content_scripts'][0]['js'].insert(0, 'js/local-bulk-api.js')
    manifest['content_scripts'][0]['js'].insert(1, 'js/browser-downloads.js')
    manifest['content_scripts'][0]['js'].insert(2, 'js/stories.js')
    manifest['content_scripts'][0]['js'].insert(3, 'js/bulk-progress.js')
    manifest['content_scripts'][0]['css'].append('css/stories.css')
    manifest['content_scripts'][0]['css'].append('css/bulk-progress.css')
    manifest['content_scripts'][0]['css'].append('css/lwl-notifications.css')
    main_world = next(entry for entry in manifest['content_scripts'] if entry.get('world') == 'MAIN')
    main_world['js'].insert(0,'js/story-page.js')
    main_world['js'].insert(0,'js/loaded-video.js')
    main_world['js'].insert(0,'js/profile-page.js')
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for path in (OUTPUT / 'js').glob('*.js'):
        subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)
    subprocess.run(['node', '--check', str(OUTPUT / 'settings.js')], check=True, capture_output=True)
    for entry in manifest['content_scripts']:
        for path in entry.get('js', []) + entry.get('css', []):
            assert (OUTPUT / path).is_file(), path
    assert (OUTPUT / manifest['background']['service_worker']).is_file()
    assert 'web_profile_info' not in (OUTPUT / 'js/extension.js').read_text()
    subprocess.run(['python3', str(ROOT / 'tools/privacy_audit.py')], check=True)
    print(f'Built {manifest["name"]} {manifest["version"]}')
    print(f'Load unpacked: {OUTPUT}')
    print('Source extension.js SHA256:', hashlib.sha256((SOURCE / 'js/extension.js').read_bytes()).hexdigest())
    print('Manifest references and all JavaScript syntax checks passed.')


if __name__ == '__main__':
    main()
