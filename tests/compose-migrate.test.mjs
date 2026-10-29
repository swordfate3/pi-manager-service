import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat} from 'node:fs/promises';
import {migrateHost} from '../deploy/compose/migrate-host.mjs';
async function fixture(){
 const base=await mkdtemp('/tmp/pi-clean-migrate-'),root=base+'/stack',assets=base+'/assets',home=base+'/home';
 for(const p of [root+'/local-workbench/config',root+'/local-workbench/state',root+'/config',root+'/state/pi-scoped-memory',root+'/pi-models',root+'/scripts',assets+'/bin',home+'/.config/pi-web',home+'/.ssh'])await mkdir(p,{recursive:true,mode:0o700});
 await writeFile(root+'/local-workbench/config/config.json',JSON.stringify({home,port:19403,chatPort:19404,stateRoot:root+'/local-workbench/state',workspaceRoots:{projects:home+'/projects'},defaultWorkspace:{root:'projects',path:''},publicOrigin:'https://pi.example.test'}),{mode:0o600});
 await writeFile(root+'/config/stack.json',JSON.stringify({piImage:'sha256:'+'a'.repeat(64)}));
 await writeFile(root+'/state/pi-scoped-memory/host-id','11111111-1111-4111-8111-111111111111\n');
 await writeFile(root+'/local-workbench/state/manager.sqlite3','fixture-login-database');
 await writeFile(root+'/pi-models/models.json','{"providers":{"current":{}}}');
 for(const f of ['control.py','configure.mjs','README.md'])await writeFile(assets+'/'+f,'fixture');
 await writeFile(assets+'/bin/pirun','fixture');
 await writeFile(home+'/.config/pi-web/tunnel_ed25519','private fixture',{mode:0o600});await writeFile(home+'/.ssh/known_hosts','fixture known host',{mode:0o600});
 return {root,assets,commit:'b'.repeat(40),ref:'main',image:'pi-stack-hub:'+'b'.repeat(12),tunnel:{host:'192.0.2.10',user:'pi-tunnel',remotePort:13001},screenshotSource:home+'/screenshots',verifyStopped:async()=>true};
}
test('migration archives old deployment without aliases and preserves login/model/memory bytes',async()=>{
 const f=await fixture(),r=await migrateHost(f);
 assert.equal(await readFile(f.root+'/data/hub/manager.sqlite3','utf8'),'fixture-login-database');
 assert.equal(await readFile(f.root+'/data/memory/host-id','utf8'),'11111111-1111-4111-8111-111111111111\n');
 assert.equal(await readFile(f.root+'/pi-models/models.json','utf8'),'{"providers":{"current":{}}}');
 assert.equal(await readFile(r.archive+'/login-database.snapshot','utf8'),'fixture-login-database');
 for(const name of ['scripts','state','local-workbench'])await assert.rejects(lstat(f.root+'/'+name),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(f.root+'/config/pi.json')).volumes.agent,'pi-home');
 assert.equal((await lstat(f.root+'/config/tunnel_ed25519')).mode&511,0o600);
 assert((await readdir(f.root)).every(name=>['archive','config','data','internal','pi-models','README.md'].includes(name)));
});
test('refuses active services before moving any files',async()=>{
 const f=await fixture();f.verifyStopped=async()=>false;
 await assert.rejects(migrateHost(f));assert.equal(await readFile(f.root+'/local-workbench/state/manager.sqlite3','utf8'),'fixture-login-database');await assert.rejects(lstat(f.root+'/archive'),{code:'ENOENT'});
});
