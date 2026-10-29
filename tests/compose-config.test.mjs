import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtemp,mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {renderStack} from '../deploy/compose/configure.mjs';
const commit='b'.repeat(40),image='sha256:'+'a'.repeat(64);
async function fixture(){
 const root=await mkdtemp('/tmp/pi-clean-compose-'),home=root+'/home',stack=home+'/pi-stack';
 for(const p of [home+'/projects/demo',stack+'/config',stack+'/pi-models'])await mkdir(p,{recursive:true,mode:0o700});
 const hub={home,port:19403,chatPort:19404,workspaceRoots:{projects:home+'/projects'},defaultWorkspace:{root:'projects',path:'demo'}};
 const pi={image,screenshots:{enabled:false,source:home+'/screenshots'},mounts:{ssh:false,bashrc:false,huggingface:false},volumes:{home:'test-pi-home',runtime:'test-pi-runtime',agent:'test-pi-agent',credentials:'test-pi-credentials',huggingface:'test-pi-hf'}};
 for(const [name,value] of [['hub',hub],['pi',pi]])await writeFile(stack+'/config/'+name+'.json',JSON.stringify(value),{mode:0o600});
 await writeFile(stack+'/pi-models/models.json','{"providers":{}}',{mode:0o600});
 return {root,home,stack,hub,pi};
}
test('single Compose has remote-built Hub, on-demand Pi, explicit external volumes and no host application code',async()=>{
 const f=await fixture(),out=await renderStack({root:f.stack,commit,ref:'main'}),s=out.compose.services;
 assert.deepEqual(Object.keys(s),['hub','pi']);
 assert.equal(s.hub.build.context,'https://github.com/swordfate3/pi-manager-service.git#'+commit);
 assert.equal(s.hub.build.dockerfile,'deploy/compose/Dockerfile');
 assert.equal(s.hub.container_name,'pi-stack-hub');assert.equal(s.hub.environment.PI_STACK_IN_HUB,'1');
 assert.equal(s.hub.environment.PI_STACK_ROOT,f.stack);
 assert(!s.hub.volumes.some(v=>/\/dist(?:\/|$)|node_modules|local-workbench|pi-docker/.test(v.source)));
 assert(s.hub.volumes.some(v=>v.source==='/var/run/docker.sock'));
 assert(!s.pi.volumes.some(v=>v.source==='/var/run/docker.sock'));
 assert.deepEqual(s.pi.profiles,['interactive']);assert.equal(s.pi.user,'1000:1000');
 assert.equal(s.pi.image,image);assert.equal(s.pi.volumes.filter(v=>v.type==='volume').length,5);
 assert(Object.values(out.compose.volumes).every(v=>v.external===true));
 assert(s.pi.volumes.some(v=>v.source===f.stack+'/pi-models'&&v.read_only));
 const runtime=JSON.parse(await readFile(f.stack+'/internal/hub-runtime.json','utf8'));
 assert.equal(runtime.stateRoot,f.stack+'/data/hub');assert.equal(runtime.launcher,'/opt/pi-stack/bin/pirun');
 assert.equal(runtime.hubCli,'/opt/pi-manager/dist/hub/pi-web-hub.mjs');
 assert.equal(await readFile(f.stack+'/pi-models/models.json','utf8'),'{"providers":{}}');
 const yaml=await readFile(f.stack+'/compose.yaml','utf8');assert(yaml.includes('services:'));assert(!yaml.includes('local-workbench'));
});
test('optional tunnel uses only the dedicated read-only key and existing Pi image',async()=>{
 const f=await fixture();f.hub.publicOrigin='https://pi.example.test';f.hub.tunnel={host:'192.0.2.10',user:'pi-tunnel',remotePort:13001};
 await writeFile(f.stack+'/config/hub.json',JSON.stringify(f.hub),{mode:0o600});
 for(const file of ['tunnel_ed25519','known_hosts'])await writeFile(f.stack+'/config/'+file,'isolated fixture',{mode:0o600});
 const {compose:{services:s}}=await renderStack({root:f.stack,commit,ref:'main'});
 assert.equal(s.tunnel.image,image);assert.equal(s.tunnel.entrypoint[0],'/usr/bin/ssh');
 assert(s.tunnel.command.includes('127.0.0.1:13001:127.0.0.1:19403'));
 assert.equal(s.tunnel.volumes.length,2);assert(s.tunnel.volumes.every(v=>v.read_only));
 assert(!s.hub.volumes.some(v=>v.source.endsWith('tunnel_ed25519')));
 assert(!s.pi.volumes.some(v=>v.source.endsWith('tunnel_ed25519')));
 const health=s.hub.healthcheck.test.at(-1);let checked=false;
 runInNewContext(health,{require(name){assert.equal(name,'node:http');return {get(options,ready){assert.equal(options.headers.host,'pi.example.test');assert.equal(options.port,19403);checked=true;ready({statusCode:200,resume(){}});return {setTimeout(){},on(){},destroy(){}};}};},process:{exit(code){assert.equal(code,0);}}});
 assert(checked,'health check must explicitly preserve the configured Host header');
});
test('invalid image, root and model alias fail before publishing files',async()=>{
 for(const kind of ['image','root','models']){
  const f=await fixture();
  if(kind==='image'){f.pi.image='pi-sandbox:latest';await writeFile(f.stack+'/config/pi.json',JSON.stringify(f.pi),{mode:0o600});}
  if(kind==='root'){f.hub.workspaceRoots={root:'/'};await writeFile(f.stack+'/config/hub.json',JSON.stringify(f.hub),{mode:0o600});}
  if(kind==='models'){const {rename}=await import('node:fs/promises');await rename(f.stack+'/pi-models',f.stack+'/outside');await symlink(f.stack+'/outside',f.stack+'/pi-models');}
  await assert.rejects(renderStack({root:f.stack,commit,ref:'main'}));await assert.rejects(readFile(f.stack+'/compose.yaml'),{code:'ENOENT'});
 }
});
