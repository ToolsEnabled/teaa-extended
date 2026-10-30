#!/usr/bin/env python3
"""Stage frozen Fleet, ToolsEngine and Knowledge bytes into source/vendor.

Reads components.lock.json from the candidate root (the parent of source/).
Extracts only inside this candidate. Does not modify the input trees.
Refuses symbolic links. Rewrite vendor/manifest.json from the staged files.
"""
import hashlib, json, os, shutil, stat, sys, zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
ROOT = SOURCE.parent
LOCK_PATH = ROOT / 'components.lock.json'
VENDOR = SOURCE / 'vendor'
INPUTS = ROOT / 'inputs'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def refuse_link(path):
    if path.is_symlink():
        raise SystemExit(f'Refusing symbolic link: {path}')


def copy_tree(src, dest):
    if dest.exists():
        shutil.rmtree(dest)
    def ignore_walk():
        pass
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        current = Path(dirpath)
        refuse_link(current)
        rel = current.relative_to(src)
        target = dest / rel
        target.mkdir(parents=True, exist_ok=True)
        dirnames[:] = sorted(name for name in dirnames if name != '__pycache__')
        for name in dirnames:
            refuse_link(current / name)
        for name in filenames:
            if name.endswith('.pyc'):
                continue
            origin = current / name
            refuse_link(origin)
            if not origin.is_file():
                raise SystemExit(f'Refusing special file: {origin}')
            shutil.copy2(origin, target / name, follow_symlinks=False)
    ignore_walk()


def file_rows(root):
    rows = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        refuse_link(current)
        dirnames[:] = sorted(name for name in dirnames if name != '__pycache__')
        for name in sorted(filenames):
            if name.endswith('.pyc'):
                continue
            path = current / name
            refuse_link(path)
            if not path.is_file():
                raise SystemExit(f'Refusing special file: {path}')
            data_hash = sha256(path)
            rel = path.relative_to(root).as_posix()
            mode = stat.S_IMODE(path.stat().st_mode)
            rows.append({'path': rel, 'size': path.stat().st_size, 'sha256': data_hash, 'mode': 0o755 if mode & 0o111 else 0o644})
    return rows


def extract_fleet(lock):
    archive = Path(lock['input'])
    actual = sha256(archive)
    if actual != lock['archiveSha256']:
        raise SystemExit(f'Fleet archive SHA256 mismatch: {actual}')
    dest = INPUTS / 'fleet-v4'
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    top = lock['archiveTop']
    stage_from = top + lock['stageFrom']
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            name = item.filename
            if name.endswith('/'):
                continue
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise SystemExit(f'Fleet archive link refused: {name}')
            if not name.startswith(stage_from):
                continue
            rel = name[len(stage_from):]
            if not rel or rel.startswith('/') or '..' in Path(rel).parts:
                raise SystemExit(f'Unsafe fleet archive name: {name}')
            target = dest / 'runtime' / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(item))
            target.chmod(0o755 if mode & 0o111 else 0o644)
    runtime = dest / 'runtime'
    if not (runtime / 'bin' / 'fleetV4.js').is_file():
        raise SystemExit('Staged Fleet is missing bin/fleetV4.js')
    identity_name = top + lock['identityFile']
    with zipfile.ZipFile(archive) as z:
        try:
            identity_bytes = z.read(identity_name)
        except KeyError:
            raise SystemExit(f'Fleet archive is missing {identity_name}')
    if lock['commit'].encode() not in identity_bytes:
        raise SystemExit(f'Fleet identity file does not contain commit {lock["commit"]}')
    copy_tree(runtime, VENDOR / 'fleet')
    identity_out = VENDOR / 'fleet' / 'release.json'
    identity_out.write_bytes(identity_bytes)
    identity_out.chmod(0o644)
    return {'archiveSha256': actual, 'identityFile': 'release.json', 'identitySha256': sha256(identity_out), 'commit': lock['commit']}


def stage_engine(lock):
    src = Path(lock['input'])
    identity = src / lock['identityFile']
    actual = sha256(identity)
    if actual != lock['identitySha256']:
        raise SystemExit(f'ToolsEngine identity SHA256 mismatch: {actual}')
    app = src / lock['stageFrom']
    if not (app / 'bin' / 'toolsengine.js').is_file():
        raise SystemExit('ToolsEngine app is missing bin/toolsengine.js')
    copy_tree(app, VENDOR / 'toolsengine')
    for name in lock.get('alsoCopy', []):
        origin = src / name
        refuse_link(origin)
        shutil.copy2(origin, VENDOR / 'toolsengine' / name, follow_symlinks=False)
    return {'identitySha256': actual, 'commit': lock.get('commit')}


def stage_knowledge(lock):
    src = Path(lock['input'])
    dest = VENDOR / 'knowledge'
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    for name in lock['files']:
        if name != 'knowledge.py':
            raise SystemExit(f'Knowledge staging allows only knowledge.py, not {name}')
        origin = src / name
        refuse_link(origin)
        actual = sha256(origin)
        if actual != lock['sha256']:
            raise SystemExit(f'knowledge.py SHA256 mismatch: {actual}')
        target = dest / name
        shutil.copy2(origin, target, follow_symlinks=False)
        written.append(name)
    return {'sha256': lock['sha256'], 'files': written, 'build': lock.get('build')}


def main():
    lock = json.loads(LOCK_PATH.read_text())
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name in ('fleet', 'toolsengine', 'knowledge'):
        path = VENDOR / name
        if path.is_symlink():
            raise SystemExit(f'Refusing to replace a symlink: {path}')
        if path.exists():
            shutil.rmtree(path)
    fleet = extract_fleet(lock['fleet'])
    engine = stage_engine(lock['toolsengine'])
    knowledge = stage_knowledge(lock['knowledge'])
    manifest = {
        'schemaVersion': 1,
        'platform': sys.platform if sys.platform != 'linux' else 'linux',
        'arch': 'x64',
        'components': {
            'fleet': {'version': lock['fleet']['version'], **fleet, 'files': file_rows(VENDOR / 'fleet')},
            'toolsengine': {'version': lock['toolsengine']['version'], **engine, 'files': file_rows(VENDOR / 'toolsengine')},
            'knowledge': {'version': lock['knowledge']['version'], **knowledge, 'files': file_rows(VENDOR / 'knowledge')},
        },
    }
    (VENDOR / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    portable = {
        'schemaVersion': 1,
        'product': lock['product'],
        'version': lock['version'],
        'qualification': lock['qualification'],
        'fleet': {'version': lock['fleet']['version'], 'commit': lock['fleet']['commit'], 'platform': lock['fleet']['platform'], 'archive': Path(lock['fleet']['input']).name, 'archiveSha256': lock['fleet']['archiveSha256'], 'identitySha256': fleet['identitySha256']},
        'toolsengine': {'version': lock['toolsengine']['version'], 'commit': lock['toolsengine']['commit'], 'platform': lock['toolsengine'].get('platform','shared-portable'), 'identitySha256': engine['identitySha256'], 'packagedFilesSha256': hashlib.sha256(json.dumps(manifest['components']['toolsengine']['files'],sort_keys=True,separators=(',',':')).encode()).hexdigest()},
        'knowledge': {'version': lock['knowledge']['version'], 'build': lock['knowledge']['build'], 'platform': lock['knowledge'].get('platform','shared-portable'), 'file': 'knowledge.py', 'sha256': lock['knowledge']['sha256'], 'packagedFilesSha256': hashlib.sha256(json.dumps(manifest['components']['knowledge']['files'],sort_keys=True,separators=(',',':')).encode()).hexdigest(), 'upstreamSha256': lock['knowledge'].get('upstreamSha256',lock['knowledge']['sha256'])},
    }
    (SOURCE / 'components.lock.json').write_text(json.dumps(portable, indent=2) + '\n')
    print('staged fleet', lock['fleet']['version'], 'identity', fleet['identitySha256'])
    print('staged toolsengine', lock['toolsengine']['version'], 'files', len(manifest['components']['toolsengine']['files']))
    print('staged knowledge', knowledge['sha256'])


if __name__ == '__main__':
    main()
