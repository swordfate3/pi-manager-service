import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {installHost} from '../deploy/stack/install-host.mjs';

test('explicit container migration installs launch helpers and consistent private backup without replacing config or database',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'pi-stack-host-install-')),home=path.join(base,'home'),stack=path.join(home,'stack'),state=path.join(stack,'local-workbench/state'),configDir=path.join(stack,'local-workbench/config'),projects=path.join(home,'projects');
 for(const directory of [state,configDir,projects,path.join(stack,'scripts'),path.join(stack,'config')])await mkdir(directory,{recursive:true,mode:0o700});
 const config={port:19403,chatPort:19404,home,workspaceRoots:{projects},defaultWorkspace:{root:'projects',path:''},stateRoot:state,launcher:path.join(stack,'scripts/pirun'),hubCli:path.join(stack,'old-hub.mjs')};
 const original=JSON.stringify(config);await writeFile(path.join(configDir,'config.json'),original,{mode:0o600});await writeFile(path.join(stack,'compose.yaml'),'services: {}\n');await writeFile(path.join(stack,'scripts/pi-pirun'),'original-host-launcher');
 const db=new DatabaseSync(path.join(state,'manager.sqlite3'));db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('durable-login-fixture')");
 try{
  const result=await installHost({stack,image:'sha256:'+'a'.repeat(64),commit:'b'.repeat(40),ref:'codex/test-only',dockerGid:1001,legacyQQ:[]});
  assert.equal(await readFile(path.join(configDir,'config.json'),'utf8'),original);assert.equal(db.prepare('SELECT value FROM marker').get().value,'durable-login-fixture');
  const saved=new DatabaseSync(path.join(result.backup,'manager.sqlite3'),{readOnly:true});try{assert.equal(saved.prepare('SELECT value FROM marker').get().value,'durable-login-fixture');}finally{saved.close();}
  assert.equal(await readFile(path.join(result.backup,'scripts/pi-pirun'),'utf8'),'original-host-launcher');assert.equal((await stat(path.join(result.backup,'manager.sqlite3'))).mode&0o777,0o600);
  assert.equal((await stat(path.join(stack,'scripts/pi-pirun'))).mode&0o777,0o755);assert.equal((await stat(path.join(stack,'scripts/pi-workbench-update.mjs'))).mode&0o777,0o700);
  const receipt=JSON.parse(await readFile(path.join(configDir,'container.json'),'utf8'));assert.equal(receipt.commit,'b'.repeat(40));assert.equal(receipt.ref,'codex/test-only');
 }finally{db.close();}
});
