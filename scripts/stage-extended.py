#!/usr/bin/env python3
"""Stage one target Fleet archive and refresh pinned TEAA Extended manifests."""
import argparse, copy, hashlib, json, os, stat, subprocess, sys, tarfile, zipfile
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]
LANE=SOURCE.parent
def digest(data): return hashlib.sha256(data).hexdigest()
def rows(root):
 out=[]
 for base,dirs,files in os.walk(root,followlinks=False):
  dirs.sort(); files.sort(); current=Path(base)
  if current.is_symlink(): raise SystemExit(f'Refusing link: {current}')
  for name in files:
   p=current/name
   if p.is_symlink() or not p.is_file(): raise SystemExit(f'Refusing non-file: {p}')
   mode=stat.S_IMODE(p.stat().st_mode)
   out.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size,'sha256':digest(p.read_bytes()),'mode':493 if mode&0o111 else 420})
 return out
def package_member(archive, suffix):
 archive=Path(archive)
 if archive.suffix=='.zip':
  with zipfile.ZipFile(archive) as z:
   matches=[n for n in z.namelist() if n.endswith('/'+suffix)]
   if len(matches)!=1: raise SystemExit(f'BASE package must contain exactly one {suffix}')
   return z.read(matches[0])
 with tarfile.open(archive,'r:gz') as t:
  matches=[m for m in t.getmembers() if m.isfile() and m.name.endswith('/'+suffix)]
  if len(matches)!=1: raise SystemExit(f'BASE package must contain exactly one {suffix}')
  stream=t.extractfile(matches[0])
  if stream is None: raise SystemExit(f'Cannot read BASE package member {suffix}')
  return stream.read()
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--archive',required=True); ap.add_argument('--target',choices=['linux-x64','windows-x64'],required=True); a=ap.parse_args()
 base_pin=json.loads((SOURCE/'BASE-PIN.json').read_text())
 archive=Path(a.archive)
 input_root=archive.parent.parent
 inputs=json.loads((input_root/'INPUTS.json').read_text())
 fleet_pin=base_pin.get('fleet',{})
 target_pin=fleet_pin.get('targets',{}).get(a.target,{})
 input_pin=inputs['targets'][a.target]
 if base_pin.get('sourceCommit')=='d21720077a3003454ae174d47f09201dda6a2c96':
  raise SystemExit('alpha5 exact BASE pin is not installed; refusing the stale alpha4 pin')
 if fleet_pin.get('commit')!=inputs['fleetCommit'] or target_pin.get('archiveSha256')!=input_pin['archiveSha256']:
  raise SystemExit(f'{a.target} Fleet input does not match the exact alpha5 BASE pin')
 fixed=inputs['fixedComponents']
 if base_pin.get('toolsengine',{}).get('commit')!=fixed['toolsengineCommit']:
  raise SystemExit('BASE ToolsEngine commit does not match the accepted alpha5 task input')
 if base_pin.get('knowledge',{}).get('upstreamSha256')!=fixed['knowledgeUpstreamSha256'] or base_pin.get('knowledge',{}).get('derivedKnowledgePySha256')!=fixed['knowledgeDerivedSha256']:
  raise SystemExit('BASE Knowledge identities do not match the accepted portable 1.2 task input')
 if digest(archive.read_bytes())!=input_pin['archiveSha256']:
  raise SystemExit(f'{a.target} Fleet archive does not match the accepted task7 input hash')
 base_pkg=base_pin.get('basePackages',{}).get(a.target,{})
 if not base_pkg.get('abIdentical') or base_pkg.get('sourceCommit')!=base_pin.get('sourceCommit'):
  raise SystemExit(f'{a.target} BASE input lacks a matching clean A/B package pair')
 base_archive=Path(base_pkg.get('path',''))
 if not base_archive.is_file() or digest(base_archive.read_bytes())!=base_pkg.get('sha256'):
  raise SystemExit(f'{a.target} BASE package archive does not match the accepted alpha5 pin')
 base_lock=json.loads(package_member(base_archive,'components.lock.json'))
 base_vendor=json.loads(package_member(base_archive,'vendor/manifest.json'))
 base_release=package_member(base_archive,'vendor/fleet/release.json')
 base_fleet_lock=base_lock.get('fleet',{})
 base_fleet_manifest=base_vendor.get('components',{}).get('fleet',{})
 if base_fleet_lock.get('commit')!=fleet_pin.get('commit') or base_fleet_lock.get('platform')!=a.target:
  raise SystemExit(f'{a.target} BASE Fleet lock identity is inconsistent')
 if digest(base_release)!=base_fleet_lock.get('identitySha256') or digest(base_release)!=base_fleet_manifest.get('identitySha256'):
  raise SystemExit(f'{a.target} BASE Fleet release identity does not match its lock and vendor manifest')
 if base_fleet_lock.get('archiveSha256')!=input_pin['archiveSha256']:
  raise SystemExit(f'{a.target} BASE Fleet archive pin does not match the accepted component input')
 lockp=SOURCE/'components.lock.json'; prelock=json.loads(lockp.read_text())
 prelock['fleet']['commit']=inputs['fleetCommit']
 lockp.write_text(json.dumps(prelock,indent=2)+'\n')
 subprocess.run([sys.executable,str(SOURCE/'scripts/stage-successor.py'),'--archive',str(archive),'--target',a.target],check=True)
 lockp=SOURCE/'components.lock.json'; lock=json.loads(lockp.read_text()); mp=SOURCE/'vendor/manifest.json'; manifest=json.loads(mp.read_text())
 # The embedded BASE Fleet release identity is already the accepted platform
 # identity. Preserve its exact bytes and metadata instead of synthesizing a
 # second TEAA-specific Fleet derivation during Extended staging.
 fleet_root=SOURCE/'vendor/fleet'
 (fleet_root/'release.json').write_bytes(base_release)
 expected_fleet_files=base_fleet_manifest.get('files',[])
 actual_fleet_files=rows(fleet_root)
 if actual_fleet_files!=expected_fleet_files:
  raise SystemExit(f'{a.target} Extended Fleet files differ from the accepted BASE component manifest')
 lock['fleet']=copy.deepcopy(base_fleet_lock)
 manifest['components']['fleet']=copy.deepcopy(base_fleet_manifest)
 for name in ('fra-core','hub'):
  root=SOURCE/'vendor'/name; prov=json.loads((root/'PROVENANCE.json').read_text()); files=rows(root)
  if name=='fra-core':
   descriptor=root/'package.json'
   if not descriptor.is_file() or json.loads(descriptor.read_text())!={'type':'commonjs'}:
    raise SystemExit('fra-core must carry the minimal CommonJS package-scope descriptor required by the packaged Hub adapter')
   upstream=prov.get('files',[])
   upstream_by={item['path']:item for item in upstream}
   derived=[]
   for row in files:
    rel=row['path']
    if rel=='PROVENANCE.json': continue
    prior=upstream_by.get(rel)
    if prior is None or row['sha256'] != prior.get('sha256'):
     reasons={
      'package.json':'Declare the vendored FRA JavaScript modules as CommonJS inside the outer TEAA ESM package so the packaged Hub device adapter can require the canonical modules; upstream FRA module bytes are unchanged.',
      'PROVENANCE.md':'Document FRA source attribution, packaged scope and the TEAA Extended runtime derivation.',
     }
     if rel not in reasons: raise SystemExit('unexpected FRA-core derived file: '+rel)
     derived.append({'path':rel,'upstreamSha256':None,'packagedSha256':row['sha256'],'reason':reasons[rel]})
   if {item['path'] for item in derived}!={'package.json','PROVENANCE.md'}: raise SystemExit('fra-core provenance must identify its CommonJS scope and provenance document')
   prov['immutableUpstreamFiles']=upstream
   prov['derivedOrAddedFiles']=derived
   packaged_inventory=[row for row in files if row['path']!='PROVENANCE.json']
   prov['packagedInventory']={'fileCount':len(packaged_inventory),'files':packaged_inventory,'filesSha256':digest(json.dumps(packaged_inventory,sort_keys=True,separators=(',',':')).encode()),'selfReference':'PROVENANCE.json is omitted here to avoid a self-hash cycle; its final packaged hash is in vendor/manifest.json and components.lock.json.'}
   (root/'PROVENANCE.json').write_text(json.dumps(prov,indent=2)+'\n')
   files=rows(root)
  if name=='hub':
   overlay=[]
   known={item['path']:item for item in prov.get('files',[])}
   for row in files:
    rel=row['path']
    if rel=='PROVENANCE.json': continue
    prior=known.get(rel)
    if not prior or row['sha256'] != prior.get('sha256'):
     reasons={
      'PROVENANCE.md':'Document upstream attribution, packaged scope and TEAA Extended runtime derivation.',
      'bin/gateway-compatibility.cjs':'Use SystemRoot-qualified PowerShell for native Windows compatibility checks while retaining Linux behavior.',
      'bin/windows-package-identity.ps1':'Add the Windows package identity verifier used to validate the exact installed Hub component tree and ACLs.',
      'remote/remote-lead-mcp.cjs':'Add native Windows Fleet V5 process-ancestry observation; query the selected gateway compatibility claim before FRA open, include it in the stream request, and export main for the bundled client wrapper.',
      'bin/fra-gateway.cjs':'Probe the account service at /v1/health used by the hosted and self-hosted releases, with /healthz fallback for older fronts.',
     }
     overlay.append({'path':rel,'upstreamSha256':prior.get('sha256') if prior else None,'packagedSha256':row['sha256'],'reason':reasons.get(rel,'Added as a TEAA Extended Hub runtime file; exact path and package hash are listed in packagedInventory and vendor/manifest.json.')})
   prov['immutableUpstreamFiles']=prov.get('files',[])
   prov['derivedOrAddedFiles']=overlay
   if 'portingPatch' in prov:
    ported=next((row for row in files if row['path']==prov['portingPatch'].get('path')),None)
    if ported: prov['portingPatch']['packagedSha256']=ported['sha256']
   packaged_inventory=[row for row in files if row['path']!='PROVENANCE.json']
   prov['packagedInventory']={'fileCount':len(packaged_inventory),'files':packaged_inventory,'filesSha256':digest(json.dumps(packaged_inventory,sort_keys=True,separators=(',',':')).encode()),'selfReference':'PROVENANCE.json is omitted here to avoid a self-hash cycle; its final packaged hash is in vendor/manifest.json and components.lock.json.'}
   (root/'PROVENANCE.json').write_text(json.dumps(prov,indent=2)+'\n')
   files=rows(root)
  packaged=digest(json.dumps(files,sort_keys=True,separators=(',',':')).encode())
  entry={'sourceRepository':prov['sourceRepository'],'sourceCommit':prov['sourceCommit'],'sourcePath':prov['sourcePath'],'sourceScope':prov['scope'],'fileCount':len(files),'files':files,'packagedFilesSha256':packaged}
  manifest['components'][name]=entry
  lock[name]={'sourceRepository':entry['sourceRepository'],'sourceCommit':entry['sourceCommit'],'sourceScope':entry['sourceScope'],'fileCount':entry['fileCount'],'packagedFilesSha256':packaged}
 lock['product']='@toolsenabled/teaa'; lock['edition']='TEAA Extended'; lock['teaaEdition']='extended'
 base_pin=json.loads((SOURCE/'BASE-PIN.json').read_text())
 lock['baseSourceCommit']=base_pin['sourceCommit']
 lock['basePin']=base_pin
 version=json.loads((SOURCE/'package.json').read_text())['version']
 lock['version']=version
 lock['qualification']=f'TEAA Extended {version}: reproducible Linux x64 and native Windows x64 packages; package-bound FRA CLI and Hub behavior and platform-specific evidence are recorded separately. No hosted production deployment or provider/model calls.'
 lockp.write_text(json.dumps(lock,indent=2)+'\n')
 mp.write_text(json.dumps(manifest,indent=2)+'\n')
 smp=SOURCE/'SOURCE-MANIFEST.json'; sm=json.loads(smp.read_text()); by={r['path']:r for r in sm.get('files',[])}
 roots=('bin/teaa-extended.js','bin/hub-gateway-runtime.cjs','bin/hub-client.cjs','bin/hub-profile.cjs','SETUP.md','EXTENDED-SETUP.md','README.md','UPGRADE.md','preview/packaged-mcp.json','preview/wire-samples.json','PRIVACY.md','CHANGELOG.md','package.json','vendor-lock.json','scripts/build-reproducible.py','scripts/pack-private.py','scripts/stage-successor.py','scripts/stage-extended.py','BASE-PIN.json','src/bundle.js','test/teaa-extended.test.cjs','test/hub-gateway-runtime.test.cjs','test/teaa-hub.test.cjs','test/hub-path-fixes.test.cjs','test/windows-private-path.test.cjs','test/packaged-fra-cli.test.cjs')
 for rel in roots:
  p=SOURCE/rel
  if not p.is_file(): raise SystemExit(f'Missing source manifest input: {rel}')
  by[rel]={'path':rel,'sha256':digest(p.read_bytes())}
 for rootname in ('hub','fra-core'):
  for r in rows(SOURCE/'vendor'/rootname):
   rel='vendor/'+rootname+'/'+r['path']; p=SOURCE/rel
   by[rel]={'path':rel,'sha256':digest(p.read_bytes())}
 sm['files']=sorted(by.values(),key=lambda r:r['path']); smp.write_text(json.dumps(sm,indent=2)+'\n')
 print(json.dumps({'target':a.target,'baseSourceCommit':lock['baseSourceCommit'],'fleetArchiveSha256':lock['fleet']['archiveSha256'],'hubSourceCommit':lock['hub']['sourceCommit'],'fraCoreSourceCommit':lock['fra-core']['sourceCommit'],'sourceFiles':len(sm['files'])}))
if __name__=='__main__': main()
