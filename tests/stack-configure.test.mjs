import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {configureWorkbench} from '../deploy/stack/configure.mjs';

async function fixture(){
  const base=await mkdtemp(path.join(tmpdir(),'pi-stack-container-'));
  const home=path.join(base,'home'),stack=path.join(home,'docker_files/pi-stack'),projects=path.join(home,'gitproject');
  for(const dir of [projects,path.join(stack,'local-workbench/config'),path.join(stack,'local-workbench/state'),path.join(stack,'config'),path.join(stack,'state/pi-scoped-memory')]) await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(path.join(stack,'compose.yaml'),'services: {}\n');
  const config={port:19403,chatPort:19404,home,workspaceRoots:{projects},defaultWorkspace:{root:'projects',path:'.'},stateRoot:path.join(stack,'local-workbench/state'),launcher:path.join(stack,'scripts/pirun'),hubCli:path.join(stack,'local-workbench/dist/hub/pi-web-hub.mjs'),publicOrigin:'https://pi.example.test'};
  const file=path.join(stack,'local-workbench/config/config.json');
  await writeFile(file,JSON.stringify(config),{mode:0o600});
  return {base,home,stack,projects,config,file};
}
test('container renderer preserves private state/origin and does not mount local built bundles or the entire home',async()=>{
  const f=await fixture(),before=await readFile(f.file,'utf8');
  await configureWorkbench({stack:f.stack,image:'sha256:'+'a'.repeat(64),dockerGid:1001,uid:process.getuid(),gid:process.getgid(),legacyQQ:[]});
  assert.equal(await readFile(f.file,'utf8'),before);
  const compose=JSON.parse(await readFile(path.join(f.stack,'workbench.compose.json'),'utf8')),s=compose.services.workbench;
  assert.equal(s.image,'${PI_WORKBENCH_IMAGE:?Select a recorded workbench image}');
  assert.equal(s.user,`${process.getuid()}:${process.getgid()}`);assert.deepEqual(s.group_add,['1001']);
  assert.equal(s.network_mode,'host');assert.equal(s.pid,'host');assert.equal(s.read_only,true);assert.deepEqual(s.cap_drop,['ALL']);
  assert(s.volumes.some(v=>v.source===f.projects&&v.target===f.projects&&!v.read_only));
  assert(s.volumes.some(v=>v.source===f.config.stateRoot&&v.target===f.config.stateRoot&&!v.read_only));
  assert(!s.volumes.some(v=>[f.home,'/','/home','/tmp'].includes(v.source)));
  assert(!s.volumes.some(v=>v.source.includes('/dist')||v.source.includes('node_modules')));
  const runtime=JSON.parse(await readFile(path.join(f.stack,'local-workbench/config/container-config.json'),'utf8'));
  assert.equal(runtime.publicOrigin,'https://pi.example.test');assert.equal(runtime.stateRoot,f.config.stateRoot);
  assert.equal(runtime.launcher,'/opt/pi-manager/deploy/stack/scripts/pirun');assert.equal(runtime.hubCli,'/opt/pi-manager/dist/hub/pi-web-hub.mjs');
});
test('optional screenshot, SSH, bashrc and token binds are exact and read-only',async()=>{
  const f=await fixture();for(const dir of ['.ssh','shots','.cache/huggingface'])await mkdir(path.join(f.home,dir),{recursive:true});
  await writeFile(path.join(f.home,'.bashrc'),'# no secret fixture\n');await writeFile(path.join(f.home,'.cache/huggingface/token'),'test-only',{mode:0o600});
  await configureWorkbench({stack:f.stack,image:'test:one',dockerGid:1001,screenshotSource:path.join(f.home,'shots'),legacyQQ:[]});
  const {services:{workbench:s}}=JSON.parse(await readFile(path.join(f.stack,'workbench.compose.json'),'utf8'));
  for(const part of ['.ssh','.bashrc','shots','.cache/huggingface/token'])assert(s.volumes.some(v=>v.source===path.join(f.home,part)&&v.read_only));
  assert(!JSON.stringify(s).includes('test-only'));assert(!s.volumes.some(v=>v.source.endsWith('/.env')));
});
test('reconfiguration does not replace previous deployment image or mutate durable data',async()=>{
  const f=await fixture();const marker=path.join(f.config.stateRoot,'marker');await writeFile(marker,'durable');
  await configureWorkbench({stack:f.stack,image:'test:one',dockerGid:1001,legacyQQ:[]});
  await configureWorkbench({stack:f.stack,image:'test:two',dockerGid:1001,legacyQQ:[]});
  assert.equal(JSON.parse(await readFile(path.join(f.stack,'local-workbench/config/container.json'),'utf8')).image,'test:one');
  assert.equal(await readFile(marker,'utf8'),'durable');
});
test('invalid root paths, Docker group and container names fail without publishing deployment config',async()=>{
  for(const changes of [{dockerGid:-1},{containerName:'bad/name'},{composeProject:'../x'}]){
    const f=await fixture();await assert.rejects(configureWorkbench({stack:f.stack,image:'test:one',dockerGid:1001,legacyQQ:[],...changes}));
    await assert.rejects(readFile(path.join(f.stack,'workbench.compose.json')),{code:'ENOENT'});
  }
  const f=await fixture();f.config.workspaceRoots={escape:'/'};await writeFile(f.file,JSON.stringify(f.config),{mode:0o600});
  await assert.rejects(configureWorkbench({stack:f.stack,image:'test:one',dockerGid:1001,legacyQQ:[]}));
});
test('resolved model symlink target is explicitly available at identical absolute host path',async()=>{
  const f=await fixture();const {symlink}=await import('node:fs/promises'),models=path.join(f.home,'models');await mkdir(models);await symlink(models,path.join(f.stack,'config/pi-models'));
  await configureWorkbench({stack:f.stack,image:'test:one',dockerGid:1001,legacyQQ:[]});
  const {services:{workbench:s}}=JSON.parse(await readFile(path.join(f.stack,'workbench.compose.json'),'utf8'));
  assert(s.volumes.some(v=>v.source===models&&v.target===models&&v.read_only));
});
