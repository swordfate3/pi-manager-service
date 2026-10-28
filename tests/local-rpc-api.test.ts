import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { issueSession, readHubConfig } from "../hub/config.ts";
import { startLocalService } from "../manager/local-service.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-host-rpc-api-"));
  const home = path.join(root, "home"), projects = path.join(home, "projects"), stateRoot = path.join(root, "state");
  const workspace = path.join(projects, "demo"), answerFile = path.join(root, "answers.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(root, "bin"));
  const runFile = path.join(root, "fixture-run.json"), launcher = path.join(root, "bin", "launcher"), docker = path.join(root, "bin", "docker");
  await writeFile(launcher, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const {runId}=JSON.parse(fs.readFileSync(${JSON.stringify(runFile)},'utf8'));
const dir=path.join(process.env.PI_PIRUN_WEB_HUB_RUNS_DIR,runId);fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'launch.json'),JSON.stringify({pid:process.pid,workspace:process.cwd(),run_id:runId}));
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);if(!line)continue;const c=JSON.parse(line);
if(c.type==='get_state')process.stdout.write(JSON.stringify({type:'response',command:'get_state',id:c.id,success:true,data:{sessionId:'session-fixture'}})+'\\n');
if(c.type==='extension_ui_response')fs.appendFileSync(${JSON.stringify(answerFile)},JSON.stringify(c)+'\\n');}});
process.stdin.on('end',()=>process.exit(0));
setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'confirm-fixture',method:'confirm',title:'合成确认',message:'仅测试预览，不是聊天内容。'})+'\\n'),100);
`, { mode: 0o700 });
  await writeFile(docker, `#!${process.execPath}
const name=process.argv[3];if(process.argv[2]!=='inspect')process.exit(99);
console.log(JSON.stringify([{Id:'c'.repeat(64),Name:'/'+name,Config:{Labels:{'cn.swordfate.pi.local-id':name}},Mounts:[{Destination:'/workspace',Source:${JSON.stringify(workspace)}}],State:{Running:true}}]));
`, { mode: 0o700 });
  const service = await startLocalService({ port: 0, chatPort: 0, home, workspaceRoots: { projects },
    defaultWorkspace: { root: "projects", path: "demo" }, stateRoot, launcher,
    hubCli: path.resolve("dist/hub/pi-web-hub.mjs"), dockerExecutable: docker });
  const hub = readHubConfig(path.join(stateRoot, "chat.json"));
  const credential = issueSession(hub, path.join(root, "fixture-capability.json"), { label: "Synthetic RPC fixture" });
  await writeFile(runFile, JSON.stringify({ runId: credential.run_id }));
  const generation = "a".repeat(32);
  const backend = createServer((req, res) => {
    const challenge = req.headers["x-pi-web-challenge"];
    if (req.url === "/.pi-web-identity") res.end(JSON.stringify({ generation,
      proof: createHmac("sha256", credential.token).update(`${challenge}:${generation}`).digest("hex") }));
    else res.end("synthetic backend");
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as net.AddressInfo).port;
  const registration = await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(hub.socketPath, () => socket.write(JSON.stringify({ action: "register", ...credential, generation, port }) + "\n"));
    let body = ""; socket.on("data", chunk => { body += chunk; if (body.includes("\n")) { socket.destroy(); resolve(JSON.parse(body)); } }); socket.on("error", reject);
  });
  assert.equal(registration.ok, true);
  t.after(async () => { await service.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  let cookie = "", csrf = "";
  async function call(route: string, body?: unknown, extra: Record<string, string | undefined> = {}) {
    return new Promise<{ status: number; value: any; headers: any }>((resolve, reject) => {
      const req = request(service.url.slice(0, -1) + route, { method: body === undefined ? "GET" : "POST",
        headers: Object.fromEntries(Object.entries({ Origin: new URL(service.url).origin, "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-Pi-Local-Csrf": csrf } : {}), ...extra }).filter(([, value]) => value !== undefined)) }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => text += chunk);
        res.on("end", () => { let value: any; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode!, value, headers: res.headers }); });
      }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login() {
    csrf = (await call("/api/auth/state")).value.csrfToken;
    const setup = await call("/api/auth/setup", { username: "tester", password: "synthetic-rpc-password" }); assert.equal(setup.status, 200);
    cookie = setup.headers["set-cookie"][0].split(";")[0]; csrf = (await call("/api/local/state")).value.csrfToken;
  }
  async function pending() {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const result = await call(`/api/local/dialogs/${generation}?session=session-fixture`);
      if (result.value.dialog) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("owned RPC prompt never became available");
  }
  return { root, stateRoot, service, call, login, pending, generation, answerFile };
}

test("owned RPC UI is login/Origin/CSRF protected, scoped to an active instance and delivered once", { timeout: 20000 }, async t => {
  const f = await fixture(t), route = `/api/local/dialogs/${f.generation}`;
  assert.equal((await f.call(route + "?session=session-fixture")).status, 401);
  await f.login();
  assert.equal((await f.call(route + "?session=session-fixture", undefined, { Origin: "https://evil.example" })).status, 403);
  const unknown = await f.call(`/api/local/dialogs/${"b".repeat(32)}?session=session-fixture`);
  assert.equal(unknown.status, 200); assert.equal(unknown.value.available, false);
  const bounded = `b2-${"a".repeat(32)}-${"b".repeat(16)}-${"c".repeat(32)}`;
  assert.equal((await f.call(`/api/local/dialogs/${bounded}?session=session-fixture`)).status, 200);
  assert.equal((await f.call(route + "?session=session-fixture&session=other")).status, 400);
  assert.equal((await f.call(route + "?session=session-fixture&extra=1")).status, 400);
  assert.equal((await f.call("/api/local/start", { key: "owned-dialog", workspace: { root: "projects", path: "demo" } })).status, 202);
  const pending = await f.pending();
  assert.equal(pending.value.protocol, "pi-host-rpc-ui-v1"); assert.equal(pending.value.available, true);
  assert.equal(pending.value.dialog.message, "仅测试预览，不是聊天内容。");
  const answer = { sessionId: "session-fixture", id: "confirm-fixture", decisionId: "decision-once", confirmed: false };
  assert.equal((await f.call(route, answer, { "X-Pi-Local-Csrf": "wrong" })).status, 403);
  assert.equal((await f.call(`/api/local/dialogs/${"b".repeat(32)}`, answer)).status, 409);
  assert.equal((await f.call(route, { ...answer, sessionId: "other-session" })).status, 409);
  assert.equal((await f.call(route, { ...answer, type: "bash", command: "not-permitted" })).status, 400);
  const delivered = await f.call(route, answer); assert.equal(delivered.status, 200); assert.equal(delivered.value.state, "delivered");
  assert.equal((await f.call(route, answer)).status, 409);
  await new Promise(resolve => setTimeout(resolve, 30));
  const rows = (await readFile(f.answerFile, "utf8")).trim().split("\n").map(v => JSON.parse(v));
  assert.deepEqual(rows, [{ type: "extension_ui_response", id: "confirm-fixture", confirmed: false }]);
  assert.ok(!JSON.stringify((await f.call("/api/local/state")).value).includes("仅测试预览"));
  assert.ok(!(await readFile(path.join(f.stateRoot, "manager.sqlite3"))).includes(Buffer.from("仅测试预览")));
});
