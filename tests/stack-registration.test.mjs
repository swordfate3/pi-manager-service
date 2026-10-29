import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const helper=path.resolve('deploy/stack/scripts/pi-web-hub-session');
test('host registration invokes the recorded container CLI without requiring a locally built Hub',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pi-container-register-')),configDir=path.join(root,'local-workbench/config'),state=path.join(root,'state'),runtime=path.join(root,'runtime'),runs=path.join(root,'launches');
 for(const dir of [configDir,state,runtime,runs])await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(path.join(configDir,'container.json'),JSON.stringify({containerName:'pi-test-workbench'}),{mode:0o600});
 const config=path.join(configDir,'chat.json');await writeFile(config,JSON.stringify({host:'127.0.0.1',port:19404,stateDir:state,runtimeDir:runtime}),{mode:0o600});
 const cli=path.join(root,'nonexistent-local-hub.mjs'),fake=path.join(root,'docker');
 await writeFile(fake,'#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"revoked":True,"argv":sys.argv[1:]}))\n');await chmod(fake,0o755);
 const env={...process.env,PI_PIRUN_CONFIG_DIR:root,PI_PIRUN_WEB_HUB_HOST_CONFIG:config,PI_PIRUN_WEB_HUB_HOST_CLI:cli,PI_PIRUN_WEB_HUB_RUNS_DIR:runs,PI_PIRUN_DOCKER_BIN:fake};
 const source='import importlib.machinery,json\nm=importlib.machinery.SourceFileLoader("helper",'+JSON.stringify(helper)+').load_module()\nprint(json.dumps(m.hub_command("revoke","--run-id","a"*32)))';
 const reply=JSON.parse(execFileSync('python3',['-c',source],{encoding:'utf8',env}));
 assert.equal(reply.revoked,true);assert.deepEqual(reply.argv,['exec','--user',`${process.getuid()}:${process.getgid()}`,'pi-test-workbench','node','/opt/pi-manager/dist/hub/pi-web-hub.mjs','revoke','--config',config,'--run-id','a'.repeat(32)]);
 // A tampered receipt must not turn container selection into arbitrary argv.
 await writeFile(path.join(configDir,'container.json'),JSON.stringify({containerName:'x --privileged'}),{mode:0o600});
 assert.throws(()=>execFileSync('python3',['-c',source],{encoding:'utf8',env,stdio:'pipe'}));
});
