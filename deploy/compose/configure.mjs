import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,readFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const REPOSITORY='https://github.com/swordfate3/pi-manager-service.git';
const inside=(child,parent)=>child===parent||child.startsWith(parent+path.sep);
function absolute(p){assert(typeof p==='string'&&path.isAbsolute(p)&&p!=='/'&&path.normalize(p)===p&&!/[\0\r\n$:]/.test(p),'Invalid absolute path');return p;}
async function optional(p){try{return await lstat(p);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
async function privateJson(file){
 const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await f.stat();assert(s.isFile()&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.nlink===1&&s.size<=32768,'Unsafe private configuration');return JSON.parse(await f.readFile('utf8'));}finally{await f.close();}
}
async function atomic(file,body){
 const old=await optional(file);if(old)assert(old.isFile()&&!old.isSymbolicLink()&&old.uid===process.getuid()&&old.nlink===1,'Unsafe generated output');
 const tmp=file+'.'+randomBytes(8).toString('hex');const h=await open(tmp,'wx',0o600);
 try{await h.writeFile(body);await h.sync();}finally{await h.close();}
 try{await rename(tmp,file);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
// JSON strings are valid YAML scalars. Explicit indentation keeps the generated
// Compose readable without adding a YAML package to the deployment tooling.
export function yaml(value,depth=0){
 const pad='  '.repeat(depth);
 if(Array.isArray(value))return value.map(v=>v&&typeof v==='object'?pad+'-\n'+yaml(v,depth+1):pad+'- '+JSON.stringify(v)+'\n').join('');
 return Object.entries(value).map(([k,v])=>v&&typeof v==='object'?(Object.keys(v).length?pad+k+':\n'+yaml(v,depth+1):pad+k+': '+(Array.isArray(v)?'[]':'{}')+'\n'):pad+k+': '+JSON.stringify(v)+'\n').join('');
}
export async function renderStack({root,commit,ref='main',dockerGid}){
 absolute(root);assert.equal(await realpath(root),root);assert.match(commit,/^[a-f0-9]{40}$/);
 assert(typeof ref==='string'&&ref.length<=128&&/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(ref)&&!ref.includes('..'),'Invalid remote ref');
 const hub=await privateJson(root+'/config/hub.json'),pi=await privateJson(root+'/config/pi.json');
 const home=absolute(hub.home),roots=hub.workspaceRoots;
 assert(roots&&typeof roots==='object'&&!Array.isArray(roots)&&Object.keys(roots).length>0&&Object.keys(roots).length<=32);
 for(const [name,p] of Object.entries(roots)){
  assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);absolute(p);
  assert(p!==home&&inside(p,home)&&!inside(p,root)&&await realpath(p)===p&&(await lstat(p)).isDirectory(),'Workspace root must be a canonical child of home');
 }
 assert(hub.defaultWorkspace&&Object.hasOwn(roots,hub.defaultWorkspace.root));
 assert(typeof hub.defaultWorkspace.path==='string'&&!path.isAbsolute(hub.defaultWorkspace.path)&&!hub.defaultWorkspace.path.split('/').includes('..'));
 for(const p of [hub.port,hub.chatPort])assert(Number.isInteger(p)&&p>=1024&&p<=65535);assert.notEqual(hub.port,hub.chatPort);
 if(hub.publicOrigin){const u=new URL(hub.publicOrigin);assert(u.protocol==='https:'&&u.origin===hub.publicOrigin&&!u.username&&!u.password);}
 assert.match(pi.image,/^sha256:[a-f0-9]{64}$/,'Pi must use an immutable image');
 assert(pi.screenshots&&typeof pi.screenshots.enabled==='boolean');absolute(pi.screenshots.source);
 assert(pi.mounts&&['ssh','bashrc','huggingface'].every(k=>typeof pi.mounts[k]==='boolean'));
 const volumeKeys=['home','runtime','agent','credentials','huggingface'];
 assert(pi.volumes&&volumeKeys.every(k=>typeof pi.volumes[k]==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(pi.volumes[k])));
 assert.equal(new Set(volumeKeys.map(k=>pi.volumes[k])).size,5);
 const models=root+'/pi-models';assert.equal(await realpath(models),models,'Model aliases are not supported');assert((await lstat(models)).isDirectory());
 const modelFile=models+'/models.json',modelInfo=await lstat(modelFile);assert(modelInfo.isFile()&&!modelInfo.isSymbolicLink()&&modelInfo.size<=1024*1024);
 JSON.parse(await readFile(modelFile,'utf8'));
 const bind=(source,readOnly=false,target=source)=>({type:'bind',source,target,read_only:readOnly,bind:{create_host_path:false}});
 const binds=[bind(root+'/compose.yaml',true),bind(root+'/config',true),bind(root+'/internal/hub-runtime.json',true),bind(models,true),bind(root+'/data'),...Object.values(roots).map(p=>bind(p))];
 for(const [flag,p] of [['ssh',home+'/.ssh'],['bashrc',home+'/.bashrc'],['huggingface',home+'/.cache/huggingface/token']])if(pi.mounts[flag]&&await optional(p)){assert.equal(await realpath(p),p,'Credential aliases are not supported');binds.push(bind(p,true));}
 if(pi.screenshots.enabled){assert((await lstat(pi.screenshots.source)).isDirectory());assert.equal(await realpath(pi.screenshots.source),pi.screenshots.source);binds.push(bind(pi.screenshots.source,true));}
 const socket=await optional('/var/run/docker.sock');dockerGid??=socket?.gid??1001;assert(Number.isSafeInteger(dockerGid)&&dockerGid>=0);
 binds.push(bind('/var/run/docker.sock'));
 const common={network_mode:'host',cap_drop:['ALL'],security_opt:['no-new-privileges:true'],logging:{driver:'json-file',options:{'max-size':'5m','max-file':'2'}}};
 const environment={HOME:home,NODE_ENV:'production',PI_STACK_ROOT:root,PI_STACK_IN_HUB:'1'};
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SUB2API_OPENAI_API_KEY','SUB2API_DEEPSEEK_API_KEY','SUB2API_ZHIPU_API_KEY'])environment[key]='${'+key+':-}';
 const image='pi-stack-hub:'+commit.slice(0,12);
 const compose={name:'pi-stack',services:{hub:{...common,image,build:{context:REPOSITORY+'#'+commit,dockerfile:'deploy/compose/Dockerfile',args:{SOURCE_COMMIT:commit}},container_name:'pi-stack-hub',user:'1000:1000',group_add:[String(dockerGid)],init:true,pid:'host',restart:'unless-stopped',read_only:true,mem_limit:'768m',cpus:2,pids_limit:256,stop_grace_period:'30s',environment,
  command:['--config',root+'/internal/hub-runtime.json'],volumes:binds,tmpfs:['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'],
  healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:${hub.port}/api/auth/state',{headers:{host:${JSON.stringify(hub.publicOrigin?new URL(hub.publicOrigin).host:`127.0.0.1:${hub.port}`)}},signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],interval:'10s',timeout:'4s',start_period:'10s',retries:3}},
  pi:{...common,profiles:['interactive'],image:pi.image,user:'1000:1000',working_dir:'/workspace',stdin_open:true,tty:true,mem_limit:'4g',pids_limit:512,
   environment:{HOME:'/home/node',GIT_CONFIG_GLOBAL:'/home/node/.credentials/gitconfig',NPM_CONFIG_USERCONFIG:'/home/node/.credentials/npmrc',PI_CODING_AGENT_DIR:'/home/node/.pi/agent',PI_CC_SWITCH_MODELS_DIR:'/run/cc-switch-pi-models',HF_HOME:'/home/node/.cache/huggingface',HF_HUB_CACHE:'/home/node/.cache/huggingface/hub'},
   volumes:[bind(models,true,'/run/cc-switch-pi-models'),...volumeKeys.map((k,i)=>({type:'volume',source:'pi-'+k,target:['/home/node','/home/node/.local','/home/node/.pi','/home/node/.credentials','/home/node/.cache/huggingface'][i],volume:{nocopy:true}}))]}
 },volumes:Object.fromEntries(volumeKeys.map(k=>['pi-'+k,{external:true,name:pi.volumes[k]}]))};
 if(hub.tunnel){
  const t=hub.tunnel;assert(hub.publicOrigin&&typeof t.host==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(t.host));assert.match(t.user,/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);assert(Number.isInteger(t.remotePort)&&t.remotePort>=1024&&t.remotePort<=65535);
  const key=root+'/config/tunnel_ed25519',hosts=root+'/config/known_hosts';
  for(const p of [key,hosts]){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077));}
  compose.services.tunnel={...common,image:pi.image,container_name:'pi-stack-tunnel',user:'1000:1000',restart:'unless-stopped',read_only:true,mem_limit:'128m',pids_limit:32,depends_on:{hub:{condition:'service_healthy'}},entrypoint:['/usr/bin/ssh'],command:['-F','/dev/null','-N','-T','-i','/run/secrets/tunnel_ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/run/secrets/known_hosts','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R',`127.0.0.1:${t.remotePort}:127.0.0.1:${hub.port}`,`${t.user}@${t.host}`],volumes:[bind(key,true,'/run/secrets/tunnel_ed25519'),bind(hosts,true,'/run/secrets/known_hosts')]};
 }
 const runtime={port:hub.port,chatPort:hub.chatPort,home,workspaceRoots:roots,defaultWorkspace:hub.defaultWorkspace,stateRoot:root+'/data/hub',launcher:'/opt/pi-stack/bin/pirun',hubCli:'/opt/pi-manager/dist/hub/pi-web-hub.mjs',dockerExecutable:'/usr/bin/docker',protectedRoots:[root],...(hub.publicOrigin?{publicOrigin:hub.publicOrigin}:{})};
 for(const dir of ['internal','data','data/hub','data/memory','data/screenshots']){await mkdir(root+'/'+dir,{recursive:true,mode:0o700});const s=await lstat(root+'/'+dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077),'Unsafe automatic data directory');}
 await atomic(root+'/internal/hub-runtime.json',JSON.stringify(runtime,null,2)+'\n');
 await atomic(root+'/compose.yaml','# Generated from config/hub.json and config/pi.json. Regenerate with pi-dockerctl configure.\n'+yaml(compose));
 await atomic(root+'/internal/release.json',JSON.stringify({repository:REPOSITORY,ref,commit,image},null,2)+'\n');
 return {compose,image,commit};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i+=2){const key={'--root':'root','--commit':'commit','--ref':'ref','--docker-gid':'dockerGid'}[args[i]];assert(key&&args[i+1]);o[key]=key==='dockerGid'?Number(args[i+1]):args[i+1];}
 renderStack(o).then(r=>console.log(JSON.stringify({image:r.image,commit:r.commit,services:Object.keys(r.compose.services)}))).catch(()=>{console.error('Configuration refused; private values were not printed.');process.exitCode=1;});
}
