import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'pi-stack-control-'));await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'local-workbench/config'),{recursive:true});
 const control=path.join(root,'scripts/pi-dockerctl');await copyFile('deploy/stack/scripts/pi-dockerctl',control);
 await writeFile(path.join(root,'local-workbench/config/container.json'),JSON.stringify({image:'sha256:'+'a'.repeat(64),containerName:'pi-test-workbench',composeProject:'pi-test'}),{mode:0o600});
 const fake=path.join(root,'docker'),output=path.join(root,'calls.jsonl');
 await writeFile(fake,'#!/usr/bin/env python3\nimport os,json,sys\nwith open(os.environ["CAPTURE"],"a") as f: f.write(json.dumps({"args":sys.argv[1:],"image":os.getenv("PI_WORKBENCH_IMAGE"),"noenv":os.getenv("COMPOSE_DISABLE_ENV_FILE"),"override":os.getenv("COMPOSE_FILE")})+"\\n")\n');await chmod(fake,0o755);
 return {root,control,output,env:{...process.env,CAPTURE:output,PI_PIRUN_DOCKER_BIN:fake,COMPOSE_FILE:'/untrusted/override.yaml'}};
}
test('local up/status/down target only the recorded workbench Compose service and ignore ambient overrides',async()=>{
 const f=await fixture();for(const action of ['up','status','logs','down'])execFileSync('bash',[f.control,'local',action],{env:f.env});
 const calls=(await readFile(f.output,'utf8')).trim().split('\n').map(JSON.parse);
 for(const call of calls){assert.equal(call.args[0],'compose');assert(call.args.includes(path.join(f.root,'workbench.compose.json')));assert(call.args.includes('workbench'));assert.equal(call.image,'sha256:'+'a'.repeat(64));assert.equal(call.noenv,'1');assert.equal(call.override,null);assert(!call.args.includes('-v'));}
 assert(calls[0].args.includes('--no-build'));assert(calls[0].args.includes('--wait'));assert(calls[3].args.includes('stop'));
});
test('update and rollback forward to the updater without requiring a development checkout',async()=>{
 const f=await fixture();await writeFile(path.join(f.root,'scripts/pi-workbench-update.mjs'),'console.log(JSON.stringify(process.argv.slice(2)));');
 for(const action of ['update','rollback']){
  const args=JSON.parse(execFileSync('bash',[f.control,action],{env:f.env,encoding:'utf8'}));assert.deepEqual(args,[action,'--stack',f.root]);
 }
});
