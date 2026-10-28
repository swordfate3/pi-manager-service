// Read-only live smoke: never submits setup/login, creates Pi or uses credentials.
import assert from 'node:assert/strict';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {DatabaseSync} from 'node:sqlite';

const output=process.argv[2];assert.match(output ?? '',/^\/tmp\/pi-login-smoke-[A-Za-z0-9_-]+$/);
await mkdir(output,{recursive:true,mode:0o700});
const origin='http://127.0.0.1:18403',checks=[];
for(const [route,status] of [['/',302],['/api/local/state',401],['/api/sessions',401],['/local.js',401],['/s/'+'a'.repeat(32)+'/files/report.pdf',401],['/login',200]]) {
  const response=await fetch(origin+route,{redirect:'manual',signal:AbortSignal.timeout(5000)});assert.equal(response.status,status,route);
  assert.equal(response.headers.get('cache-control'),'no-store');checks.push({route,status});
}
const account=await (await fetch(origin+'/api/auth/state')).json();assert.equal(account.authenticated,false);
const browser=await chromium.launch({headless:true,executablePath:process.env.PI_LOCAL_UI_TEST_BROWSER});
try {
  for(const width of [1280,390]) {
    const page=await browser.newPage({viewport:{width,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/');await page.waitForURL(origin+'/login');await page.locator('#auth-username:not([disabled])').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    await page.screenshot({path:path.join(output,`login-${width}.png`),fullPage:true});await page.close();
  }
}finally{await browser.close();}
const root='/home/fate/docker_files/pi-stack/local-workbench';
const file=path.join(root,'state/manager.sqlite3'),db=new DatabaseSync(file,{readOnly:true});
let metadata;
try {metadata={bytes:(await stat(file)).size,mode:(await stat(file)).mode&0o777,runs:db.prepare('SELECT count(*) AS n FROM runs').get().n,accounts:db.prepare('SELECT count(*) AS n FROM account').get().n};}finally{db.close();}
assert.equal(metadata.mode,0o600);
const source=await readFile('dist/manager/pi-manager-local.mjs'),live=await readFile(path.join(root,'dist/manager/pi-manager-local.mjs'));
const digest=data=>createHash('sha256').update(data).digest('hex');assert.equal(digest(source),digest(live));
const report={completed:true,checks,mobileAndDesktop:true,setupRequired:account.setupRequired,credentialsSubmitted:false,metadata,bundleSha256:digest(live)};
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
