#!/usr/bin/env node
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync,writeFileSync,existsSync,lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inheritedEnv } from '../src/mcp/client.js';
import { loadConfig,saveConfig } from '../src/config.js';
import { configDir,dataDir } from '../src/platform.js';
import { assertPrivateDataPath, createPrivateDataPath } from '../src/bundle.js';
import hubProfile from './hub-profile.cjs';
const {discoverRelayPair,validateAccountOrigin}=hubProfile;
import hubGateway from './hub-gateway-runtime.cjs';
import fleetPins from '../src/fleet-pin.cjs';
const FLEET_PIN=fleetPins.fleetPin();
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [cmd,...args]=process.argv.slice(2);
async function main() {
try {
 if(cmd==='hub') {
  const [action,...options]=args;
  if(!['start','status','stop'].includes(action)) throw new Error('Usage: teaa hub start|status|stop [--actor NAME] [--tree-key KEY] [--state-root DIR] [--account URL] [--relay-pair ID] [--machine NAME]');
  let actor=null,treeKey=null,stateRoot=null,accountUrl=null,relayPairId=null,machine='hub',machineProvided=false,allowInsecureLoopback=false;
  for(let i=0;i<options.length;i++) {
   const option=options[i];
   if(option==='--actor'&&!actor) actor=options[++i];
   else if(option==='--tree-key'&&!treeKey) treeKey=options[++i];
   else if(option==='--state-root'&&!stateRoot) stateRoot=options[++i];
   else if(option==='--account'&&!accountUrl&&options[i+1]&&!options[i+1].startsWith('--')) accountUrl=options[++i];
   else if(option==='--relay-pair'&&!relayPairId&&options[i+1]&&!options[i+1].startsWith('--')) relayPairId=options[++i];
   else if(option==='--machine'&&!machineProvided&&options[i+1]&&!options[i+1].startsWith('--')) {machine=options[++i];machineProvided=true;}
   else if(option==='--allow-insecure-loopback'&&!allowInsecureLoopback) allowInsecureLoopback=true;
   else throw new Error(`Unknown or duplicate Hub option: ${option}`);
  }
  if(accountUrl) validateAccountOrigin(accountUrl,allowInsecureLoopback);
  if(relayPairId&&!/^pair-[0-9a-f]{32}$/.test(relayPairId)) throw new Error('The relay pair ID is invalid');
  if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(machine)) throw new Error('The Hub gateway machine name is invalid');
  const cfg=loadConfig();
  const selectedActor=actor||cfg.mcp?.actor||'local';
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(selectedActor)) throw new Error('Invalid Fleet actor name');
  if(treeKey&&!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(treeKey)) throw new Error('Invalid Fleet Hub tree key');
  const entry=join(root,'vendor/fleet/bin/fleetV5.js');
  if(!existsSync(entry)) throw new Error('Bundled Fleet V5 entry is unavailable; reinstall the matching TEAA Extended package');
  const selectedStateRoot=stateRoot?resolve(stateRoot):join(dataDir(),FLEET_PIN.runtime.stateDirectory);
  const argv=[entry,'hub',action,'--state-root',selectedStateRoot,'--actor',selectedActor,...(treeKey?['--tree-key',treeKey]:[])];
  if(action==='stop') await hubGateway.stopGateway({dataDirectory:dataDir()});
  const result=spawnSync(process.execPath,argv,{stdio:'inherit',windowsHide:true,env:inheritedEnv(['TOOLSENABLED_'])});
  if(result.error) throw result.error;
  process.exitCode=result.status??1;
  if(process.exitCode===0&&action==='start'&&accountUrl) {
   const state=join(dataDir(),'extended/devices/default');
   const selectedTreeKey=treeKey||selectedActor;
   await hubGateway.startGateway({packageRoot:root,dataDirectory:dataDir(),state,fleetStateRoot:selectedStateRoot,
    treeKey:selectedTreeKey,runtime:process.execPath,accountUrl,relayPairId,machine,allowInsecureLoopback,
    discoverRelayPair,createPrivateDataPath,assertPrivateDataPath});
   console.log("FRA Hub gateway connected using this computer's enrolled account connection.");
  }
  if(action==='status') {
   const status=hubGateway.statusGateway({dataDirectory:dataDir()});
   console.log(`FRA Hub gateway: ${status.running?'running':'stopped'}`);
  }
 } else {
 const state=join(dataDir(),'extended/devices/default');
 if(['open','accept','status'].includes(cmd)) {
  if(cmd==='open') createPrivateDataPath(state);
  assertPrivateDataPath(state);
  const r=spawnSync(process.execPath,[join(root,'vendor/hub/remote/fra-device.cjs'),cmd,'--state',state,'--fra-core',join(root,'vendor/fra-core'),...args],{stdio:'inherit'});process.exitCode=r.status??1;
 } else if(cmd==='select-hub') {
  const state=join(dataDir(),'extended/devices/default');
  createPrivateDataPath(state);assertPrivateDataPath(state);
  const fraCore=join(root,'vendor/fra-core');
  let route;
  if(args.length===1&&!args[0].startsWith('--')) {
   route=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  } else {
   const selected=parseSelectHubOptions(args);
   validateAccountOrigin(selected.accountUrl,selected.allowInsecureLoopback);
   const relayPairId=selected.relayPairId||await discoverRelayPair({accountUrl:selected.accountUrl,state,fraCore,
    allowInsecureLoopback:selected.allowInsecureLoopback});
   route={transports:['fra'],fra:{accountUrl:selected.accountUrl,origin:selected.accountUrl,relayPairId,
    ...(selected.allowInsecureLoopback?{allowInsecureLoopback:true}:{})}};
  }
  if(!Array.isArray(route.transports)||route.transports.length!==1||route.transports[0]!=='fra'||!route.fra||typeof route.fra!=='object') throw new Error('Select exactly one FRA transport with an explicit paired gateway profile');
  route.fra={...route.fra,state,fraCore};
  route.fleetRoot=join(root,'vendor/fleet');route.fleetStateRoot=join(dataDir(),FLEET_PIN.runtime.stateDirectory);
  const target=join(configDir(),'extended/hub.json');createPrivateDataPath(dirname(target));assertPrivateDataPath(dirname(target));if(existsSync(target)&&(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink()))throw new Error('Hub profile path must be a regular file without links');writeFileSync(target,JSON.stringify(route,null,2)+'\n',{mode:0o600});
  const cfg=loadConfig(); if(!cfg.extended?.localFleet) cfg.extended={localFleet:cfg.fleet};
  cfg.fleet={enabled:true,command:process.execPath,args:[join(root,'bin/hub-client.cjs'),'--config',target],env:{}};
  saveConfig(cfg);console.log('Selected one Hub Fleet upstream; ToolsEngine and Knowledge remain local.');
 } else if(cmd==='select-local') {
  const cfg=loadConfig();if(!cfg.extended?.localFleet)throw new Error('No saved local Fleet profile');cfg.fleet=cfg.extended.localFleet;delete cfg.extended;saveConfig(cfg);console.log('Selected local Fleet upstream.');
 } else {throw new Error('Usage: teaa open|accept|status [device flags], select-hub CONFIG|--account URL [--relay-pair ID], select-local');}
 }
} catch(e){console.error('TEAA Extended: '+e.message);process.exitCode=1;}
}

function parseSelectHubOptions(options) {
 let accountUrl=null,relayPairId=null,allowInsecureLoopback=false;
 for(let i=0;i<options.length;i++) {
  const option=options[i];
  if(option==='--account'&&!accountUrl&&options[i+1]&&!options[i+1].startsWith('--')) accountUrl=options[++i];
  else if(option==='--relay-pair'&&!relayPairId&&options[i+1]&&!options[i+1].startsWith('--')) relayPairId=options[++i];
  else if(option==='--allow-insecure-loopback'&&!allowInsecureLoopback) allowInsecureLoopback=true;
  else throw new Error('Usage: teaa select-hub --account URL [--relay-pair ID] [--allow-insecure-loopback]');
 }
 if(!accountUrl) throw new Error('Usage: teaa select-hub --account URL [--relay-pair ID] [--allow-insecure-loopback]');
 if(relayPairId&&!/^pair-[0-9a-f]{32}$/.test(relayPairId)) throw new Error('The relay pair ID is invalid');
 return {accountUrl,relayPairId,allowInsecureLoopback};
}

main();
