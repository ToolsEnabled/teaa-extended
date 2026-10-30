'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
function fleetPin(root=ROOT){
 const file=path.join(root,'components.lock.json');const lock=JSON.parse(fs.readFileSync(fs.existsSync(file)?file:path.join(ROOT,'components.lock.json'),'utf8'));
 const pin=lock.fleet,r=pin?.runtime;
 if(!pin?.identitySha256||!r?.name||!Number.isSafeInteger(r.generation)||r.generation<1||!r.entry||!r.stateDirectory||!Array.isArray(r.workerPrograms))throw Error('The packaged Fleet runtime pin is incomplete; rebuild from components.lock.json.');
 for(const rel of [r.entry,r.securityScript,...(r.legacyEntries||[])])if(typeof rel!=='string'||path.isAbsolute(rel)||rel.split(/[\\/]/).some(x=>x==='..'||x==='.')||/[:\0\r\n]/.test(rel))throw Error('The packaged Fleet pin contains an invalid relative path.');
 if(!/^[A-Za-z0-9._-]+$/.test(r.stateDirectory))throw Error('The packaged Fleet state directory pin is invalid.');
 return pin;
}
function verifyLocalFleet(fleetRoot,pin=fleetPin()){
 const bytes=fs.readFileSync(path.join(fleetRoot,'release.json')),identitySha256=crypto.createHash('sha256').update(bytes).digest('hex');
 if(identitySha256!==pin.identitySha256)throw Object.assign(new Error('LOCAL_FLEET_IDENTITY_MISMATCH: installed Fleet bytes do not match the package pin; reinstall the verified candidate.'),{code:'LOCAL_FLEET_IDENTITY_MISMATCH'});
 return {identitySha256,pin};
}
module.exports={fleetPin,verifyLocalFleet};
