import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const ARTIFACT_LIMITS = Object.freeze({ files: 256, bytes: 64*1024*1024, fileBytes: 16*1024*1024, downloads: 32 });
// The page snapshot that the browser library writes by itself after a browser
// call: page-<UTC time>.yml directly in artifacts/toolsengine. It is written
// after the click, key or navigation has acted on the page, so it must never
// turn that call into a failure. An automatic snapshot that cannot be saved
// is skipped and reported beside the call's result (takeUnsavedSnapshots).
// Automatic snapshots are kept as a rolling set within a quarter of the
// limits (64 files and 16 MiB by default): before a new one is written, and
// when the server starts, the oldest are deleted. Only files that the index
// records as written by ToolsEngine under that name are deleted; files named
// by a call (filename), screenshots, PDFs, logs, downloads and anything a
// person put there are never deleted.
export const AUTOMATIC_SNAPSHOT = /^page-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yml$/;
export const snapshotShare = limits => ({ files: Math.max(1, Math.min(64, Math.floor(limits.files / 4))), bytes: Math.max(1, Math.floor(limits.bytes / 4)) });
// Another server on the same workspace holds the output lock only while it
// writes one file. Wait this long for it; a lock still held after that is
// a leftover, and the same leftover is not waited for again.
export const OUTPUT_LOCK_WAIT_MS = 2000;
const LOCK_HELD = 'Another ToolsEngine is writing output in this workspace, or a leftover .toolsengine-runtime/artifact-write.lock needs review: if no ToolsEngine is running on this workspace, delete that file';
const KINDS = new Set(['download', 'snapshot', 'named']);
const raw = { writeFile: fs.writeFile.bind(fs), appendFile: fs.appendFile.bind(fs), rename: fs.rename.bind(fs) };
const budgets = new Set();
let installed = false;
const inside = (outer,inner) => { const rel=path.relative(outer,inner);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel)); };
function installWrites() {
  if (installed) return; installed=true;
  for (const name of ['writeFile','appendFile']) fs[name] = async (file,data,options) => {
    if (typeof file !== 'string') return raw[name](file,data,options);
    const absolute=path.resolve(file);const budget=[...budgets].find(item=>item.matches(absolute));
    return budget ? budget.write(absolute,data,{append:name==='appendFile',options}) : raw[name](file,data,options);
  };
}
function plainParents(file) {
  let cursor=path.parse(file).root;
  for(const part of path.dirname(file).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);const stat=sync.lstatSync(cursor);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Artifact parent is not a plain directory.');
  }
}
export async function createArtifactBudget(workspace, limits = ARTIFACT_LIMITS) {
  for(const key of Object.keys(ARTIFACT_LIMITS)) if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>ARTIFACT_LIMITS[key])throw new Error('Invalid artifact limit.');
  const root=await fs.realpath(workspace),output=path.join(root,'artifacts','toolsengine'),runtime=path.join(root,'.toolsengine-runtime');
  for(const directory of [path.join(root,'artifacts'),output,runtime]) {
    try{const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Artifact directory is not plain.');}
    catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(directory,{mode:0o700});}
    plainParents(path.join(directory,'check'));
  }
  const ledger=path.join(runtime,'artifact-index.json');const tracked=new Map(),notes=[];let pendingFiles=0,pendingBytes=0,pendingDownloads=0,chain=Promise.resolve(),closed=false;
  const loadIndex=()=>{
    try {
      plainParents(ledger);const stat=sync.lstatSync(ledger);
      if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new Error('Artifact index is not a bounded plain file.');
      let rows;try{rows=JSON.parse(sync.readFileSync(ledger,'utf8'));}catch{throw new Error('Artifact index is invalid.');}
      if(!Array.isArray(rows)||rows.length>limits.files)throw new Error('Invalid artifact index.');
      for(const row of rows){if(!row||typeof row.path!=='string'||!inside(root,path.resolve(root,row.path)))throw new Error('Invalid artifact index path.');tracked.set(path.resolve(root,row.path),KINDS.has(row.kind)?row.kind:'artifact');}
    } catch(error){if(error.code!=='ENOENT')throw error;}
  };
  loadIndex();
  const outputLock=path.join(runtime,'artifact-write.lock');
  let leftoverLock=null;
  const lockIdentity=async()=>{try{const stat=await fs.lstat(outputLock,{bigint:true});return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;}catch{return null;}};
  const acquireOutput=async(wait=OUTPUT_LOCK_WAIT_MS)=>{
    let handle;const until=Date.now()+wait;
    for(let pause=10;;pause=Math.min(pause*2,200)){
      try{handle=await fs.open(outputLock,sync.constants.O_WRONLY|sync.constants.O_CREAT|sync.constants.O_EXCL|(sync.constants.O_NOFOLLOW||0),0o600);break;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const held=await lockIdentity();
        if(Date.now()>=until||(held&&held===leftoverLock)){if(wait>0)leftoverLock=held;throw new Error(LOCK_HELD+'; nothing was saved.');}
        await delay(Math.max(1,Math.min(pause,until-Date.now())));
      }
    }
    leftoverLock=null;
    const identity=await handle.stat({bigint:true});
    return async()=>{await handle.close();const current=await fs.lstat(outputLock,{bigint:true});if(current.isFile()&&current.nlink===1n&&current.dev===identity.dev&&current.ino===identity.ino&&identity.ino!==0n)await fs.unlink(outputLock);else throw new Error('Artifact output lock identity changed; it was preserved.');};
  };
  const inspect=()=>{
    loadIndex();const files=new Map();
    const scan=directory=>{for(const name of sync.readdirSync(directory)){const file=path.join(directory,name),stat=sync.lstatSync(file);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||stat.isFile()&&stat.nlink!==1)throw new Error('Artifact inventory contains a link or nonregular file.');if(stat.isDirectory())scan(file);else files.set(file,stat.size);if(files.size>limits.files)throw new Error('Saved artifact number limit reached.');}};
    scan(output);
    for(const [file] of tracked){try{plainParents(file);const stat=sync.lstatSync(file);if(!stat.isFile()||stat.nlink!==1)throw new Error('Saved artifact is not a plain file.');files.set(file,stat.size);}catch(error){if(error.code==='ENOENT')tracked.delete(file);else throw error;}}
    const bytes=[...files.values()].reduce((sum,size)=>sum+size,0);return {files,bytes,downloads:[...tracked.values()].filter(kind=>kind==='download').length};
  };
  const persist=async()=>{
    plainParents(ledger);try{const stat=await fs.lstat(ledger);if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact index is not plain.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const rows=[...tracked].map(([file,kind])=>({path:path.relative(root,file),kind}));const temp=ledger+'.'+process.pid+'.new';
    await raw.writeFile(temp,JSON.stringify(rows)+'\n',{flag:'wx',mode:0o600});try{await raw.rename(temp,ledger);}finally{await fs.rm(temp,{force:true});}
  };
  // Automatic snapshots that this server wrote, oldest first. Rows from
  // before 0.1.6 have no kind of their own; such a row counts when its file
  // has the automatic name and lies directly in the output folder.
  const isAutomatic=file=>path.dirname(file)===output&&AUTOMATIC_SNAPSHOT.test(path.basename(file))&&(tracked.get(file)==='snapshot'||tracked.get(file)==='artifact');
  const removeSnapshot=async file=>{
    try{plainParents(file);const stat=await fs.lstat(file);if(!stat.isFile()||stat.nlink!==1)return false;await fs.unlink(file);}
    catch(error){if(error.code!=='ENOENT')return false;}
    tracked.delete(file);return true;
  };
  // Delete the oldest automatic snapshots until the set is within its share
  // of the limits and, for a new one of `incoming` bytes, until the limits
  // leave room for it. Nothing is deleted to make room for a snapshot that
  // would be refused anyway: one larger than its share or than a file may
  // be, or one that would not fit even with every older snapshot gone.
  // Runs under the output lock.
  const trimSnapshots=async(state,incoming=-1)=>{
    const share=snapshotShare(limits);
    const own=[...state.files.keys()].filter(isAutomatic).sort((a,b)=>{const x=path.basename(a),y=path.basename(b);return x<y?-1:x>y?1:0;});
    let count=own.length,bytes=own.reduce((sum,file)=>sum+state.files.get(file),0),removed=false;
    const adding=incoming>=0&&incoming<=Math.min(limits.fileBytes,share.bytes)&&state.files.size-count+1+pendingFiles<=limits.files&&state.bytes-bytes+incoming+pendingBytes<=limits.bytes?1:0;
    const size=adding?incoming:0;
    const over=()=>count+adding>share.files||bytes+size>share.bytes||adding===1&&(state.files.size+1+pendingFiles>limits.files||state.bytes+size+pendingBytes>limits.bytes);
    for(const file of own){
      if(!over())break;
      if(!await removeSnapshot(file))continue;
      const gone=state.files.get(file);state.files.delete(file);state.bytes-=gone;count--;bytes-=gone;removed=true;
    }
    if(removed)await persist();
  };
  const unsaved=[];
  // Outputs a call named (filename) that are not written yet. inspect()
  // forgets a tracked file that does not exist, so they are kept here too:
  // their write still goes through this budget and is recorded as named.
  const pendingNamed=new Set();
  const skipSnapshot=(file,error)=>{
    const reason=error?.code?`the file system refused it (${error.code})`:String(error?.message||error).replace(/;? *nothing was saved\.?$/,'').replace(/\.$/,'');
    if(unsaved.length<8)unsaved.push({name:path.basename(file),reason});
  };
  const budget={
    output,limits,note(text){if(notes.length<8)notes.push(text);},takeNotes(){return notes.splice(0);},
    // Automatic snapshots of the calls since the last take that were not
    // saved: [{ name, reason }]. The reason names no absolute path.
    takeUnsavedSnapshots(){return unsaved.splice(0);},
    matches:file=>!closed&&(inside(output,file)||tracked.has(file)||pendingNamed.has(file)),
    addOutput(file){inspect();if(tracked.size>=limits.files&&!tracked.has(path.resolve(file)))throw new Error('Saved artifact number limit reached.');if(!inside(root,path.resolve(file)))throw new Error('Artifact output leaves workspace.');tracked.set(path.resolve(file),'named');if(pendingNamed.size<1024)pendingNamed.add(path.resolve(file));},
    write(file,data,{append=false,options,kind='artifact'}={}){
      const named=pendingNamed.has(file)||tracked.get(file)==='named';
      const automatic=!append&&kind==='artifact'&&!named&&path.dirname(file)===output&&AUTOMATIC_SNAPSHOT.test(path.basename(file))&&!tracked.has(file);
      const recorded=kind==='download'?'download':automatic?'snapshot':named?'named':'artifact';
      const operation=async()=>{
        if(closed)throw new Error('Artifact writer was closed.');plainParents(file);
        const bytes=typeof data==='string'?Buffer.byteLength(data,typeof options==='string'?options:options?.encoding):Buffer.byteLength(data);
        const release=await acquireOutput();
        try {
        const state=inspect();let existing=0;
        if(automatic)await trimSnapshots(state,bytes);
        try{const stat=await fs.lstat(file);if(!append||!tracked.has(file))throw new Error('Output already exists; choose a new filename.');if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact file is not plain.');existing=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}
        const fresh=!state.files.has(file);
        if(existing+bytes>limits.fileBytes||state.bytes+bytes+pendingBytes>limits.bytes||state.files.size+(fresh?1:0)+pendingFiles>limits.files)throw new Error('Saved artifact size or number limit reached; nothing was saved.');
        if(kind==='download'&&state.downloads>=limits.downloads)throw new Error('Saved download number limit reached.');
        const prospective=new Map(tracked);prospective.set(file,recorded);
        const metadata=JSON.stringify([...prospective].map(([saved,type])=>({path:path.relative(root,saved),kind:type})))+'\n';
        if(Buffer.byteLength(metadata)>65536)throw new Error('Artifact index size limit reached; nothing was saved.');
        // Append only to tracked artifacts. New output uses wx.
        let identity;
        const handle=await fs.open(file,append?sync.constants.O_WRONLY|sync.constants.O_APPEND|(sync.constants.O_NOFOLLOW||0)|(!state.files.has(file)?sync.constants.O_CREAT|sync.constants.O_EXCL:0):'wx',0o600);
        try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw new Error('Artifact file is not plain.');identity=await handle.stat({bigint:true});await handle.writeFile(data,options);}finally{await handle.close();}
        tracked.set(file,recorded);pendingNamed.delete(file);
        try{await persist();}catch(error){
          if(fresh){const current=await fs.lstat(file,{bigint:true}).catch(()=>null);if(current?.isFile()&&current.nlink===1n&&current.dev===identity.dev&&current.ino===identity.ino&&identity.ino!==0n)await fs.unlink(file);tracked.delete(file);}
          throw error;
        }
        } finally {await release();}
      };
      // An automatic snapshot never fails the call it belongs to: the call has
      // already acted on the page when the browser library writes it.
      const run=automatic?()=>operation().catch(error=>skipSnapshot(file,error)):operation;
      const result=chain.then(run);chain=result.catch(()=>{});return result;
    },
    reserveDownload(){
      const state=inspect();
      if(state.downloads+pendingDownloads>=limits.downloads||state.files.size+pendingFiles>=limits.files||state.bytes+pendingBytes+limits.fileBytes>limits.bytes)throw new Error('Download count or size limit reached; download refused.');
      pendingFiles++;pendingBytes+=limits.fileBytes;pendingDownloads++;let released=false;
      return {release(){if(!released){released=true;pendingFiles--;pendingBytes-=limits.fileBytes;pendingDownloads--;}}};
    },
    writeDownload(file,data){return budget.write(file,data,{kind:'download'});},
    async close(){await chain;closed=true;budgets.delete(budget);},
  };
  inspect();
  // A workspace that an earlier version filled with automatic snapshots is
  // brought within their share at once. Skipped while another writer holds
  // the lock; the next automatic snapshot trims as well.
  try{const release=await acquireOutput(0);try{await trimSnapshots(inspect());}finally{await release();}}catch{}
  installWrites();budgets.add(budget);return budget;
}
