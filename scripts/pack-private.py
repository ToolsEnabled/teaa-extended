#!/usr/bin/env python3
"""Pack one already-locked TEAA source tree. No network or component refresh."""
import pathlib,json,hashlib,zipfile,tarfile,gzip,shutil,tempfile,os
S=pathlib.Path(__file__).resolve().parent.parent;pkg=json.loads((S/'package.json').read_text());v=json.loads((S/'vendor/manifest.json').read_text());lock=json.loads((S/'components.lock.json').read_text());win=v['platform']=='win32';name='teaa'+('-extended' if pkg['teaaEdition']=='extended' else '')+'-'+pkg['version']+'-'+('windows-x64' if win else 'linux-x64');D=S.parent/'private-output';D.mkdir(exist_ok=True)
def component_rows(root):
 rows=[]
 for base,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=sorted(d for d in dirs if d!='__pycache__')
  for filename in sorted(f for f in files if not f.endswith('.pyc')):
   path=pathlib.Path(base)/filename
   if path.is_symlink() or not path.is_file(): raise SystemExit('invalid component file: '+str(path))
   rows.append({'path':path.relative_to(root).as_posix(),'size':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':493 if path.stat().st_mode&0o111 else 420})
 return rows
for component,record in v['components'].items():
 actual=component_rows(S/'vendor'/component)
 if actual!=record.get('files'): raise SystemExit('stale or missing component manifest member: '+component)
 locked=lock.get(component,{}).get('packagedFilesSha256')
 digest=hashlib.sha256(json.dumps(actual,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 if locked and locked!=digest: raise SystemExit('component aggregate hash mismatch: '+component)
with tempfile.TemporaryDirectory(prefix='teaa-pack-') as temp:
 root=pathlib.Path(temp)/name;shutil.copytree(S,root,ignore=shutil.ignore_patterns('.git','__pycache__','*.pyc','release-manifest.json'))
 for f in root.rglob('*'):
  if f.is_symlink():raise SystemExit('links are not release inputs')
 if win:
  shutil.copyfile(root/'scripts/install.ps1',root/'install.ps1');(root/'install.cmd').write_bytes(b'@echo off\r\nrem Requires Node.js 22.19 or newer on PATH.\r\nnode "%~dp0src\\install.js" %*\r\n')
 else:shutil.copyfile(root/'scripts/install.sh',root/'install.sh');os.chmod(root/'install.sh',0o755)
 files=[{'path':str(p.relative_to(root)).replace(os.sep,'/'),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':493 if p.stat().st_mode&0o111 else 420} for p in sorted(root.rglob('*')) if p.is_file()]
 (root/'release-manifest.json').write_text(json.dumps({'product':pkg['name'],'edition':'ToolsEnabled Agent Architecture'+(' Extended' if pkg['teaaEdition']=='extended' else ''),'version':pkg['version'],'qualification':lock['qualification'],'sourceCommit':v.get('sourceCommit'),'componentsLockSha256':hashlib.sha256((root/'components.lock.json').read_bytes()).hexdigest(),'vendorManifestSha256':hashlib.sha256((root/'vendor/manifest.json').read_bytes()).hexdigest(),'platform':v['platform'],'arch':'x64','files':files},indent=2)+'\n')
 archive=D/(name+('.zip' if win else '.tar.gz'))
 if archive.exists():raise SystemExit('output exists; retain it and choose a fresh output folder')
 if win:
  with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
   for p in sorted(root.rglob('*')):
    if p.is_file():
     i=zipfile.ZipInfo(name+'/'+str(p.relative_to(root)).replace(os.sep,'/'),(2026,10,26,0,0,0));i.compress_type=zipfile.ZIP_DEFLATED;i.external_attr=(493 if p.stat().st_mode&0o111 else 420)<<16;z.writestr(i,p.read_bytes())
 else:
  with archive.open('wb') as out,gzip.GzipFile(filename='',mode='wb',fileobj=out,mtime=0,compresslevel=9) as gz,tarfile.open(fileobj=gz,mode='w',format=tarfile.GNU_FORMAT) as t:
   for p in [root]+sorted(root.rglob('*')):
    i=t.gettarinfo(str(p),name+('' if p==root else '/'+str(p.relative_to(root))));i.uid=i.gid=0;i.uname=i.gname='';i.mtime=1792972800
    # Modes follow the exec bit only (as in the manifest), never the builder's umask: folders 0755, files 0755 or 0644.
    i.mode=493 if p.is_dir() or p.stat().st_mode&0o111 else 420
    if p.is_file():
     with p.open('rb') as f:t.addfile(i,f)
    else:t.addfile(i)
 print(hashlib.sha256(archive.read_bytes()).hexdigest(),archive.name)
