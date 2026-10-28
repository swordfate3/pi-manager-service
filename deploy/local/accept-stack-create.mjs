// Explicit live acceptance: creates/stops only this run's precisely named Pi.
// No model prompt, production conversation reads, or foreign-container writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {request} from 'node:http';
const require=createRequire(import.meta.url);
const WebSocket=require('../../node_modules/ws');
const stack='/home/fate/docker_files/pi-stack',origin='https://pi-admin.swordfate.cn';
const evidenceFile=process.argv[2];assert.match(evidenceFile??'',/^\/tmp\/pi-manager-create-[A-Za-z0-9_-]+\/live-acceptance\.json$/);
const target='hub-check-'+randomBytes(5).toString('hex');
const relative='pi-manager-create-check-20261027-'+randomBytes(4).toString('hex');
const workspace='/home/fate/gitproject/'+relative;
// This contains no secrets; the separate executor UID must be able to browse it.
mkdirSync(workspace,{mode:0o755});
const credential=JSON.parse(readFileSync(`${stack}/config/manager/operator/requester-credential.json`)).credential;
const administrator=JSON.parse(readFileSync(`${stack}/config/manager/operator/administrator-credential.json`)).credential;
const docker=(...a)=>execFileSync('docker',a,{encoding:'utf8',maxBuffer:4*1024*1024});
const snapshot=()=>{const ids=docker('ps','-aq').trim().split(/\s+/).filter(Boolean);return ids.length?JSON.parse(docker('inspect',...ids)).map(c=>({id:c.Id,name:c.Name,started:c.State.StartedAt,running:c.State.Running,restarts:c.RestartCount})):[];};
const baseline=snapshot();
const report={at:new Date().toISOString(),target,workspace,checks:[],baseline,cleanup:'not attempted'};
const save=()=>writeFileSync(evidenceFile,JSON.stringify(report,null,2),{mode:0o600});save();
async function http(port,route,body,token){
 const domain=port===18301?origin:`http://127.0.0.1:${port}`;
 return new Promise((resolve,reject)=>{
  const r=request(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{Host:new URL(domain).host,Origin:domain,...(token?{'X-Pi-Manager-Token':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(8000)},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8');let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:response.statusCode,value});
   });
  });r.on('error',reject);r.end(body===undefined?undefined:JSON.stringify(body));
 });
}
const check=s=>{report.checks.push(s);save();console.log('PASS '+s);};
async function until(fn,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await delay(300);}throw Error('acceptance deadline');}
let sessionToken,own;
try{
 const cap=await http(18301,'/api/manager/capabilities',undefined,credential);assert.equal(cap.status,200);assert.equal(cap.value.docker,true);assert.equal(cap.value.enrollment,true);
 const browse=await http(18301,'/api/manager/workspaces/browse',{root:'gitproject',path:''},credential);assert.equal(browse.status,200);assert.ok(browse.value.directories.some(d=>d.name===relative));assert.ok(!browse.value.directories.some(d=>d.name==='codex_project_v2'));
 assert.equal((await http(18301,'/api/manager/workspaces/browse',{root:'gitproject',path:'..'},credential)).status,400);check('enabled backend, real workspace browse and protected/traversal denial');
 const payload={key:'accept-create-'+target,action:'create',target,workspace:{root:'gitproject',path:relative}};
 const pending=await http(18301,'/api/manager/tasks',payload,credential);assert.equal(pending.status,202);assert.equal(pending.value.state,'pending_approval');report.createTaskId=pending.value.id;save();
 assert.equal((await http(18301,'/api/manager/tasks',payload,credential)).value.id,pending.value.id);
 assert.equal((await http(18301,'/api/manager/approve',{taskId:pending.value.id},credential)).status,403);
 assert.ok(!docker('ps','-a','--format','{{.Names}}').includes('pi-manager-'+pending.value.id.replaceAll('-','')));check('request stays pending, idempotency works, requester cannot approve');
 const login=await http(18302,'/api/manager/login',{credential:administrator});assert.equal(login.status,200);sessionToken=login.value.sessionToken;
 async function approve(task){
  assert.equal(task.target,target);
  const reviewed=await http(18302,`/api/manager/tasks/${task.id}/review`,undefined,sessionToken);assert.equal(reviewed.status,200);assert.equal(reviewed.value.task.id,task.id);assert.equal(reviewed.value.task.target,target);
  if(task.action==='create')assert.deepEqual(reviewed.value.task.payload,{workspace:payload.workspace});
  const accepted=await http(18302,'/api/manager/approve',reviewed.value.binding,sessionToken);assert.equal(accepted.status,200);
  return until(async()=>{const r=await http(18301,`/api/manager/tasks/${task.id}`,undefined,credential);assert.equal(r.status,200);if(['failed','unknown','cancelled'].includes(r.value.state)){report.failureTask=r.value;save();throw Error(`acceptance task ${task.action} ${r.value.state}`);}return r.value.state==='succeeded'&&r.value;});
 }
 await approve(pending.value);check('independent administrator review and create approval succeeded');
 const candidates=JSON.parse(docker('inspect',...docker('ps','-aq').trim().split(/\s+/))).filter(c=>c.Config.Labels?.['cn.swordfate.pi-manager.instance']===target);assert.equal(candidates.length,1);own=candidates[0];assert.ok(!baseline.some(c=>c.id===own.Id));
 report.containerId=own.Id;report.containerName=own.Name;report.homeVolume=own.Mounts.find(m=>m.Destination==='/home/node')?.Name;save();
 assert.equal(own.Config.User,'1000:1000');assert.equal(own.HostConfig.ReadonlyRootfs,true);assert.deepEqual(own.HostConfig.CapDrop,['ALL']);assert.ok(own.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
 assert.equal(own.Mounts.find(m=>m.Destination==='/workspace').Source,workspace);assert.equal(own.Mounts.find(m=>m.Destination==='/home/node/.local').RW,false);
 assert.equal(own.Mounts.find(m=>m.Destination==='/home/node/.pi/manager-agent/models.json').RW,false);assert.ok(!own.Mounts.some(m=>m.Destination.includes('docker.sock')));assert.ok(!own.Mounts.some(m=>m.Destination.includes('.credentials')));
 docker('exec',own.Id,'node','-e',"const fs=require('fs');fs.writeFileSync('/workspace/.pi-manager-acceptance','UID1000 verification\\n');fs.writeFileSync('/home/node/.pi/manager-agent/.acceptance-permission','ok');");
 assert.equal(statSync(workspace+'/.pi-manager-acceptance').uid,1000);check('one owned Pi: UID1000, exact workspace, private persistent home, readonly runtime/models, no Docker/host credentials');
 const list=await http(18300,'/api/sessions');const registered=list.value.sessions.find(s=>s.label===target);assert.ok(registered);report.sessionPath=registered.path;save();assert.equal((await http(18300,registered.path)).status,200);
 await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:18300${registered.path}ws`,{origin:'http://127.0.0.1:18300',maxPayload:64*1024*1024});const timer=setTimeout(()=>{ws.terminate();reject(Error('state_sync deadline'));},10000);ws.on('error',reject);ws.on('message',data=>{try{const value=JSON.parse(data.toString());if(value.event==='state_sync'){clearTimeout(timer);ws.close();resolve();}}catch{}});});check('new Pi is listed, HTML opens and WebSocket sends state_sync without a model prompt');
 const stop=await http(18301,'/api/manager/tasks',{key:'accept-stop-'+target,action:'stop',target},credential);assert.equal(stop.status,202);report.stopTaskId=stop.value.id;save();await approve(stop.value);
 const [stopped]=JSON.parse(docker('inspect',own.Id));assert.equal(stopped.State.Running,false);assert.equal(stopped.Mounts.find(m=>m.Destination==='/home/node').Name,report.homeVolume);report.cleanup='acceptance Pi stopped by approved task; independent home retained';check('approved stop preserves exact container and home');
 const after=snapshot();for(const c of baseline)assert.deepEqual(after.find(a=>a.id===c.id),c,`existing container changed: ${c.name}`);check('all baseline container IDs/start/running/restart states unchanged');
 report.completed=true;save();console.log(JSON.stringify({completed:true,evidenceFile,createTaskId:report.createTaskId,stopTaskId:report.stopTaskId,container:report.containerName,stopped:true,homeRetained:true}));
}catch(error){report.error=String(error.message);save();console.error('Live acceptance failed; private evidence retained at '+evidenceFile);process.exitCode=1;}
finally{if(sessionToken)await http(18302,'/api/manager/logout',{},sessionToken).catch(()=>{});}
