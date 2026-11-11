"""Build, verify and update the private loaded copy, preserving its local folder root."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    prod = ROOT / 'Prod'
    if prod.is_symlink() or not prod.is_dir():
        raise SystemExit('An existing, non-symlink Prod directory is required.')
    private = prod / 'private-config.js'
    if private.exists():
        config = json.loads(private.read_text().split('=', 1)[1].strip().removesuffix(';'))
    else:
        previous = (prod / 'js/background.js').read_text()
        match = re.search(r'return `([^`$]+)/\$\{year\}', previous)
        if not match:
            raise SystemExit('Cannot identify the existing Prod folder root; refusing to replace it.')
        config = {'downloadRoot': match[1]}
    value = config.get('downloadRoot', '')
    if not value or value.startswith(('/', '\\')) or any(part in ['', '.', '..'] for part in value.replace('\\', '/').split('/')):
        raise SystemExit('Invalid private download root.')
    subprocess.run([sys.executable, 'build_local.py'], cwd=ROOT, check=True)
    subprocess.run(['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('*.test.cjs'))]], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    local = ROOT / '.local'
    local.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='prod-stage-', dir=local) as temporary:
        staged = Path(temporary) / 'Prod'
        shutil.copytree(ROOT / 'extension', staged)
        (staged / 'private-config.js').write_text('globalThis.__lwlPrivateConfig = '+json.dumps({'downloadRoot': value})+';\n')
        background = staged / 'js/background.js'
        background.write_text("importScripts('private-config.js');\n"+background.read_text())
        # importScripts resolves relative to the service worker's directory.
        background.write_text(background.read_text().replace("importScripts('private-config.js')", "importScripts('../private-config.js')"))
        options = staged / 'options.html'
        options.write_text(options.read_text().replace('<script src="settings.js">', '<script src="private-config.js"></script>\n  <script src="settings.js">'))
        for path in [background, staged / 'private-config.js']:
            subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)
        for source in (ROOT / 'extension').rglob('*'):
            if source.is_file() and str(source.relative_to(ROOT / 'extension')) not in ['js/background.js', 'options.html']:
                assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256((staged / source.relative_to(ROOT / 'extension')).read_bytes()).digest()
        backup = Path(tempfile.mkdtemp(prefix='prod-backup-', dir=local))
        backup.rmdir()
        os.replace(prod, backup)
        try:
            os.replace(staged, prod)
        except Exception:
            os.replace(backup, prod)
            raise
    print('Prod updated after build and tests; private folder root preserved. Previous copy retained in ignored local backup.')


if __name__ == '__main__':
    main()
