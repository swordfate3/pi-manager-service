// Explicit, one-time, stopped-host migration. Never called during normal start.
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {readFile,lstat,realpath,mkdir,rename,copyFile,cp,writeFile,chmod,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function optional(p){try{return await lstat(p);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
async function regular(p){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid());return s;}
export async function migrateHost({root,assets,commit,ref,image,tunnel,screenshotSource,verifyStopped}){
 assert(path.isAbsolute(root)&&root!=='/'&&await realpath(root)===root&&(await lstat(root)).uid===process.getuid());
 assert.match(commit,/^[a-f0-9]{40}$/);assert.equal(image,'pi-stack-hub:'+commit.slice(0,12));
 assert(typeof verifyStopped==='function'&&await verifyStopped(),'Stop services before migrating');
 assert(!await optional(root+'/data')&&!await optional(root+'/internal'),'Refusing to overwrite a migrated deployment');
 const old=JSON.parse(await readFile(root+'/local-workbench/config/config.json','utf8'));
 assert.equal(old.stateRoot,root+'/local-workbench/state','Unexpected state location; no files changed');
 const receipt=JSON.parse(await readFile(root+'/config/stack.json','utf8'));assert.match(receipt.piImage,/^sha256:[a-f0-9]{64}$/);
 for(const p of [root+'/pi-models/models.json',root+'/state/pi-scoped-memory/host-id',old.stateRoot+'/manager.sqlite3'])await regular(p);
 assert.equal(await realpath(root+'/pi-models'),root+'/pi-models');
 const model=await readFile(root+'/pi-models/models.json'),memory=await readFile(root+'/state/pi-scoped-memory/host-id'),login=await readFile(old.stateRoot+'/manager.sqlite3');JSON.parse(model);
 for(const p of ['control.py','configure.mjs','README.md','bin/pirun'])await regular(assets+'/'+p);
 const key=old.home+'/.config/pi-web/tunnel_ed25519',hosts=old.home+'/.ssh/known_hosts';for(const p of [key,hosts])await regular(p);
 assert(tunnel&&typeof tunnel.host==='string'&&typeof tunnel.user==='string'&&Number.isInteger(tunnel.remotePort));
 assert(typeof screenshotSource==='string'&&path.isAbsolute(screenshotSource)&&screenshotSource!=='/'&&path.normalize(screenshotSource)===screenshotSource,'Pass the screenshot source explicitly');
 const shotInfo=await optional(screenshotSource);if(shotInfo)assert(shotInfo.isDirectory()&&await realpath(screenshotSource)===screenshotSource);
 const archive=root+'/archive/stopped-deployment-'+new Date().toISOString().replaceAll(/[:.]/g,'-');await mkdir(archive,{recursive:true,mode:0o700});
 await writeFile(archive+'/login-database.snapshot',login,{flag:'wx',mode:0o600});
 await writeFile(archive+'/migration.json',JSON.stringify({commit,ref,image,modelSha256:hash(model),memorySha256:hash(memory),loginSha256:hash(login)},null,2)+'\n',{mode:0o600});
 // Rename whole old branches, including private split-UID role state. No old
 // branch is read by the new launcher or mounted into the new Hub.
 for(const name of ['README.md','compose.yaml','config','docs','images','local-workbench','packages','runtime','scripts','state','systemd','tests','backup'])if(await optional(root+'/'+name))await rename(root+'/'+name,archive+'/'+name);
 for(const name of ['config','data','data/memory','data/screenshots','internal'])await mkdir(root+'/'+name,{recursive:true,mode:0o700});
 await rename(archive+'/local-workbench/state',root+'/data/hub');
 await writeFile(root+'/data/memory/host-id',memory,{flag:'wx',mode:0o600});
 const hub={home:old.home,port:old.port,chatPort:old.chatPort,workspaceRoots:old.workspaceRoots,defaultWorkspace:old.defaultWorkspace,...(old.publicOrigin?{publicOrigin:old.publicOrigin}:{}),tunnel};
 const pi={image:receipt.piImage,screenshots:{enabled:!!shotInfo,source:screenshotSource},mounts:{ssh:true,bashrc:true,huggingface:true},volumes:{home:'pi-user-home',runtime:'pi-runtime',agent:'pi-home',credentials:'pi-credentials',huggingface:'pi-huggingface-cache'}};
 for(const [file,value] of [['config/hub.json',hub],['config/pi.json',pi],['internal/release.json',{repository:'https://github.com/swordfate3/pi-manager-service.git',ref,commit,image}]])await writeFile(root+'/'+file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 for(const [source,target] of [[key,'tunnel_ed25519'],[hosts,'known_hosts']]){await copyFile(source,root+'/config/'+target,constants.COPYFILE_EXCL);await chmod(root+'/config/'+target,0o600);}
 for(const file of ['control.py','configure.mjs'])await copyFile(assets+'/'+file,root+'/internal/'+file,constants.COPYFILE_EXCL);
 await cp(assets+'/bin',root+'/internal/bin',{recursive:true,errorOnExist:true,force:false});
 for(const file of await readdir(root+'/internal/bin'))await chmod(root+'/internal/bin/'+file,0o755);
 await copyFile(assets+'/README.md',root+'/README.md',constants.COPYFILE_EXCL);
 await writeFile(root+'/internal/bin/pi-dockerctl','#!/usr/bin/env bash\nset -Eeuo pipefail\nscript_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"\nexec python3 "$script_dir/../control.py" "$@"\n',{mode:0o755,flag:'wx'});
 assert.equal(hash(await readFile(root+'/pi-models/models.json')),hash(model));
 assert.equal(hash(await readFile(root+'/data/hub/manager.sqlite3')),hash(login));
 assert.equal(hash(await readFile(root+'/data/memory/host-id')),hash(memory));
 return {archive,modelContentsPreserved:true,loginDatabasePreserved:true,memoryIdentityPreserved:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [root,assets,commit,ref,host,user,remotePort,screenshotSource]=process.argv.slice(2);
 migrateHost({root,assets,commit,ref,image:'pi-stack-hub:'+commit.slice(0,12),tunnel:{host,user,remotePort:Number(remotePort)},screenshotSource,verifyStopped:async()=>{
  const names=execFileSync('docker',['ps','--format','{{.Names}}'],{encoding:'utf8'}).trim().split('\n');
  return !names.some(n=>/^pi-stack-|^pi-local-|^pi-web-hub$|^pi-deploy-gate$/.test(n));
 }}).then(v=>console.log(JSON.stringify(v))).catch(()=>{console.error('Migration refused/failed; inspect the private archive. No credentials printed.');process.exitCode=1;});
}
