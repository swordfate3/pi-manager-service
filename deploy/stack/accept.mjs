// Explicit Docker acceptance: NEW containers and private temporary state only.
// No production volumes, credentials, model requests or public gateway changes.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {configureWorkbench} from './configure.mjs';

const args=process.argv.slice(2);
assert(args.length===4&&args[0]==='--image'&&args[2]==='--pi-image','Usage: accept.mjs --image IMAGE --pi-image IMMUTABLE_PI_IMAGE');
const image=args[1],piImage=args[3];assert.match(piImage,/^sha256:[a-f0-9]{64}$/);
const root=await mkdtemp(path.join(tmpdir(),'pi-remote-compose-accept-')),home=path.join(root,'home'),stack=path.join(home,'stack'),projects=path.join(home,'projects'),workspace=path.join(projects,'demo'),source=path.join(home,'screenshots'),agent=path.join(home,'isolated-pi-agent');
for(const directory of [workspace,source,agent,path.join(stack,'local-workbench/config'),path.join(stack,'local-workbench/state'),path.join(stack,'scripts'),path.join(stack,'config/pi-models'),path.join(stack,'state/pi-scoped-memory')])await mkdir(directory,{recursive:true,mode:0o700});
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const port=await freePort(),chatPort=await freePort(),containerName='pi-workbench-test-'+randomBytes(6).toString('hex'),project='pi-wb-test-'+randomBytes(6).toString('hex');
const config={port,chatPort,home,workspaceRoots:{projects},defaultWorkspace:{root:'projects',path:'demo'},stateRoot:path.join(stack,'local-workbench/state'),launcher:path.join(stack,'scripts/pirun'),hubCli:'/unused/host-hub.mjs',protectedRoots:[stack]};
await writeFile(path.join(stack,'local-workbench/config/config.json'),JSON.stringify(config),{mode:0o600});
await writeFile(path.join(stack,'config/stack.json'),JSON.stringify({piImage}),{mode:0o600});
// No production named volumes or saved settings: the Pi agent state is wholly synthetic.
await writeFile(path.join(agent,'settings.json'),JSON.stringify({extensions:['/opt/pi-web-ui/extensions/mirror-server.ts'],packages:[],skills:[]}),{mode:0o600});
const piCompose={name:project,services:{pi:{image:piImage,user:`${process.getuid()}:${process.getgid()}`,network_mode:'host',working_dir:'/workspace',stdin_open:true,tty:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'1g',pids_limit:128,
 environment:{HOME:'/home/node',PI_CODING_AGENT_DIR:'/home/node/.pi',PI_CC_SWITCH_MODELS_DIR:'/run/cc-switch-pi-models'},volumes:[
  {type:'bind',source:'${PI_PIRUN_HOST_WORKSPACE}',target:'/workspace'},
  {type:'bind',source:agent,target:'/home/node/.pi'},
  {type:'bind',source:path.join(stack,'config/pi-models'),target:'/run/cc-switch-pi-models',read_only:true}],
 logging:{driver:'json-file',options:{'max-size':'2m','max-file':'1'}}}}};
await writeFile(path.join(stack,'compose.yaml'),JSON.stringify(piCompose));
for(const entry of await readdir(new URL('./scripts/',import.meta.url))){const target=path.join(stack,'scripts',entry);await copyFile(new URL('./scripts/'+entry,import.meta.url),target);await chmod(target,0o755);}
await configureWorkbench({stack,image,dockerGid:(await stat('/var/run/docker.sock')).gid,containerName,composeProject:project,screenshotSource:source,legacyQQ:[]});
// Agent settings are mounted into synthetic Pi; the workbench itself does not need them.
const composeFile=path.join(stack,'workbench.compose.json'),compose=JSON.parse(await readFile(composeFile));
compose.services.workbench.environment.PI_PIRUN_SKIP_BASHRC='1';
compose.services.workbench.environment.PI_PIRUN_SSH='off';
compose.services.workbench.environment.PI_PIRUN_MOUNT_BASHRC='off';
compose.services.workbench.environment.PI_PIRUN_VSCODE='off';
await writeFile(composeFile,JSON.stringify(compose),{mode:0o600});
const docker=(argv)=>execFileSync('docker',argv,{encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024,env:{...process.env,COMPOSE_DISABLE_ENV_FILE:'1',PI_WORKBENCH_IMAGE:image}}).trim();
const composeArgs=['compose','--project-name',project,'--project-directory',stack,'--env-file','/dev/null','-f',composeFile];
let cookie='',csrf='',terminal,webIds=[];const checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function http(route,body,anonymous=false){return new Promise((resolve,reject)=>{
 const req=request(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json',...(!anonymous&&cookie?{Cookie:cookie}:{}),...(csrf?{'X-Pi-Local-Csrf':csrf}:{})}},res=>{
 let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:res.statusCode,value,headers:res.headers});});});req.setTimeout(6000,()=>req.destroy(new Error('acceptance HTTP timeout')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
async function waitFor(fn,message,timeout=45000){const end=Date.now()+timeout;do{const value=await fn();if(value)return value;await delay(250);}while(Date.now()<end);throw Error(message);}
try{
 docker([...composeArgs,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','60','workbench']);pass('remote-built workbench container is healthy');
 assert.equal((await http('/api/local/state',undefined,true)).status,401);assert.equal((await http('/s/'+'a'.repeat(32)+'/',undefined,true)).status,302);pass('anonymous management and session access remains blocked');
 csrf=(await http('/api/auth/state')).value.csrfToken;
 const login=await http('/api/auth/setup',{username:'acceptance',password:randomBytes(24).toString('hex')});assert.equal(login.status,200);cookie=login.headers['set-cookie'][0].split(';')[0];csrf=(await http('/api/local/state')).value.csrfToken;
 assert.equal((await http('/api/local/browse',{root:'projects',path:'demo'})).status,200);assert.equal((await http('/api/local/browse',{root:'projects',path:'..'})).status,400);pass('authenticated configured workspace browsing rejects escapes');
 for(let i=0;i<2;i++){const response=await http('/api/local/start',{key:'test-'+i,workspace:{root:'projects',path:'demo'}});assert.equal(response.status,202);webIds.push(response.value.id);}
 const ready=await waitFor(async()=>{const s=(await http('/api/local/state')).value;return s.runs?.filter(r=>webIds.includes(r.id)&&r.state==='ready').length===2?s:undefined;},'two isolated real Pi containers did not register');
 for(const run of ready.runs.filter(r=>webIds.includes(r.id))){assert.equal((await http(run.path)).status,200);const info=JSON.parse(docker(['inspect','--format','{"uid":{{json .Config.User}},"mounts":{{json .Mounts}},"security":{{json .HostConfig.SecurityOpt}}}',run.id]));assert.equal(info.uid,`${process.getuid()}:${process.getgid()}`);assert(!info.mounts.some(m=>m.Source.includes('docker.sock')));assert(info.security.some(v=>v.startsWith('no-new-privileges')));}
 pass('web-created real Pi instances register with individual credentials; ordinary Pi has no Docker socket');
 await writeFile(path.join(source,'QQ_acceptance.png'),Buffer.from('isolated screenshot fixture'));
 await waitFor(async()=>{try{return (await readFile(path.join(workspace,'.pi-attachments/latest.png'))).toString()==='isolated screenshot fixture';}catch{return false;}},'QQ screenshot was not mirrored');
 assert.equal((await http('/api/local/stop',{id:webIds[0]})).status,202);
 await waitFor(async()=>!(await http('/api/local/state')).value.runs.some(r=>r.id===webIds[0]),'first Pi did not stop');
 assert.equal((await readFile(path.join(workspace,'.pi-attachments/latest.png'))).toString(),'isolated screenshot fixture');pass('stopping one of two same-workspace Pi preserves shared screenshots');
 // The host-side helper deliberately points at a missing local Hub bundle.
 terminal=spawn(path.join(stack,'scripts/pirun'),['--mode','rpc'],{cwd:workspace,env:{...process.env,HOME:home,PI_PIRUN_SKIP_BASHRC:'1',PI_PIRUN_SSH:'off',PI_PIRUN_MOUNT_BASHRC:'off',PI_PIRUN_VSCODE:'off',PI_QQ_SOURCE_DIR:source},stdio:['pipe','pipe','pipe']});
 let terminalLog='';terminal.stdout.on('data',b=>terminalLog=(terminalLog+b).slice(-16000));terminal.stderr.on('data',b=>terminalLog=(terminalLog+b).slice(-16000));
 await waitFor(async()=>{if(terminal.exitCode!==null){await writeFile(path.join(root,'terminal-private.log'),terminalLog,{mode:0o600});throw Error('host terminal Pi exited; private diagnostics retained');}return (await http('/api/local/state')).value.sessions.length===2;},'host terminal Pi did not join container Hub');
 pass('host terminal pirun registers through container CLI with no host-built Hub bundle');
 assert.equal((await http('/api/local/stop',{id:webIds[1]})).status,202);
 await waitFor(async()=>!(await http('/api/local/state')).value.runs.some(r=>r.id===webIds[1]),'second Pi did not stop');
 assert.equal((await readFile(path.join(workspace,'.pi-attachments/latest.png'))).toString(),'isolated screenshot fixture');
 terminal.stdin.end();await waitFor(()=>terminal.exitCode!==null,'host terminal Pi did not exit');
 await waitFor(async()=>{try{await stat(path.join(workspace,'.pi-attachments'));return false;}catch(error){return error.code==='ENOENT';}},'last-exit screenshot cleanup did not finish');pass('host and container launchers share reference counts; last exit removes default attachment directory');
 docker([...composeArgs,'restart','workbench']);await waitFor(async()=>{try{return (await http('/api/local/state')).status===200;}catch{return false;}},'cookie/login did not survive workbench restart');pass('SQLite login and durable account survive container restart');
 await writeFile(path.join(root,'evidence.json'),JSON.stringify({image,piImage,checks,passed:checks.length,date:new Date().toISOString()},null,2),{mode:0o600});
 console.log('Evidence: '+path.join(root,'evidence.json'));
}catch(error){
 try{await writeFile(path.join(root,'workbench-private.log'),docker(['logs',containerName]),{mode:0o600});}catch{}
 throw error;
}finally{
 if(terminal?.exitCode===null){terminal.stdin.end();await delay(1000);}
 for(const id of webIds){try{const name=docker(['inspect','--format','{{.Name}}',id]);if(name==='/'+id)docker(['stop','--time','5',id]);}catch{}}
 try{docker([...composeArgs,'down','--remove-orphans']);}catch{}
}
