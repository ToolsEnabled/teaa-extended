// A durable user-selected runtime survives Codex replacing its installed plugin cache.
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
const workspace=process.env.TOOLSENGINE_CODEX_WORKSPACE, runtime=process.env.TOOLSENGINE_CODEX_RUNTIME;
try {
 if(!workspace||!isAbsolute(workspace))throw new Error('Set TOOLSENGINE_CODEX_WORKSPACE to your existing absolute project directory before starting Codex.');
 if(!runtime||!isAbsolute(runtime))throw new Error('Set TOOLSENGINE_CODEX_RUNTIME to a prepared durable ToolsEngine folder; see docs/CODEX.md. Startup installs nothing.');
 const root=fileURLToPath(new URL('../',import.meta.url));
 for(const file of ['package.json','npm-shrinkwrap.json','bin/toolsengine.js','src/artifacts.js','src/browser.js','src/browser-session.js','src/browser-url.js','src/config.js','src/desktop.js','src/extension-worker.js','src/firefox.js','src/firefox-profile.js','src/firefox-profile-transfer.js','src/server.js','src/plugin-policy.js','src/web.js','src/workspace.js','native/accessibility-desktop.cjs','native/accessibility-desktop.ps1','native/firefox-desktop.py','native/firefox-profile-transfer.py']){
  let bytes;try{bytes=await readFile(join(runtime,file));}catch{throw new Error('ToolsEngine runtime setup required: '+file+' is missing. See docs/CODEX.md.');}
  if(!bytes.equals(await readFile(join(root,file))))throw new Error('ToolsEngine runtime does not match this plugin: '+file+'. Prepare the matching branch/runtime; see docs/CODEX.md.');
 }
 // Validate from the installed plugin too: the runtime has a different PROGRAM_FOLDER.
 const {parseConfig}=await import('../src/config.js');
 await parseConfig(['--workspace',workspace,'--no-browser','--plugin-profile','openai']);
 try{createRequire(pathToFileURL(join(runtime,'package.json'))).resolve('@modelcontextprotocol/sdk/server/stdio.js');}
 catch{throw new Error('ToolsEngine runtime setup required: run npm ci --omit=dev --ignore-scripts in your chosen durable runtime folder. Startup downloads nothing.');}
 process.argv=[process.execPath,join(runtime,'bin/toolsengine.js'),'--workspace',workspace,'--no-browser','--plugin-profile','openai'];
 await import(pathToFileURL(join(runtime,'bin/toolsengine.js')).href);
}catch(error){console.error('ToolsEngine Codex: '+error.message);process.exitCode=1;}
