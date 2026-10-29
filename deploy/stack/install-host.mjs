// Explicit deployment installer. Does NOT stop/start services or initialize accounts.
import {copyFile,mkdir,readFile,lstat,chmod,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {configureWorkbench} from './configure.mjs';

export async function installHost({stack,image,commit,ref='main',repository='https://github.com/swordfate3/pi-manager-service.git',dockerGid,legacyQQ,screenshotSource}){
 if(!/^sha256:[a-f0-9]{64}$/.test(image)||!/^[a-f0-9]{40}$/.test(commit))throw Error('A verified immutable image and full remote commit are required');
 const backup=path.join(stack,'backup','remote-compose-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'));
 await mkdir(backup,{recursive:true,mode:0o700});
 const saved=[];
 const files=['compose.yaml','scripts/pi-pirun','scripts/pi-dockerctl','scripts/pi-web-hub-session','scripts/host-identity.sh','scripts/pi-qq-lifecycle.sh','scripts/pi-qq-bridge','scripts/pirun','scripts/pi-workbench-update.mjs','local-workbench/config/config.json','local-workbench/config/container.json','local-workbench/config/container-config.json','workbench.compose.json','systemd/pi-local-workbench.service'];
 for(const relative of files){const source=path.join(stack,relative);let info;try{info=await lstat(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('Unsafe existing deployment file');const target=path.join(backup,relative);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(source,target);await chmod(target,0o600);saved.push(relative);}
 const config=JSON.parse(await readFile(path.join(stack,'local-workbench/config/config.json'),'utf8'));
 const database=path.join(config.stateRoot,'manager.sqlite3');
 try{const info=await lstat(database);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('Unsafe database');const db=new DatabaseSync(database);try{db.exec(`VACUUM INTO '${path.join(backup,'manager.sqlite3').replaceAll("'","''")}'`);}finally{db.close();}await chmod(path.join(backup,'manager.sqlite3'),0o600);}catch(error){if(error.code!=='ENOENT')throw error;}
 // Validate/render first; existing original config and durable state are preserved.
 const result=await configureWorkbench({stack,image,commit,dockerGid,legacyQQ,screenshotSource});
 const sourceRoot=path.dirname(fileURLToPath(import.meta.url));
 for(const name of ['host-identity.sh','pi-dockerctl','pi-pirun','pi-qq-bridge','pi-qq-lifecycle.sh','pi-web-hub-session','pirun']){await copyFile(path.join(sourceRoot,'scripts',name),path.join(stack,'scripts',name));await chmod(path.join(stack,'scripts',name),0o755);}
 await mkdir(path.join(stack,'scripts/workbench'),{recursive:true,mode:0o700});
 for(const name of ['configure.mjs','prepare-start.mjs'])await copyFile(path.join(sourceRoot,name),path.join(stack,'scripts/workbench',name));
 await copyFile(path.join(sourceRoot,'update.mjs'),path.join(stack,'scripts/pi-workbench-update.mjs'));await chmod(path.join(stack,'scripts/pi-workbench-update.mjs'),0o700);
 // Do not replace a receipt belonging to an existing container deployment.
 const receipt=JSON.parse(await readFile(result.receiptFile,'utf8'));
 if(receipt.image===image&&receipt.commit===commit&&!receipt.repository){receipt.repository=repository;receipt.ref=ref;await writeFile(result.receiptFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});}
 await writeFile(path.join(backup,'migration.json'),JSON.stringify({created:new Date().toISOString(),image,commit,ref,saved},null,2)+'\n',{mode:0o600});
 return {...result,backup};
}
async function main(args){const options={};for(let i=0;i<args.length;i+=2){const key={'--stack':'stack','--image':'image','--commit':'commit','--ref':'ref','--repository':'repository','--docker-gid':'dockerGid','--screenshot-source':'screenshotSource'}[args[i]];if(!key||!args[i+1])throw Error('Usage: install-host.mjs --stack ABS --image sha256:ID --commit FULLSHA --docker-gid GID');options[key]=key==='dockerGid'?Number(args[i+1]):args[i+1];}console.log(JSON.stringify(await installHost(options)));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error('Host deployment installation failed: '+error.message);process.exitCode=1;});
