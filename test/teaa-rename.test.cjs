// TEAA, the ToolsEnabled Agent Architecture, is the new name of the earlier kit. These hold the rename in place:
// no earlier product name in this tree (vendored Fleet and ToolsEngine included), and Fleet still finds
// the lead CLI behind `node bin/teaa.js mcp` at the level it has when it starts Fleet directly.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
// Spelled from character codes so this file does not itself carry the names it looks for.
const word=(...codes)=>String.fromCharCode(...codes);
// A name counts only as a whole word: identifiers whose letters merely contain one (normalizeUseful) are not product names.
const OLD=new RegExp('(?<![a-z])(?:'+[word(122,117,115,101),word(122,101,117,115),word(97,103,101,110,116)+'[ _-]?'+word(107,105,116)].join('|')+')(?![a-z])','i');
const KEPT=new RegExp('toolsenabled-'+word(97,103,101,110,116)+'-'+word(107,105,116),'g'); // the per-user folder name
const HISTORY=new Set(['CHANGELOG.md','UPGRADE.md']); // these may say what TEAA was called before
// Fleet V5 keeps exact compatibility references for older gateway registrations.
function compatibilityText(rel,line){
 const oldScript=word(97,103,101,110,116)+'-'+word(107,105,116)+'.js';
 const oldName=word(65,103,101,110,116,32,75,105,116);
 if(rel==='vendor/fleet/src/lib/agents/permission-level.js')return line.replaceAll(oldScript,'');
 if(rel==='vendor/fleet/src/lib/product-identity.js')return line.replace(`existing ${oldName} installs`,'existing TEAA installs');
 return line;
}
function* files(dir){
 for(const name of fs.readdirSync(dir)){
  if(name==='.git'||name==='__pycache__')continue;
  const p=path.join(dir,name),s=fs.lstatSync(p);
  if(s.isDirectory())yield* files(p);else if(s.isFile())yield p;
 }
}
const text=b=>!b.includes(0); // like grep -I: a file with a NUL byte is binary
test('no earlier product name in any file name or text file of this tree, vendored parts included',()=>{
 const found=[];
 for(const p of files(root)){
  const rel=path.relative(root,p).split(path.sep).join('/');
  if(OLD.test(rel.replace(KEPT,'')))found.push(rel);
  if(HISTORY.has(rel))continue;
  const b=fs.readFileSync(p);if(!text(b))continue;
  const lines=b.toString('utf8').split('\n');
  for(let i=0;i<lines.length;i++)if(OLD.test(compatibilityText(rel,lines[i]).replace(KEPT,'')))found.push(`${rel}:${i+1}`);
 }
 assert.deepEqual(found,[]);
});
test('the Extended package uses TEAA command, MCP identity, status tool and environment overrides',async()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(pkg.name,'@toolsenabled/teaa');assert.deepEqual(pkg.bin,{teaa:'bin/teaa.js'});
 const h=cp.spawnSync(process.execPath,[path.join(root,'bin/teaa.js'),'--help'],{encoding:'utf8'});
 assert.equal(h.status,0);assert.match(h.stdout,/^TEAA Extended \(ToolsEnabled Agent Architecture\) /);
 const {Gateway}=await import('../src/mcp/gateway.js');const g=new Gateway({upstreams:[]});
 const status=g.listTools().find(t=>t.name==='teaa_status');assert.ok(status);assert.equal(status.title,'TEAA: status');
 assert.match(g.instructions(),/^TEAA Extended \(ToolsEnabled Agent Architecture\) offers Fleet/);
 const {presentationEnabled}=await import('../src/mcp/presentation.js');
 assert.equal(presentationEnabled({TEAA_PRESENTATION:'off'}),false);
});
test('bundled Fleet keeps administrator lead level independent of synthetic gateway ancestry and CLI labels',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'teaa-lead-level-'));
 const script=`
  const path=require('node:path');const [app]=process.argv.slice(1);const lib=path.join(app,'vendor/fleet/src/lib/agents');
  const pl=require(path.join(lib,'permission-level.js')),registry=require(path.join(lib,'registry.js')).activeRegistry(process.env);
  const clis={claude:['claude','--dangerously-skip-permissions'],codex:['codex','--dangerously-bypass-approvals-and-sandbox'],grok:['grok','--always-approve'],agy:['agy','--dangerously-skip-permissions'],gemini:['gemini','--yolo']};
  const out={};
  for(const [cli,argv] of Object.entries(clis)){
   const tree={300:{argv:['/usr/bin/node',path.join(app,'bin','teaa.js'),'mcp','--actor',cli],parent:200,exe:'/usr/bin/node'},200:{argv,parent:1,exe:'/usr/local/bin/'+cli}};
   const o={registry,read:p=>tree[p].argv,parent:p=>tree[p].parent,executable:p=>tree[p].exe,realpath:f=>f,commandPath:()=>null,platform:'linux',env:{}};
  const via=pl.leadLevel({...o,startPid:300}),direct=pl.leadLevel({...o,startPid:200});
  out[cli]={via:via.level,agent:via.agentId,direct:direct.level};
  }
  console.log(JSON.stringify(out));`;
 try{
  const r=cp.spawnSync(process.execPath,['-e',script,root],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share')}});
  assert.equal(r.status,0,r.stderr);
  const levels=JSON.parse(r.stdout);
  for(const [cli,l] of Object.entries(levels)){assert.equal(l.agent,null,cli);assert.equal(l.via,l.direct,cli);assert.equal(l.direct,4,cli);}
  const capped=cp.spawnSync(process.execPath,['-e',`const p=require(${JSON.stringify(path.join(root,'vendor/fleet/src/lib/agents/permission-level.js'))});console.log(JSON.stringify(p.leadLevel({env:{TOOLSENABLED_LEVEL_CAP:'2'}})))`],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:home}});
  assert.equal(capped.status,0,capped.stderr);assert.equal(JSON.parse(capped.stdout).level,2);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
