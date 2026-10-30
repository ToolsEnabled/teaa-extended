#!/usr/bin/env python3
"""Build each TEAA platform archive twice from one exact source commit."""
import argparse, hashlib, json, shutil, subprocess, tarfile, zipfile
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[1]
LANE=SOURCE.parent
ARTIFACTS=LANE/'artifacts'
FLEET=ARTIFACTS/'fleet-component-alpha5'
FLEET_INPUTS=json.loads((FLEET/'INPUTS.json').read_text())
FLEET_COMMIT=FLEET_INPUTS['fleetCommit']
VERSION=json.loads((SOURCE/'package.json').read_text())['version']
SOURCE_COMMIT=subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()
REVISION=SOURCE_COMMIT[:7]
OUT=ARTIFACTS/'builds'/f'{VERSION}-{REVISION}'
CHECK=LANE/f'package-check-{VERSION}-{REVISION}'
OUT.mkdir(parents=True,exist_ok=True)
PACKAGE=json.loads((SOURCE/'package.json').read_text())
parser=argparse.ArgumentParser(description='Build reproducible TEAA packages from one exact source commit.')
parser.add_argument('--target',choices=('linux-x64','windows-x64'))
args=parser.parse_args()
targets=(args.target,) if args.target else ('linux-x64','windows-x64')

def sha(data): return hashlib.sha256(data).hexdigest()
def run(args,cwd): subprocess.run(args,cwd=cwd,check=True)
def members(archive):
    if archive.suffix=='.zip':
        with zipfile.ZipFile(archive) as z: return {Path(n).name if n.endswith('/release-manifest.json') else n.split('/',1)[1]:z.read(n) for n in z.namelist() if n.endswith('/release-manifest.json') or '/components.lock.json' in n or '/vendor/manifest.json' in n or '/SOURCE-MANIFEST.json' in n}
    with tarfile.open(archive,'r:gz') as t:
        out={}
        for m in t.getmembers():
            if m.name.endswith('/release-manifest.json') or '/components.lock.json' in m.name or '/vendor/manifest.json' in m.name or '/SOURCE-MANIFEST.json' in m.name:
                f=t.extractfile(m)
                if f: out[m.name.split('/',1)[1]]=f.read()
        return out

receipt_path=ARTIFACTS/f'reproducibility-{VERSION}-{REVISION}.json'
records={}
if receipt_path.exists():
    previous=json.loads(receipt_path.read_text())
    expected_base=json.loads((SOURCE/'BASE-PIN.json').read_text())['sourceCommit'] if PACKAGE.get('teaaEdition')=='extended' else None
    if previous.get('sourceCommit')!=SOURCE_COMMIT or previous.get('baseSourceCommit')!=expected_base:
        raise SystemExit('existing version-scoped build receipt belongs to another source or BASE; use a new source/version output path')
    records.update(previous.get('builds',{}))
for target in targets:
    pin=json.loads((SOURCE/'BASE-PIN.json').read_text())
    if pin.get('sourceCommit') == 'd21720077a3003454ae174d47f09201dda6a2c96':
        raise SystemExit('alpha5 exact BASE pin is not installed; refusing the stale alpha4 pin')
    fixed=FLEET_INPUTS['fixedComponents']
    if pin.get('toolsengine',{}).get('commit')!=fixed['toolsengineCommit']:
        raise SystemExit('BASE ToolsEngine commit does not match the accepted alpha5 task input')
    if pin.get('knowledge',{}).get('upstreamSha256')!=fixed['knowledgeUpstreamSha256'] or pin.get('knowledge',{}).get('derivedKnowledgePySha256')!=fixed['knowledgeDerivedSha256']:
        raise SystemExit('BASE Knowledge identities do not match the accepted portable 1.2 task input')
    pinned_fleet=pin.get('fleet',{})
    target_pin=pinned_fleet.get('targets',{}).get(target,{})
    input_pin=FLEET_INPUTS['targets'][target]
    if pinned_fleet.get('commit') != FLEET_COMMIT or target_pin.get('archiveSha256') != input_pin['archiveSha256']:
        raise SystemExit(f'{target} Fleet input does not match the exact alpha5 BASE pin')
    base_pkg=pin.get('basePackages',{}).get(target,{})
    if not base_pkg.get('abIdentical') or base_pkg.get('sourceCommit') != pin.get('sourceCommit'):
        raise SystemExit(f'{target} BASE input lacks a matching clean A/B package pair')
    archive_in=FLEET/('linux-a' if target=='linux-x64' else 'windows-a')/input_pin['path'].split('/',1)[1]
    if sha(archive_in.read_bytes()) != input_pin['archiveSha256']:
        raise SystemExit(f'{target} Fleet input archive hash does not match the accepted task7 record')
    target_records=[]
    for rep in ('a','b'):
        root=CHECK/f'{target}-{rep}'
        if root.exists(): shutil.rmtree(root)
        root.mkdir(parents=True)
        tree=root/'source'
        run(['git','clone','--no-hardlinks',str(SOURCE),str(tree)],LANE)
        run(['python3',('scripts/stage-extended.py' if PACKAGE.get('teaaEdition')=='extended' else 'scripts/stage-successor.py'),'--archive',str(archive_in),'--target',target],tree)
        run(['python3','scripts/pack-private.py'],tree)
        built=next((tree.parent/'private-output').glob(('teaa-extended-' if PACKAGE.get('teaaEdition')=='extended' else 'teaa-')+PACKAGE['version']+'-*'))
        build_dir=OUT/rep
        build_dir.mkdir(parents=True,exist_ok=True)
        final=build_dir/built.name
        shutil.copy2(built,final)
        content=members(final)
        rel=next(k for k in content if k=='release-manifest.json' or k.endswith('/release-manifest.json'))
        release=json.loads(content[rel])
        target_records.append({'file':str(final.relative_to(LANE)),'sha256':sha(final.read_bytes()),'releaseManifestSha256':sha(content[rel]),'componentsLockSha256':sha(content[next(k for k in content if k.endswith('components.lock.json'))]),'vendorManifestSha256':sha(content[next(k for k in content if k.endswith('vendor/manifest.json'))]),'sourceManifestSha256':sha(content[next(k for k in content if k.endswith('SOURCE-MANIFEST.json'))]),'sourceCommit':release.get('sourceCommit'),'qualification':release.get('qualification'),'files':len(release['files'])})
    if len({row['sha256'] for row in target_records})!=1 or len({row['releaseManifestSha256'] for row in target_records})!=1:
        raise SystemExit(f'{target} builds differ: '+json.dumps(target_records,indent=2))
    records[target]=target_records
complete=set(records)=={'linux-x64','windows-x64'}
identical=all(len({row['sha256'] for row in rows})==1 and len({row['releaseManifestSha256'] for row in rows})==1 for rows in records.values())
receipt={'sourceCommit':SOURCE_COMMIT,'baseSourceCommit':json.loads((SOURCE/'BASE-PIN.json').read_text())['sourceCommit'] if PACKAGE.get('teaaEdition')=='extended' else None,'fleetCommit':FLEET_COMMIT,'fleetParentImplementation':FLEET_INPUTS['parentBaseCommit'],'builds':records,'platformsBuilt':sorted(records),'complete':complete,'identical':identical}
receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'receipt':str(receipt_path.relative_to(LANE)),'sourceCommit':SOURCE_COMMIT,'builtTargets':list(targets),'complete':complete,'builds':{target:records[target] for target in targets},'identical':identical},indent=2))
