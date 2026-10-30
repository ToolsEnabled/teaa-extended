// Standalone MCP only: explicit, local transfer after the user's request.
// The OpenAI plugin entry always selects --no-browser and offers no such tool.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ensureAgentFirefoxProfile} from './firefox-profile.js';

export const FLEET_PROFILE_TRANSFER_SETTING='browser.agent_firefox_profile_transfer';
export function fleetProfileTransferAllowed(settings={}){
  const values=settings?.values||settings;
  if(!Object.hasOwn(values,FLEET_PROFILE_TRANSFER_SETTING))return true;
  return [true,1,'true','1','on','enabled','allow'].includes(values[FLEET_PROFILE_TRANSFER_SETTING]);
}
export async function loadFleetSettings(config={}){
  if(config.fleetSettings)return config.fleetSettings;
  const file=config.fleetSettingsPath||process.env.TOOLSENABLED_SETTINGS||path.join(config.home||os.homedir(),'.toolsenabled-host','services','settings.json');
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {};throw error;}
}
export async function locateUserFirefoxProfile(home=os.homedir(),explicit){
  if(explicit)return path.resolve(explicit);
  for(const root of [path.join(home,'.mozilla','firefox'),path.join(home,'snap','firefox','common','.mozilla','firefox')]){
    let ini;try{ini=await fs.readFile(path.join(root,'profiles.ini'),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const profiles=ini.split(/\n(?=\[)/).filter(block=>block.startsWith('[Profile')).map(block=>{
      const value=/^Path=(.+)$/m.exec(block)?.[1]?.trim();
      return value?{value,relative:!/^IsRelative=0\r?$/m.test(block),default:/^Default=1\r?$/m.test(block)}:null;
    }).filter(Boolean);
    const install=/^Default=(.+)$/m.exec(ini.split(/\n(?=\[Profile)/)[0])?.[1]?.trim();
    const selected=profiles.find(p=>p.default)||profiles.find(p=>p.value===install)||(profiles.length===1?profiles[0]:null);
    if(selected)return selected.relative?path.resolve(root,selected.value):path.resolve(selected.value);
    if(install&&install!=='1')return path.resolve(root,install);
    throw new Error('Firefox has several profiles without a default; name the source profile explicitly.');
  }
  throw new Error('No Firefox source profile was found.');
}
export async function transferUserFirefoxProfile({fleetSettings,userProfileDir,agentProfileDir}={}){
  if(!fleetProfileTransferAllowed(fleetSettings))throw new Error('Fleet settings disable Firefox profile transfer. No source profile was read.');
  const target=await ensureAgentFirefoxProfile(agentProfileDir);
  try{
    const {stdout}=await promisify(execFile)('/usr/bin/python3',['-B',fileURLToPath(new URL('../native/firefox-profile-transfer.py',import.meta.url)),path.resolve(userProfileDir),target],{timeout:30000,maxBuffer:8192});
    return JSON.parse(stdout);
  }catch(error){throw new Error(error.stderr?.trim()||'Firefox profile transfer failed or timed out; credential values were not returned.');}
}
