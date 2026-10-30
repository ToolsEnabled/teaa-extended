#!/usr/bin/env python3
"""Stage a pinned standalone Fleet build into the TEAA base candidate.

The input archive must be produced by the reviewed Fleet build script. This
only mutates the TEAA working tree and writes portable component provenance.
"""
import argparse, copy, hashlib, json, os, shutil, stat, subprocess, zipfile
from pathlib import Path, PurePosixPath

SOURCE = Path(__file__).resolve().parents[1]
ROOT = SOURCE.parent

def digest(data): return hashlib.sha256(data).hexdigest()

def rows(root):
    out=[]
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:]=sorted(name for name in dirs if name != '__pycache__'); files.sort(); current=Path(base)
        if current.is_symlink(): raise SystemExit(f'Refusing link: {current}')
        for name in files:
            if name.endswith('.pyc'):
                continue
            p=current/name
            if p.is_symlink() or not p.is_file(): raise SystemExit(f'Refusing non-file: {p}')
            mode=stat.S_IMODE(p.stat().st_mode)
            out.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size,'sha256':digest(p.read_bytes()),'mode':493 if mode&0o111 else 420})
    return out

def refresh_source_manifest():
    path=SOURCE/'SOURCE-MANIFEST.json'; current=json.loads(path.read_text())
    by_path={row['path']:row for row in current.get('files',[])}
    for rel in ('scripts/stage-successor.py','scripts/build-reproducible.py','test/knowledge-windows-port.test.py','test/windows-private-path.test.cjs'):
        by_path.setdefault(rel,{'path':rel,'sha256':''})
    for rel,row in by_path.items():
        file=SOURCE/rel
        if not file.is_file(): raise SystemExit(f'Source manifest input is missing: {rel}')
        row['sha256']=digest(file.read_bytes())
    current['files']=sorted(by_path.values(),key=lambda row:row['path'])
    path.write_text(json.dumps(current,indent=2)+'\n')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--archive', type=Path, required=True)
    ap.add_argument('--target', choices=['linux-x64','windows-x64'], required=True)
    args=ap.parse_args(); archive=args.archive.resolve()
    lock_path=SOURCE/'components.lock.json'; lock=json.loads(lock_path.read_text())
    raw=archive.read_bytes(); archive_hash=digest(raw); z=zipfile.ZipFile(archive)
    names=set(z.namelist())
    release_name=next((n for n in names if n.endswith('/release.json') and n.count('/')==1),None)
    if not release_name: raise SystemExit('Fleet archive has no single top-level release.json')
    release=json.loads(z.read(release_name)); top=release_name.rsplit('/',1)[0]+'/'
    if release.get('name')!='fleetV5' or release.get('target')!=args.target or release.get('commit')!=lock['fleet']['commit']:
        raise SystemExit('Fleet archive identity does not match the requested target and pinned commit')
    expected={f['path']:f for f in release.get('files',[])}
    actual={n[len(top):]:z.read(n) for n in names if n.startswith(top) and n!=release_name and not n.endswith('/')}
    if set(actual)!=set(expected): raise SystemExit('Fleet archive files do not match its release manifest')
    for rel, body in actual.items():
        p=PurePosixPath(rel)
        if p.is_absolute() or '..' in p.parts or '\\' in rel:
            raise SystemExit(f'Unsafe or unexpected Fleet archive path: {rel}')
        record=expected[rel]
        if len(body)!=record['size'] or digest(body)!=record['sha256']:
            raise SystemExit(f'Fleet archive file does not match release identity: {rel}')
    if 'runtime/bin/fleetV5.js' not in actual or 'runtime/tools/windows-state-security.ps1' not in actual:
        raise SystemExit('Fleet V5 runtime or Windows state-security script is missing')
    fleet=SOURCE/'vendor/fleet'
    if fleet.is_symlink(): raise SystemExit('Refusing to replace Fleet symlink')
    if fleet.exists(): shutil.rmtree(fleet)
    for rel, body in actual.items():
        if not rel.startswith('runtime/'): continue
        target=fleet/rel.removeprefix('runtime/')
        target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(body)
        target.chmod(0o755 if expected[rel].get('mode',420)==493 else 0o644)
    upstream_identity= z.read(release_name)
    # TEAA deliberately flattens the standalone Fleet archive's runtime/ tree
    # into vendor/fleet. Keep the upstream release immutable as provenance, but
    # derive a package identity whose paths describe the bytes we actually ship.
    flattened=copy.deepcopy(release)
    flattened['files']=[{**record,'path':record['path'][len('runtime/'):]} for record in release['files'] if record['path'].startswith('runtime/')]
    flattened['packaging']={'format':'teaa-flattened-fleet-runtime-v1','upstreamReleaseSha256':digest(upstream_identity)}
    identity=json.dumps(flattened,indent=2).encode()+b'\n'
    (fleet/'release.json').write_bytes(identity)
    pin=lock['fleet']; pin.update({'version':release['version'],'platform':args.target,'archive':archive.name,'archiveSha256':archive_hash,'identitySha256':digest(identity),'upstreamIdentitySha256':digest(upstream_identity)})
    pin['runtime']={
      'name':'fleetV5','generation':5,'entry':'vendor/fleet/bin/fleetV5.js','stateDirectory':'fleetV5-state',
      'legacyEntries':['vendor/fleet/bin/fleetV4.js','vendor/fleet/bin/fleetV3.js','vendor/fleet/bin/fleetV2.js','vendor/fleet/bin/toolsenabled-host.js'],
      'legacyStateDirectories':['fleetV4-state','fleetV3-state','fleetV2-state','fleet-state'],
      'workerPrograms':['fleetV5.js','fleetV4.js','fleetV3.js','fleetV2.js','toolsenabled-host.js','linux-process-supervisor.py'],
      'securityScript':'vendor/fleet/tools/windows-state-security.ps1','migrationKey':'fleet-v4-to-v5'
    }
    teaa_version=json.loads((SOURCE/'package.json').read_text())['version']
    lock['version']=teaa_version
    lock['qualification']=f'PRIVATE TEAA BASE {teaa_version} successor candidate: reproducible Linux x64 and native Windows x64 archives; setup, doctor, config and combined-MCP smoke verified. Extended, FRA, Hub and provider/model integrations are outside this qualification.'
    source_commit=subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()
    lock['derivation']={'teaaSourceCommit':source_commit,'fleetCommit':release['commit'],'fleetTarget':args.target,'fleetArchiveSha256':archive_hash}
    lock['fleet']['packagedFilesSha256']=digest(json.dumps(rows(fleet),sort_keys=True,separators=(',',':')).encode())
    component_rows={}
    for component in ('toolsengine','knowledge'):
        component_root=SOURCE/'vendor'/component
        component_rows[component]=rows(component_root)
        lock[component]['packagedFilesSha256']=digest(json.dumps(component_rows[component],sort_keys=True,separators=(',',':')).encode())
    if digest((SOURCE/'vendor/knowledge/knowledge.py').read_bytes()) != lock['knowledge']['sha256']:
        raise SystemExit('Knowledge derivative file does not match the separately pinned derived identity')
    lock_path.write_text(json.dumps(lock,indent=2)+'\n')
    platform='win32' if args.target=='windows-x64' else 'linux'
    manifest={'schemaVersion':1,'platform':platform,'arch':'x64','sourceCommit':source_commit,'components':{
      'fleet':{'version':release['version'],'commit':release['commit'],'archiveSha256':archive_hash,'identityFile':'release.json','identitySha256':digest(identity),'upstreamIdentitySha256':digest(upstream_identity),'files':rows(fleet)},
      'toolsengine':{'version':lock['toolsengine']['version'],'commit':lock['toolsengine']['commit'],'sourcePlatform':lock['toolsengine'].get('platform','shared-portable'),'identitySha256':lock['toolsengine']['identitySha256'],'packagedFilesSha256':lock['toolsengine']['packagedFilesSha256'],'files':component_rows['toolsengine']},
      'knowledge':{'version':lock['knowledge']['version'],'build':lock['knowledge']['build'],'sourcePlatform':lock['knowledge'].get('platform','shared-portable'),'upstreamSha256':lock['knowledge'].get('upstreamSha256',lock['knowledge']['sha256']),'sha256':lock['knowledge']['sha256'],'packagedFilesSha256':lock['knowledge']['packagedFilesSha256'],'compatibilityPatch':lock['knowledge'].get('compatibilityPatch'),'files':component_rows['knowledge']}
    }}
    (SOURCE/'vendor/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    refresh_source_manifest()
    print(json.dumps({'target':args.target,'fleetCommit':release['commit'],'fleetVersion':release['version'],'fleetArchiveSha256':archive_hash,'identitySha256':digest(identity),'fleetFiles':len(manifest['components']['fleet']['files']),'teaaSourceCommit':source_commit}))
if __name__=='__main__': main()
