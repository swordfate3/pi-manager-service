import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('workbench installer backs up old bundles, config and consistent SQLite before replacement',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pi-workbench-installer-')),stack=path.join(root,'stack'),home=path.join(root,'home');
  for(const directory of ['scripts','docs','systemd','local-workbench/dist/hub','local-workbench/dist/manager','local-workbench/config','local-workbench/state']) await mkdir(path.join(stack,directory),{recursive:true,mode:0o700});
  await mkdir(path.join(home,'gitproject'),{recursive:true});
  for(const script of ['pi-pirun','pi-web-hub-session','pi-dockerctl']) await writeFile(path.join(stack,'scripts',script),'original-'+script);
  const destination=path.join(stack,'local-workbench');
  const oldConfig=JSON.stringify({port:19403,protectedRoots:[stack]});await writeFile(path.join(destination,'config/config.json'),oldConfig,{mode:0o600});
  await writeFile(path.join(destination,'dist/manager/pi-manager-local.mjs'),'old-local-bundle');
  await writeFile(path.join(destination,'dist/hub/pi-web-hub.mjs'),'old-hub-bundle');
  const db=new DatabaseSync(path.join(destination,'state/manager.sqlite3'));db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('original-durable-state')");
  try {
    const raw=execFileSync(process.execPath,['deploy/local/install-local-workbench.mjs','--stack',stack],{encoding:'utf8',env:{...process.env,HOME:home}});
    const result=JSON.parse(raw.trim());assert.equal(result.installed,true);
    assert.equal(await readFile(path.join(result.backup,'dist/manager/pi-manager-local.mjs'),'utf8'),'old-local-bundle');
    assert.equal(await readFile(path.join(result.backup,'config/config.json'),'utf8'),oldConfig);
    assert.equal(await readFile(path.join(destination,'config/config.json'),'utf8'),oldConfig,'existing user configuration must be preserved');
    const saved=new DatabaseSync(path.join(result.backup,'manager.sqlite3'),{readOnly:true});
    try {assert.equal(saved.prepare('SELECT value FROM marker').get().value,'original-durable-state');}finally{saved.close();}
    assert.equal((await stat(path.join(result.backup,'manager.sqlite3'))).mode&0o777,0o600);
    assert.equal(db.prepare('SELECT value FROM marker').get().value,'original-durable-state');
  } finally {db.close();}
});
