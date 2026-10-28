// One-time, socket-free provisioning helper for the existing local pi-stack.
// This installation-specific helper never emits credentials or changes Pi volumes.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,chown,chmod,copyFile,rename} from 'node:fs/promises';
import path from 'node:path';
assert.equal(process.getuid(),0);
const root='/stack',hostRoot='/home/fate/docker_files/pi-stack';
const [image,daemonId,requesterOrigin]=process.argv.slice(2);
assert.match(image,/^sha256:[a-f0-9]{64}$/); assert.match(daemonId,/^[A-Za-z0-9:_-]{1,128}$/);
assert.ok(['http://127.0.0.1:18301','https://pi-admin.swordfate.cn'].includes(requesterOrigin));
const marker=JSON.parse(await readFile(`${root}/state/provision-owner.json`,'utf8'));assert.equal(marker.format,'pi-stack-2026-10-27');
const read=async p=>JSON.parse(await readFile(`${root}/${p}`,'utf8'));
const executor=await read('config/manager/executor/config.json');assert.equal(executor.docker,null);assert.deepEqual(executor.workspaces,{});
const chat=await read('config/manager/chat/config.json');assert.equal(chat.provisioning,undefined);
const requester=await read('config/manager/public/config.json');
const backup='backup/create-pi-20261027';
await mkdir(`${root}/${backup}`,{mode:0o700});await chown(`${root}/${backup}`,1000,1000);
for(const role of ['executor','chat','public','admin']){
 const p=`config/manager/${role}/config.json`;const target=`${root}/${backup}/${role}-config.json`;
 await copyFile(`${root}/${p}`,target);await chmod(target,0o600);await chown(target,0,0);
}
const dir=async(p,uid,gid,mode)=>{await mkdir(`${root}/${p}`,{mode});const s=await lstat(`${root}/${p}`);assert.ok(s.isDirectory()&&!s.isSymbolicLink());await chown(`${root}/${p}`,uid,gid);await chmod(`${root}/${p}`,mode);};
await dir('state/manager/docker',21001,21001,0o700);
await dir('state/manager/enrollment',1000,22004,0o2750);
const token=randomBytes(32).toString('hex');
const authority=`${root}/config/manager/executor/enrollment-authority.json`;
await writeFile(authority,JSON.stringify({token})+'\n',{flag:'wx',mode:0o600});await chown(authority,21001,21001);
const save=async(p,value,uid)=>{const dest=`${root}/${p}`,temp=dest+'.create-pi-new';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o400});await chown(temp,uid,uid);await rename(temp,dest);};
executor.workspaceBrowser={home:'/home/fate',defaultRoot:'gitproject'};
executor.docker={socketPath:'/var/run/docker.sock',daemonId,image,pathCoordinates:'host',
 stateRoot:`${hostRoot}/state/manager/docker`,workspaceRoots:{gitproject:'/home/fate/gitproject'},
 protectedRoots:['/home/fate/gitproject/codex_project_v2'],timeoutMs:60000,startupTimeoutMs:60000,
 web:{packageRoot:`${hostRoot}/packages/web-v1-61bc365`,port:18310,
  enrollment:{socketPath:`${hostRoot}/state/manager/enrollment/broker.sock`,authorityFile:'/manager/config/enrollment-authority.json',
   registryHostDirectory:`${hostRoot}/state/manager/chat-runtime`,exportHostDirectory:`${hostRoot}/state/manager/chat-exports`}},
 runtimeProfile:{runtimeVolume:'pi-runtime',modelsFile:'/home/fate/docker_files/pi-docker/pi-models/models.json'}};
chat.provisioning={socketPath:'/run/pi-enrollment/broker.sock',exportDir:'/chat/exports',tokenHash:createHash('sha256').update(token).digest('hex'),socketMode:0o660};
chat.managerLinks={requester:requesterOrigin+'/',administrator:'http://127.0.0.1:18302/'};
requester.origin=requesterOrigin;
await save('config/manager/executor/config.json',executor,21001);
await save('config/manager/chat/config.json',chat,1000);
await save('config/manager/public/config.json',requester,21002);
console.log(JSON.stringify({enabled:true,root:'gitproject',executorUid:21001,enrollmentGid:22004,piUid:1000,requesterOrigin,administratorOrigin:'http://127.0.0.1:18302',backup:`${hostRoot}/${backup}`,credentialsPrinted:false}));
