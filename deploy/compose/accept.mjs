// Explicit real-Docker acceptance. Synthetic home, account, agent state and
// screenshots only. Never attach production volumes or send model requests.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {renderStack,yaml} from './configure.mjs';

const [image,piImage,commit]=process.argv.slice(2);
assert(image&&/^sha256:[a-f0-9]{64}$/.test(piImage)&&/^[a-f0-9]{40}$/.test(commit),'Usage: accept.mjs HUB_IMAGE PI_IMAGE COMMIT');
const base=await mkdtemp(path.join(tmpdir(),'pi-clean-compose-accept-')),home=base+'/home',root=home+'/stack',projects=home+'/projects',workspace=projects+'/demo',source=home+'/screenshots',agent=home+'/agent';
for(const p of [workspace,source,agent,root+'/config',root+'/pi-models',root+'/internal/bin',root+'/data/memory'])await mkdir(p,{recursive:true,mode:0o700});
const env={...process.env,HOME:home,PI_STACK_ROOT:root,COMPOSE_DISABLE_ENV_FILE:'1'};
for(const k of Object.keys(env))if(k.startsWith('COMPOSE_')&&k!=='COMPOSE_DISABLE_ENV_FILE')delete env[k];
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024,env,stdio:['pipe','pipe','pipe']}).trim();
const compose=['compose','--project-name','pi-stack','--project-directory',root,'--env-file','/dev/null','-f',root+'/compose.yaml'];
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n;}
const hubPort=await port(),chatPort=await port();
await writeFile(root+'/config/hub.json',JSON.stringify({home,port:hubPort,chatPort,workspaceRoots:{projects},defaultWorkspace:{root:'projects',path:'demo'}}),{mode:0o600});
await writeFile(root+'/config/pi.json',JSON.stringify({image:piImage,screenshots:{enabled:true,source},mounts:{ssh:false,bashrc:false,huggingface:false},volumes:{home:'fixture-home',runtime:'fixture-runtime',agent:'fixture-agent',credentials:'fixture-credentials',huggingface:'fixture-hf'}}),{mode:0o600});
await writeFile(root+'/pi-models/models.json','{"providers":{}}',{mode:0o600});
await writeFile(root+'/data/memory/host-id','11111111-1111-4111-8111-111111111111\n',{mode:0o600});
await writeFile(agent+'/settings.json',JSON.stringify({extensions:['/opt/pi-web-ui/extensions/mirror-server.ts'],packages:[],skills:[]}),{mode:0o600});
const {compose:spec}=await renderStack({root,commit,ref:'acceptance',dockerGid:(await stat('/var/run/docker.sock')).gid});
// Test-only stderr capture, under synthetic data. Production intentionally
// discards extension stderr because it may contain user secrets.
await writeFile(root+'/data/test-launch','#!/usr/bin/env bash\nexec /opt/pi-stack/bin/pirun "$@" 2>>"$PI_STACK_ROOT/data/test-launch.stderr"\n',{mode:0o700});
const runtime=JSON.parse(await readFile(root+'/internal/hub-runtime.json','utf8'));runtime.launcher=root+'/data/test-launch';
await writeFile(root+'/internal/hub-runtime.json',JSON.stringify(runtime),{mode:0o600});
spec.services.hub.image=image;
// Replace ALL five external volumes, not just agent settings. This test must
// neither use production state nor create named volumes as a side effect.
spec.services.pi.volumes=spec.services.pi.volumes.filter(v=>v.type!=='volume');
spec.services.pi.volumes.push({type:'bind',source:agent,target:'/home/node/.pi/agent'});
delete spec.volumes;
await writeFile(root+'/compose.yaml',yaml(spec),{mode:0o600});
const temporary=docker(['create','--entrypoint','/bin/true',image]);
try{docker(['cp',temporary+':/opt/pi-stack/bin/.',root+'/internal/bin']);}finally{docker(['rm',temporary]);}
let cookie='',csrf='',terminal;const webIds=[],checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function http(route,body,anonymous=false){
 const response=await fetch(`http://127.0.0.1:${hubPort}${route}`,{method:body===undefined?'GET':'POST',redirect:'manual',signal:AbortSignal.timeout(6000),headers:{Origin:`http://127.0.0.1:${hubPort}`,'Content-Type':'application/json',...(!anonymous&&cookie?{Cookie:cookie}:{}),...(csrf?{'X-Pi-Local-Csrf':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:response.status,value,headers:response.headers};
}
async function waitFor(fn,message,timeout=45000){const until=Date.now()+timeout;do{const value=await fn();if(value)return value;await delay(300);}while(Date.now()<until);throw Error(message);}
try{
 assert.equal(docker(['ps','-q','--filter','name=^pi-stack-hub$']),'','Test requires the production Hub to be stopped');
 docker([...compose,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','60']);pass('remote-built single-Compose Hub is healthy');
 assert.equal((await http('/api/local/state',undefined,true)).status,401);assert.equal((await http('/s/'+'a'.repeat(32)+'/',undefined,true)).status,302);pass('anonymous management and session routes are blocked');
 csrf=(await http('/api/auth/state')).value.csrfToken;
 const login=await http('/api/auth/setup',{username:'acceptance',password:randomBytes(24).toString('hex')});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await http('/api/local/state')).value.csrfToken;
 assert.equal((await http('/api/local/browse',{root:'projects',path:'demo'})).status,200);assert.equal((await http('/api/local/browse',{root:'projects',path:'..'})).status,400);pass('login and configured workspace selection work; escapes rejected');
 for(let i=0;i<2;i++){const result=await http('/api/local/start',{key:'acceptance-'+i,workspace:{root:'projects',path:'demo'}});assert.equal(result.status,202);webIds.push(result.value.id);}
 const ready=await waitFor(async()=>{const state=(await http('/api/local/state')).value;
  await writeFile(base+'/readiness-private.json',JSON.stringify(state),{mode:0o600});
  for(const id of webIds){try{await writeFile(base+'/'+id+'.log',docker(['logs',id]),{mode:0o600});}catch{}}
  return state.runs?.filter(r=>webIds.includes(r.id)&&r.state==='ready').length===2?state:undefined;},'web-created Pi did not register');
 for(const run of ready.runs.filter(r=>webIds.includes(r.id))){
  assert.equal((await http(run.path)).status,200);
  const info=JSON.parse(docker(['inspect','--format','{"uid":{{json .Config.User}},"mounts":{{json .Mounts}}}',run.id]));assert.equal(info.uid,'1000:1000');assert(!info.mounts.some(m=>m.Source.includes('docker.sock')||m.Source.endsWith('/data/hub')));
 }
 pass('two real web-created Pi containers register; Pi has no Docker socket or Hub database');
 await writeFile(source+'/QQ_acceptance.png','synthetic screenshot fixture');
 await waitFor(async()=>{try{return (await readFile(workspace+'/.pi-attachments/latest.png','utf8'))==='synthetic screenshot fixture';}catch{return false;}},'QQ screenshot did not arrive');
 assert.equal((await http('/api/local/stop',{id:webIds[0]})).status,202);
 await waitFor(async()=>(await http('/api/local/state')).value.runs.find(r=>r.id===webIds[0])?.state==='stopped','first Pi did not stop');
 assert.equal(await readFile(workspace+'/.pi-attachments/latest.png','utf8'),'synthetic screenshot fixture');pass('first exit preserves attachments while another Pi is active');
 terminal=spawn(root+'/internal/bin/pirun',['--mode','rpc'],{cwd:workspace,env,stdio:['pipe','pipe','pipe']});let log='';
 terminal.stdout.on('data',b=>log=(log+b).slice(-16000));terminal.stderr.on('data',b=>log=(log+b).slice(-16000));
 await waitFor(async()=>{if(terminal.exitCode!==null){await writeFile(base+'/terminal-private.log',log,{mode:0o600});throw Error('terminal Pi exited; private log retained at '+base);}return (await http('/api/local/state')).value.sessions.length===2;},'terminal Pi did not join Hub');pass('terminal pirun joins the same Hub using only image-owned CLI');
 assert.equal((await http('/api/local/stop',{id:webIds[1]})).status,202);
 await waitFor(async()=>(await http('/api/local/state')).value.runs.find(r=>r.id===webIds[1])?.state==='stopped','second Pi did not stop');
 docker([...compose,'stop','hub']);
 await writeFile(source+'/QQ_after_hub_stop.png','screenshot after Hub stop');
 await waitFor(async()=>{try{return (await readFile(workspace+'/.pi-attachments/latest.png','utf8'))==='screenshot after Hub stop';}catch{return false;}},'terminal did not take over screenshot watcher');
 assert.equal(terminal.exitCode,null);pass('terminal Pi survives Hub stop and takes over shared screenshot watcher');
 docker([...compose,'up','-d','--force-recreate','--no-build','--pull','never','--wait','--wait-timeout','60']);
 assert.equal((await http('/api/local/state')).status,200);pass('SQLite account and login cookie survive Hub recreation');
 terminal.stdin.end();await waitFor(()=>terminal.exitCode!==null,'terminal did not exit');
 await waitFor(async()=>{try{await stat(workspace+'/.pi-attachments');return false;}catch(e){return e.code==='ENOENT';}},'last-exit attachment cleanup failed');pass('last Pi exit removes default attachment directory');
 await writeFile(base+'/evidence.json',JSON.stringify({image,commit,checks,date:new Date().toISOString()},null,2),{mode:0o600});console.log('Evidence: '+base+'/evidence.json');
}catch(error){try{await writeFile(base+'/hub-private.log',docker(['logs','pi-stack-hub']),{mode:0o600});}catch{}console.error('Isolated diagnostics: '+base);throw error;
}finally{
 if(terminal?.exitCode===null){terminal.stdin.end();await delay(1000);}
 for(const id of webIds){try{docker(['stop','--time','5',id]);}catch{}}
 try{docker([...compose,'down','--remove-orphans']);}catch{}
}
