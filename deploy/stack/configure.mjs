import {constants} from 'node:fs';
import {mkdir,open,lstat,realpath,readFile,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

const APP='/opt/pi-manager';
const fail=message=>{throw new Error(message);};
function absolute(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\0\r\n$]/u.test(value)||path.normalize(value)!==value||value==='/')fail('Expected a safe absolute path');
  return value;
}
const within=(child,parent)=>child===parent||child.startsWith(parent+path.sep);
async function exists(file){try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
async function privateJson(file){
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await handle.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>16384)fail('Unsafe private configuration');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
}
async function atomic(file,value){
  const old=await exists(file);if(old&&(!old.isFile()||old.isSymbolicLink()||old.uid!==process.getuid()||old.nlink!==1))fail('Unsafe output file');
  const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  try{await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
}
async function ownedDirectory(directory){
  await mkdir(directory,{recursive:true,mode:0o700});const s=await lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))fail('State directory must be private and owned by the deployment user');
}
async function legacyScreenshotBinds(uid){
  const result=[];
  for(const entry of await readdir('/tmp',{withFileTypes:true})){
    if(!entry.isDirectory()||!/^pi-qq-bridge-[a-f0-9]{16}\.lifecycle$/.test(entry.name))continue;
    const directory=path.join('/tmp',entry.name),s=await lstat(directory);if(s.uid!==uid)continue;
    result.push(directory);
    const stem=directory.slice(0,-'.lifecycle'.length);
    for(const suffix of ['.lock','.log']){
      const candidate=stem+suffix,info=await exists(candidate);
      if(info&&(info.isSymbolicLink()||!info.isFile()||info.uid!==uid))fail('Unsafe legacy screenshot runtime');
      if(!info){const h=await open(candidate,'ax',0o600);await h.close();}
      result.push(candidate);
    }
  }
  return result;
}

/** Render host coordinates explicitly: Docker bind sources are resolved by the host daemon. */
export async function configureWorkbench(options){
  const stack=absolute(options.stack);if(await realpath(stack)!==stack)fail('Stack path must be canonical');
  const uid=options.uid??process.getuid(),gid=options.gid??process.getgid(),dockerGid=options.dockerGid;
  if(![uid,gid,dockerGid].every(n=>Number.isSafeInteger(n)&&n>=0))fail('Invalid UID/GID');
  const containerName=options.containerName??'pi-stack-workbench',composeProject=options.composeProject??'pi-workbench';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(composeProject))fail('Invalid container/project name');
  if(typeof options.image!=='string'||!/^([a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255})$/.test(options.image))fail('Invalid image');
  const configDir=path.join(stack,'local-workbench/config'),config=await privateJson(path.join(configDir,'config.json'));
  const home=absolute(config.home),state=absolute(config.stateRoot),roots=Object.values(config.workspaceRoots??{});
  if(!roots.length||roots.length>32)fail('Missing workspace roots');
  for(const root of roots){absolute(root);if(root===home||!within(root,home)||await realpath(root)!==root)fail('Workspace roots must be canonical children of home');}
  for(const key of ['port','chatPort'])if(!Number.isInteger(config[key])||config[key]<1024||config[key]>65535)fail('Invalid workbench port');
  if(config.port===config.chatPort||roots.some(root=>within(state,root)||within(root,state)))fail('Overlapping state/workspace paths');
  const runtimeConfig={...config,launcher:APP+'/deploy/stack/scripts/pirun',hubCli:APP+'/dist/hub/pi-web-hub.mjs',dockerExecutable:'/usr/bin/docker'};
  const binds=new Map();
  function bind(source,readOnly=false){absolute(source);const previous=binds.get(source);if(previous&&previous.read_only!==readOnly)fail('Conflicting mount permissions');binds.set(source,{type:'bind',source,target:source,read_only:readOnly,bind:{create_host_path:false}});}
  bind(path.join(stack,'compose.yaml'),true);bind(path.join(stack,'config'),true);bind(configDir,true);bind(state);
  const memory=path.join(stack,'state/pi-scoped-memory'),qqRuntime=path.join(stack,'state/qq-runtime');
  for(const directory of [memory,qqRuntime,state])await ownedDirectory(directory);
  bind(memory);bind(qqRuntime);for(const root of roots)bind(root);
  const models=path.join(stack,'config/pi-models');if(await exists(models)){const actual=await realpath(models);if(!within(actual,path.join(stack,'config')))bind(actual,true);}
  const optional=[options.screenshotSource??'/mnt/c/Users/fate/AppData/Local/Temp',path.join(home,'.ssh'),path.join(home,'.bashrc'),path.join(home,'.cache/huggingface/token')];
  for(const candidate of optional){absolute(candidate);if(await exists(candidate)){const actual=await realpath(candidate);if(actual!==candidate)fail('Optional mounts must not be symlinks');bind(candidate,true);}}
  const legacy=options.legacyQQ??await legacyScreenshotBinds(uid);
  for(const candidate of legacy){if(!/^\/tmp\/pi-qq-bridge-[a-f0-9]{16}(?:\.lifecycle|\.lock|\.log)$/.test(candidate))fail('Invalid legacy screenshot bind');const s=await lstat(candidate);if(s.isSymbolicLink()||s.uid!==uid)fail('Unsafe legacy screenshot bind');bind(candidate);}
  bind('/var/run/docker.sock');
  const environment={HOME:home,NODE_ENV:'production',PI_PIRUN_CONFIG_DIR:stack,PI_PIRUN_IN_WORKBENCH:'1',PI_PIRUN_DOCKER_BIN:'/usr/bin/docker',PI_QQ_RUNTIME_DIR:qqRuntime};
  if(options.screenshotSource)environment.PI_QQ_SOURCE_DIR=options.screenshotSource;
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SUB2API_OPENAI_API_KEY','SUB2API_DEEPSEEK_API_KEY','SUB2API_ZHIPU_API_KEY'])environment[key]='${'+key+':-}';
  const compose={name:composeProject,services:{workbench:{image:'${PI_WORKBENCH_IMAGE:?Select a recorded workbench image}',container_name:containerName,
    user:`${uid}:${gid}`,group_add:[String(dockerGid)],init:true,network_mode:'host',pid:'host',restart:'unless-stopped',read_only:true,
    cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'768m',cpus:2,pids_limit:256,stop_grace_period:'30s',
    command:['--config',path.join(configDir,'container-config.json')],environment,volumes:[...binds.values()],
    tmpfs:['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'],
    healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:${config.port}/api/auth/state',{headers:{host:${JSON.stringify(config.publicOrigin?new URL(config.publicOrigin).host:`127.0.0.1:${config.port}`)}},signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],interval:'10s',timeout:'4s',start_period:'15s',retries:3},
    logging:{driver:'json-file',options:{'max-size':'5m','max-file':'2'}}}}};
  const receiptPath=path.join(configDir,'container.json'),existing=await exists(receiptPath);
  if(existing)await privateJson(receiptPath);
  await atomic(path.join(configDir,'container-config.json'),runtimeConfig);await atomic(path.join(stack,'workbench.compose.json'),compose);
  if(!existing)await atomic(receiptPath,{image:options.image,commit:options.commit??null,containerName,composeProject});
  return {composeFile:path.join(stack,'workbench.compose.json'),configFile:path.join(configDir,'container-config.json'),receiptFile:receiptPath,containerName,composeProject};
}

async function main(args){
  const options={};for(let i=0;i<args.length;i+=2){const key={'--stack':'stack','--image':'image','--docker-gid':'dockerGid','--container-name':'containerName','--project':'composeProject','--screenshot-source':'screenshotSource'}[args[i]];if(!key||!args[i+1])fail('Usage: configure.mjs --stack ABS --image IMAGE --docker-gid GID');options[key]=key==='dockerGid'?Number(args[i+1]):args[i+1];}
  console.log(JSON.stringify(await configureWorkbench(options)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
