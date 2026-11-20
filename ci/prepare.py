"""Build the test tree from a pinned public release and this snapshot's code changes."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

BASE = 'b5a3c4631353ba0ab7171cfce5b0c60353223ea3'
ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.gitattributes', '.gitignore', '.npmignore', 'CHANGELOG.md', 'CONTRIBUTING.md',
              'LICENSE', 'README.md', 'README.ko.md', 'SECURITY.md', 'package.json'}
def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

def source_digest(product):
    total = hashlib.sha256()
    count = 0
    files = [product/'package.json']
    for prefix in ('skills', '.agents/skills', '.claude/skills'):
        files.append(product/prefix/'leerness/SKILL.md')
    for folder in ('bin','lib','scripts'):
        files.extend(p for p in (product/folder).rglob('*') if p.is_file())
    for p in sorted(files, key=lambda f:f.relative_to(product).as_posix()):
        name = p.relative_to(product).as_posix().encode('utf-8')
        total.update(name+b'\0'+hashlib.sha256(p.read_bytes()).digest())
        count += 1
    return {'files':count, 'sha256':total.hexdigest()}

def main(upstream, product):
    product.mkdir(parents=True,exist_ok=False)
    if git(upstream,'rev-parse',BASE+'^{commit}').decode().strip()!=BASE:
        raise RuntimeError('Public baseline mismatch')
    archive=git(upstream,'archive','--format=zip',BASE)
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        for entry in z.infolist():
            name=entry.filename
            if entry.is_dir() or name=='docs/PUBLISH_PRECHECK.md':
                continue
            if name not in ROOT_FILES and not name.startswith(('bin/','lib/','scripts/','docs/')) and name!='.github/workflows/ci.yml':
                continue
            file=product/name
            if not file.resolve().is_relative_to(product.resolve()): raise ValueError(name)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(z.read(entry))
            if entry.external_attr >> 16 & 0o111: file.chmod(0o755)
    # The removed baseline test marker need not be republished in the diff.
    baseline_cli = product/'bin/leerness.js'
    baseline_bytes = baseline_cli.read_bytes()
    if hashlib.sha256(baseline_bytes).hexdigest() != 'a197a9e7767b9f8ec15232a4f85165f3cc4c6b6c67b28b9715bca6b465125cfb':
        raise RuntimeError('Unexpected public CLI baseline')
    rows = baseline_bytes.splitlines(keepends=True)
    rows[11223] = b"    const oldKey = 'removed-test-marker';\n"
    baseline_cli.write_bytes(b''.join(rows))
    git(product,'init','--quiet','--initial-branch=main')
    git(product,'config','core.autocrlf','false')
    git(product,'apply','--unidiff-zero','--whitespace=nowarn',str(ROOT/'changes.patch'))
    git(product,'apply','--whitespace=error',str(ROOT/'ci/standalone-skill.patch'))
    shutil.copytree(ROOT/'source',product,dirs_exist_ok=True)
    actual=source_digest(product)
    expected=json.loads((ROOT/'ci/expected.json').read_text(encoding='utf-8'))
    if actual!=expected: raise RuntimeError(f'Unexpected product code digest {actual}')
    git(product,'add','-f','--all','--','.')
    git(product,'-c','user.name=Leerness CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Materialize tested public source')
    if git(product,'status','--porcelain').strip(): raise RuntimeError('Dirty test workspace')
    print(f"Verified {actual['files']} source and test files, SHA-256 {actual['sha256']}")
if __name__=='__main__':
    main(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve())
