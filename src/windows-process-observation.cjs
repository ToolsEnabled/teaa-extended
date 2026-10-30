'use strict';
// Read-only observation of same-user ancestors. Windows WMI policy is not
// required. The helper checks token owner, creation order and live handles;
// this table does not authorize killing or modifying any process.
const path=require('node:path'),{spawnSync}=require('node:child_process');
function readOwnWindowsProcesses({startPid,run=spawnSync,env=process.env}={}) {
 const unavailable=()=>Object.assign(new Error('Windows own-user process observation is unavailable.'),{code:'HUB_PROCESS_OBSERVATION_UNAVAILABLE'});
 if(!Number.isSafeInteger(startPid)||startPid<2)throw unavailable();
 const shell=path.win32.join(env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const result=run(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-own-processes.ps1'),'-StartPid',String(startPid)],{encoding:'utf8',env,windowsHide:true,shell:false,timeout:10000,maxBuffer:2*1024*1024});
 if(result.error||result.signal||result.status!==0)throw unavailable();
 let rows;try{rows=JSON.parse(result.stdout.replace(/^\uFEFF/,''));}catch{throw unavailable();}
 if(!Array.isArray(rows)||!rows.length||rows.length>16||rows.some(x=>!Number.isSafeInteger(x.pid)||x.pid<2||!Number.isSafeInteger(x.ppid)||x.ppid<0||!/^win32:\d{12,20}$/.test(x.startTime)||typeof x.executable!=='string'||x.executable.length>32768||!Array.isArray(x.argv)||!x.argv.length||x.argv.length>4096||x.argv.some(w=>typeof w!=='string'||w.length>65536)))throw unavailable();
 const table=new Map(rows.map(x=>[x.pid,x]));if(table.size!==rows.length||!table.has(startPid))throw unavailable();return table;
}
module.exports={readOwnWindowsProcesses};
