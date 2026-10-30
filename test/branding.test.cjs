const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
test('new command, MCP identity and per-user roots are explicit',async()=>{
 const {configDir,dataDir}=await import('../src/platform.js');const env={XDG_CONFIG_HOME:'/private/config',XDG_DATA_HOME:'/private/data',APPDATA:'C:\\private\\Roaming',LOCALAPPDATA:'C:\\private\\Local'};
 assert.equal(path.basename(configDir(env)),'toolsenabled-agent-kit');assert.equal(path.basename(dataDir(env)),'toolsenabled-agent-kit');assert.deepEqual(pkg.bin,{'teaa':'bin/teaa.js'});
 const h=cp.spawnSync(process.execPath,[path.join(root,'bin/teaa.js'),'--help'],{encoding:'utf8'});assert.equal(h.status,0);assert.match(h.stdout,/TEAA/);assert.match(h.stdout,/teaa mcp/);
 const {Gateway}=await import('../src/mcp/gateway.js');const g=new Gateway({upstreams:[]});assert.ok(g.listTools().some(x=>x.name==='teaa_status'));assert.match(g.instructions(),/TEAA/);
});
test('retired preview paths are never imported on new installs',async()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'teaa-fresh-'));const old=String.fromCharCode(122,117,115,101);const oldConfig=path.join(d,'config',old);fs.mkdirSync(oldConfig,{recursive:true});fs.writeFileSync(path.join(oldConfig,'config.json'),'{malformed sentinel that must not be opened');
 const before=fs.readFileSync(path.join(oldConfig,'config.json'));const script=`const {loadConfig}=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root,'src/config.js')).href)});const c=loadConfig();console.log(c._path);`;
 const r=cp.spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:d,env:{...process.env,HOME:d,USERPROFILE:d,APPDATA:path.join(d,'roaming'),LOCALAPPDATA:path.join(d,'local'),XDG_CONFIG_HOME:path.join(d,'config'),XDG_DATA_HOME:path.join(d,'data')},encoding:'utf8'});
 try{assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/toolsenabled-agent-kit/);assert.deepEqual(fs.readFileSync(path.join(oldConfig,'config.json')),before);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
