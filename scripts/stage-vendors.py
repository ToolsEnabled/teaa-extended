#!/usr/bin/env python3
"""Retired two-component stager. TEAA uses stage-components.py."""
raise SystemExit('Use python3 scripts/stage-components.py from the candidate root lock. This stager pinned Fleet V2 and ToolsEngine 0.1.9 only.')
"""Verify pinned archives and stage their unchanged runtime bytes for both TEAA builds."""
import argparse, hashlib, json, stat, tarfile, zipfile
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument('--fleet-dir', type=Path, required=True)
parser.add_argument('--engine-dir', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
lock = json.loads((Path(__file__).resolve().parents[1] / 'vendor-lock.json').read_text())

def write(root, name, data, mode):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name:
        raise ValueError('Unsafe archive name')
    dest = root.joinpath(*p.parts)
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if dest.exists() and dest.read_bytes() != data:
        raise ValueError('Staging destination differs: ' + str(dest))
    dest.write_bytes(data)
    dest.chmod(0o755 if mode & 0o111 else 0o644)
    return {'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

for platform in ('linux', 'win32'):
    vendor = args.out / platform / 'vendor'
    receipt = {'schemaVersion': 1, 'platform': platform, 'arch': 'x64', 'components': {}}
    for component, folder in [('fleet', args.fleet_dir), ('toolsengine', args.engine_dir)]:
        rec = lock[component][platform]
        archive = folder / rec['file']
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != rec['sha256']:
            raise ValueError('Pinned archive SHA256 mismatch: ' + str(archive))
        rows = []
        root = vendor / component
        def accept(name, data, mode):
            if name.startswith(rec['prefix']):
                rows.append(write(root, name[len(rec['prefix']):], data, mode))
            elif component == 'toolsengine' and name.endswith('/THIRD-PARTY-NOTICES.txt'):
                rows.append(write(root, 'THIRD-PARTY-NOTICES.txt', data, mode))
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as z:
                for item in z.infolist():
                    if item.is_dir(): continue
                    mode = item.external_attr >> 16
                    if stat.S_ISLNK(mode): raise ValueError('Archive link refused')
                    accept(item.filename, z.read(item), mode)
        else:
            with tarfile.open(archive) as t:
                for item in t:
                    if item.isdir(): continue
                    if not item.isfile(): raise ValueError('Archive non-file refused')
                    accept(item.name, t.extractfile(item).read(), item.mode)
        rows = sorted({r['path']: r for r in rows}.values(), key=lambda r: r['path'])
        if not rows or not (root / 'package.json').is_file(): raise ValueError('Missing runtime')
        receipt['components'][component] = {'version': lock[component]['version'], 'source': lock[component]['source'], 'archive': archive.name, 'archiveSha256': actual, 'files': rows}
        print(platform, component, len(rows), 'verified files')
    (vendor / 'manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
