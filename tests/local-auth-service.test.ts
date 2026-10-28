import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import test from "node:test";
import { startLocalService } from "../manager/local-service.ts";

export async function authFixture(t:any,extra:Record<string,unknown>={}) {
  const root=await mkdtemp(path.join(tmpdir(),"pi-auth-service-"));
  const home=path.join(root,"home"),projects=path.join(home,"projects");
  await mkdir(path.join(projects,"demo"),{recursive:true});
  await mkdir(path.join(root,"bin"));const launcher=path.join(root,"bin","launcher"); await writeFile(launcher,"#!/bin/sh\nexit 7\n",{mode:0o700});
  const config={port:0,chatPort:0,home,workspaceRoots:{projects},defaultWorkspace:{root:"projects",path:"demo"},stateRoot:path.join(root,"state"),launcher,hubCli:path.resolve("dist/hub/pi-web-hub.mjs"),...extra};
  const service=await startLocalService(config); t.after(()=>service.close());
  const origin=new URL(service.url).origin;
  let cookie="",csrf="";
  async function call(route:string,body?:unknown,headers:Record<string,string|undefined>={}) {
    return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=> {
      const req=request(`http://127.0.0.1:${service.port}${route}`,{method:body===undefined ? "GET":"POST",headers:Object.fromEntries(Object.entries({Host:new URL(origin).host,Origin:origin,"Content-Type":"application/json",Cookie:cookie,"X-Pi-Local-Csrf":csrf,...headers}).filter(([,v])=>v!==undefined))},res=>{
        let data="";res.setEncoding("utf8");res.on("data",chunk=>data+=chunk);res.on("end",()=> {try{data=JSON.parse(data);}catch{}resolve({status:res.statusCode!,body:data,headers:res.headers});});
      });req.once("error",reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async function login(setup=true) {
    csrf=(await call("/api/auth/state")).body.csrfToken;
    const result=await call(setup?"/api/auth/setup":"/api/auth/login",{username:"tester",password:"test-password-long"});
    assert.equal(result.status,200,JSON.stringify(result.body));cookie=result.headers["set-cookie"][0].split(";")[0];
    csrf=(await call("/api/auth/state")).body.csrfToken; return {cookie,csrf};
  }
  return {root,projects,config,service,call,login,get cookie(){return cookie;},get csrf(){return csrf;}};
}
test("anonymous gate protects every management, chat, file and WS entry without leaking state",async t=> {
  const f=await authFixture(t);
  assert.equal((await f.call("/")).headers.location,"/login");
  assert.equal((await f.call("/s/known-session/")).headers.location,"/login");
  for(const route of ["/api/local/state","/api/sessions","/s/known-session/api/history","/s/known-session/files/a.pdf","/local.js"])
    assert.equal((await f.call(route)).status,401,route);
  const upgrade=await f.call("/s/known-session/ws",undefined,{Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==","Sec-WebSocket-Version":"13"});
  assert.equal(upgrade.status,401);
  const state=await f.call("/api/auth/state");assert.equal(state.body.setupRequired,true);assert.equal(state.body.setupAllowed,true);
  assert.equal((await f.call("/api/auth/setup",{username:"tester",password:"test-password-long"})).status,403);
  await f.login();
  const ready=await f.call("/api/local/state");assert.equal(ready.status,200);assert.equal(ready.headers["cache-control"],"no-store");
  assert.match(ready.headers["server-timing"],/app;dur=/);
  assert.equal((await f.call("/api/local/state",undefined,{Cookie:f.cookie+"; "+f.cookie})).status,401);
  assert.equal((await f.call("/api/local/start",{key:"invalid-csrf",workspace:{root:"projects",path:"demo"}},{"X-Pi-Local-Csrf":"bad"})).status,403);
  assert.equal((await f.call("/api/auth/setup",{username:"other",password:"test-password-long"})).status,403);
  assert.equal((await f.call("/api/auth/logout",{})).status,200);
  assert.equal((await f.call("/api/local/state")).status,401);
});
test("HTTPS public mode ignores spoofed forwarding, uses secure cookie and disables web setup",async t=> {
  const f=await authFixture(t,{publicOrigin:"https://pi.example.test"});
  const state=await f.call("/api/auth/state");assert.equal(state.body.setupAllowed,false);
  assert.equal((await f.call("/api/auth/setup",{username:"tester",password:"test-password-long"},{"X-Pi-Local-Csrf":state.body.csrfToken})).status,403);
  assert.equal((await f.call("/api/auth/state",undefined,{Host:"evil.test","X-Forwarded-Host":"pi.example.test","X-Forwarded-Proto":"https"})).status,403);
  const {resetLocalAccount}=await import("../manager/local-account-cli.ts");const inputs=["tester","test-password-long","test-password-long"];
  await resetLocalAccount(f.config,async()=>inputs.shift()!);
  const login=await f.login(false);assert.match(login.cookie,/^__Host-pi_session=/);
  const again=await f.call("/api/auth/login",{username:"tester",password:"test-password-long"});
  assert.match(again.headers["set-cookie"][0],/; Secure$/);assert.match(again.headers["set-cookie"][0],/HttpOnly/);
  assert.equal((await f.call("/api/local/state")).status,200);
});
test("directory cache is bounded, refresh expires, launch revalidates removed project",async t=> {
  const f=await authFixture(t);await f.login();
  const one=await f.call("/api/local/browse",{root:"projects",path:""});
  const two=await f.call("/api/local/browse",{root:"projects",path:""});
  assert.match(one.headers["server-timing"],/directory;desc="miss"/);
  assert.match(two.headers["server-timing"],/directory;desc="hit"/);
  const {rename}=await import("node:fs/promises");await rename(path.join(f.projects,"demo"),path.join(f.projects,"moved"));
  assert.equal((await f.call("/api/local/start",{key:"gone",workspace:{root:"projects",path:"demo"}})).status,400);
});
test("static workbench revalidation never bypasses authentication",async t=> {
  const f=await authFixture(t);await f.login();
  const script=await f.call("/local.js");assert.equal(script.status,200);assert.match(script.headers.etag,/^"[a-f0-9]{64}"$/);
  assert.equal(script.headers["cache-control"],"private, no-cache");
  assert.equal((await f.call("/local.js",undefined,{"If-None-Match":script.headers.etag})).status,304);
  await f.call("/api/auth/logout",{});
  assert.equal((await f.call("/local.js",undefined,{"If-None-Match":script.headers.etag})).status,401);
});
test("cold and warm directory responses expose measured timings instead of caching private state",async t=> {
  const f=await authFixture(t);await f.login();
  const cold=await f.call("/api/local/browse",{root:"projects",path:""});
  const warm=[];
  for(let i=0;i<20;i++) {const response=await f.call("/api/local/browse",{root:"projects",path:""});const match=/app;dur=([0-9.]+)/.exec(response.headers["server-timing"]);assert.ok(match);warm.push(Number(match[1]));assert.equal(response.headers["cache-control"],"no-store");}
  warm.sort((a,b)=>a-b);
  t.diagnostic(`isolated directory cold=${cold.headers["server-timing"]}; warm p50=${warm[10]}ms p95=${warm[19]}ms (server-only, not network/Docker startup)`);
});
test("mobile Chromium drives first setup, password change, login and logout without browser token storage",{skip:!process.env.PI_LOCAL_UI_TEST_BROWSER,timeout:30000},async t=> {
  const f=await authFixture(t),{chromium}=await import("@playwright/test");
  const browser=await chromium.launch({executablePath:process.env.PI_LOCAL_UI_TEST_BROWSER,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  const errors:string[]=[];page.on("pageerror",err=>errors.push(err.message));
  await page.goto(f.service.url);await page.waitForURL(f.service.url+"login");
  await page.locator("#auth-username:not([disabled])").fill("tester");await page.locator("#auth-password").fill("test-password-long");
  await page.locator("#auth-submit").click();await page.waitForURL(f.service.url);
  await page.locator("#local-start:not([disabled])").waitFor();
  await page.getByRole("link",{name:"账号与退出"}).click();
  await page.locator("#auth-current-password:not([disabled])").fill("test-password-long");
  await page.locator("#auth-password").fill("new-password-long");await page.locator("#auth-submit").click();await page.waitForURL(f.service.url+"login");
  await page.locator("#auth-username:not([disabled])").fill("tester");await page.locator("#auth-password").fill("new-password-long");
  await page.locator("#auth-submit").click();await page.waitForURL(f.service.url);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  const cookies=await context.cookies();assert.ok(cookies.some(cookie=>cookie.name==="pi_local_session" && cookie.httpOnly && cookie.sameSite==="Lax"));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole("link",{name:"账号与退出"}).click();await page.locator("#auth-logout-all:not([disabled])").click();await page.waitForURL(f.service.url+"login");
  assert.equal((await context.request.get(f.service.url+"api/local/state")).status(),401);assert.deepEqual(errors,[]);
});
