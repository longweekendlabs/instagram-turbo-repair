"""Check candidate source/build files without opening private Prod or local inputs."""
from pathlib import Path
import argparse
import re
import subprocess


def audit(root):
    paths = [root / name for name in ['build_local.py', '.gitignore', 'README.md', 'CHANGELOG.md']]
    for name in ['branding', 'patches', 'tests', 'tools', 'extension']:
        folder = root / name
        if folder.exists():
            paths.extend(p for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    patterns = {
        'personal home path': re.compile(r'/(?:home|Users)/[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\'),
        'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
        'credential-like token': re.compile(r'\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-live-[A-Za-z0-9]{20,})\b'),
    }
    email = re.compile(r'[A-Za-z0-9_.+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})')
    failures = []
    scanned = 0
    for path in sorted(set(paths)):
        if not path.exists():
            continue
        relative = path.relative_to(root)
        if path.is_symlink():
            failures.append((relative, 'symlink requires explicit review'))
            continue
        scanned += 1
        try:
            text = path.read_text()
        except UnicodeError:
            continue
        for label, pattern in patterns.items():
            if pattern.search(text):
                failures.append((relative, label))
        # Preserve required third-party copyright/licence notices, including their
        # public author contacts. Never treat them as this project's contact details.
        if not path.name.endswith('LICENSE.txt'):
            for match in email.finditer(text):
                if match.group(1) not in ['example.com', 'example.invalid', 'users.noreply.github.com']:
                    failures.append((relative, 'email/contact requires review'))
                    break
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--', 'Prod', '.local', '.env', '*.pem'], capture_output=True)
    if result.returncode == 0 and result.stdout:
        failures.append((Path('.git'), 'private/local files are tracked'))
    for path, reason in failures:
        print(f'FAIL {path}: {reason}')
    print(f'Privacy audit: {scanned} candidate files, {len(failures)} findings. Private Prod/local inputs excluded.')
    return not failures


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    raise SystemExit(0 if audit(parser.parse_args().root.resolve()) else 1)
