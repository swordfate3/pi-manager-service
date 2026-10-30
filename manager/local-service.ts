import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startHub } from "../hub/server.ts";
import { readHubConfig } from "../hub/config.ts";
import { privateDirectory } from "./config.ts";
import { localConfig } from "./local-config.ts";
import { LocalLauncher } from "./local-launcher.ts";
import { localBrowseQuery, WorkspacePolicy } from "./workspaces.ts";
import { header, jsonBody, reply } from "./http.ts";
import { ManagerError, requireThat, record } from "./validation.ts";
import { renderLocalPage, renderLocalScript } from "./local-ui.ts";
import { renderAuthPage, renderAuthScript, renderAccountPage } from "./local-auth-ui.ts";
import { LocalStore } from "./local-store.ts";
import { LocalAuth } from "./local-auth.ts";
import { readSessionCookie } from "./local-security.ts";
import { canonical } from "./validation.ts";
import { proxyLocalUpgrade } from "./local-websocket.ts";
import { HUB_GENERATION_SOURCE } from "../protocol/hub-generation.ts";

/** No browser credentials or asserted identities cross into extension-owned code. */
export function localProxyHeaders(req:IncomingMessage,host:string,websocket=false) {
  const allowed=new Set(["accept","accept-encoding","accept-language","content-type","content-length","origin","range","if-range","if-none-match","if-modified-since","user-agent","sec-fetch-site","sec-fetch-mode","sec-fetch-dest"]);
  // This capability belongs to Hub's recovery API, never extension-owned HTTP/WS.
  if(!websocket && req.method === "POST" && req.url === "/api/session-handoff") {
    allowed.add("x-pi-web-handoff");allowed.add("x-pi-web-reconnect");
  }
  if(websocket) for(const name of ["sec-websocket-key","sec-websocket-version","sec-websocket-protocol","sec-websocket-extensions"]) allowed.add(name);
  const headers:import("node:http").OutgoingHttpHeaders={host};
  for(const [key,value] of Object.entries(req.headers)) if(allowed.has(key)) headers[key]=value;
  if(websocket) {headers.connection="Upgrade";headers.upgrade="websocket";}
  return headers;
}
export function localProxyResponse(headers:import("node:http").IncomingHttpHeaders) {
  const filtered={...headers};
  for(const name of Object.keys(filtered)) if(name === "set-cookie" || name === "server-timing" || name.startsWith("x-pi-") || name === "www-authenticate") delete filtered[name];
  filtered["cache-control"]="no-store";filtered["referrer-policy"]="no-referrer";
  return filtered;
}

/** A proxied body may fail after its headers have already reached the browser. */
export function replyLocalError(res: ServerResponse, error: unknown) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ManagerError ? error.status : 503;
  reply(res, status, { error: ({ 400: "目录或请求无效，请检查目录和账号输入；新密码至少需要 12 个字符。", 401:"请登录；账号或密码不正确，或登录已过期。",403: "请求来源或权限无效，请刷新页面后重试。", 404: "未找到此操作。", 409: "原申请已存在或状态已变化，请刷新后查看，不要重复创建。", 413: "请求过大。",429:"尝试过于频繁，请稍后再试。", 503: "本地服务暂不可用，请检查 Docker 和 pirun。" } as Record<number, string>)[status] ?? "操作未完成。" });
}

/** Explicit local-only application. NOT wired into public/admin/chat production roles. */
export async function startLocalService(value: unknown) {
  const config = localConfig(value);
  await privateDirectory(config.stateRoot);
  const policy = await WorkspacePolicy.open({ stateRoot: config.stateRoot,
    submitSocket: path.join(config.stateRoot, "submit", "unused.sock"), adminSocket: path.join(config.stateRoot, "admin", "unused.sock"),
    principals: [], trustedLocalNative: true, native: { piExecutable: config.launcher, workspaceRoots: config.workspaceRoots,
      stateRoot: config.stateRoot, agentRoot: path.dirname(config.launcher) },
    workspaces: {}, workspaceBrowser: { home: config.home, defaultRoot: config.defaultWorkspace.root },
  });
  // Local administrator-selected extra exclusions share the same canonical resolver.
  // Use a separate roots policy below for protected deployment/source trees.
  const denied = (selection: { root: string; path: string }) => {
    const chosen = path.join(config.workspaceRoots[selection.root], selection.path);
    return (config.protectedRoots ?? []).some(root => chosen === root || chosen.startsWith(root + path.sep) || root.startsWith(chosen + path.sep));
  };
  const selectedDefault = await policy.resolve(config.defaultWorkspace); requireThat(!denied(selectedDefault));
  const store=await LocalStore.open(config.stateRoot),auth=new LocalAuth(store,!!config.publicOrigin);
  let origin = "", hub: Awaited<ReturnType<typeof startHub>> | undefined, launcher: LocalLauncher | undefined;
  const sockets = new Set<import("node:net").Socket>(); let closing = false;
  const websockets=new Map<import("node:stream").Duplex,string>();
  const revalidateSockets=()=> {for(const [socket,hash] of websockets) if(!store.session(hash)) socket.destroy();};
  const expiry=setInterval(()=>{try{store.cleanup();revalidateSockets();}catch{for(const socket of websockets.keys()) socket.destroy();}},1000);expiry.unref();
  const directories=new Map<string,{expires:number;page:Awaited<ReturnType<typeof policy.browseEntries>>}>();
  function boundary(req: IncomingMessage, mutation = false) {
    requireThat(header(req, "host") === new URL(origin).host, 403);
    requireThat(req.url && req.url.length<=8192 && req.url.startsWith("/") && !req.url.startsWith("//") && !req.url.includes("\\"),400);
    header(req,"cookie");header(req,"authorization");header(req,"content-type");
    // Following a link from another site is a normal way to open the workbench.
    // Only its read-only top-level entry pages get this exception, never APIs,
    // subresources, frames, mutations or WebSocket handshakes.
    const entryNavigation = !mutation && req.method === "GET" && (req.url === "/" || req.url === "/sessions/" || req.url === "/login") &&
      header(req, "sec-fetch-mode") === "navigate" && header(req, "sec-fetch-dest") === "document";
    requireThat(header(req, "sec-fetch-site") !== "cross-site" || entryNavigation, 403);
    const from = header(req, "origin"); requireThat(from === undefined && !mutation || from === origin, 403);
  }
  const sessionFor=(req:IncomingMessage)=>auth.authenticate(readSessionCookie(header(req,"cookie"),auth.secure));
  const redirect=(res:ServerResponse,target:string)=>res.writeHead(302,{Location:target,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}).end();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    boundary(req); requireThat(!closing && hub && launcher, 503);
    const session=sessionFor(req);
    if(req.method === "GET" && req.url === "/login") {if(session) redirect(res,"/");else renderAuthPage(res);return;}
    if(req.method === "GET" && req.url === "/auth.js") {renderAuthScript(res);return;}
    if(req.method === "GET" && req.url === "/api/auth/state") {reply(res,200,auth.state(session));return;}
    if(req.url?.startsWith("/api/auth/")) {
      requireThat(req.method === "POST",404);boundary(req,true);auth.checkCsrf(header(req,"x-pi-local-csrf"),session);
      const body=await jsonBody(req);
      if(req.url === "/api/auth/setup") {
        requireThat(!header(req,"forwarded") && !Object.keys(req.headers).some(key=>key.startsWith("x-forwarded-")),403);
        const result=await auth.setup(body);res.setHeader("Set-Cookie",result.cookie);reply(res,200,{ok:true});return;
      }
      if(req.url === "/api/auth/login") {const result=await auth.login(body,req.socket.remoteAddress ?? "loopback");res.setHeader("Set-Cookie",result.cookie);revalidateSockets();reply(res,200,{ok:true});return;}
      requireThat(session,401);auth.revalidate(session);
      if(req.url === "/api/auth/password") await auth.change(session,body);
      else if(req.url === "/api/auth/logout" || req.url === "/api/auth/logout-all") auth.logout(session,req.url.endsWith("logout-all"));
      else throw new ManagerError(404);
      revalidateSockets();res.setHeader("Set-Cookie",auth.clearCookie());reply(res,200,{ok:true});return;
    }
    if(!session) {
      if(req.method === "GET" && (req.url === "/" || req.url === "/sessions/" || req.url === "/account" || /^\/s\/[A-Za-z0-9._~-]+\/$/.test(req.url!))) redirect(res,"/login");
      else throw new ManagerError(401);
      return;
    }
    if(req.method === "GET" && req.url === "/account") {renderAccountPage(res);return;}
    if (req.method === "GET" && req.url === "/") { renderLocalPage(res); return; }
    if (req.method === "GET" && req.url === "/local.js") { renderLocalScript(res,header(req,"if-none-match")); return; }
    if (req.method === "GET" && req.url === "/sessions/") { res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }).end(); return; }
    if (req.url === "/api/local/state" && req.method === "GET") {
      const sessions = hub.listSessions().map(({ label, sessionName, generation, path, since }) => ({ label, sessionName, generation, path, since }));
      reply(res, 200, { defaultWorkspace: config.defaultWorkspace, lastWorkspace:store.preference("workspace"),browser: policy.browser(), runs: launcher.list(), sessions, csrfToken:session.csrf }); return;
    }
    if (req.url?.startsWith("/api/local/dialogs/")) {
      const url = new URL(req.url, origin), match = new RegExp(`^/api/local/dialogs/(${HUB_GENERATION_SOURCE})$`).exec(url.pathname);
      requireThat(match, 404);
      const validSession = (value: unknown): string => {
        requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)); return value;
      };
      if (req.method === "GET") {
        requireThat([...url.searchParams.keys()].length === 1 && url.searchParams.has("session"));
        const result = await launcher.dialogs(match[1], validSession(url.searchParams.get("session")));
        auth.revalidate(session);
        reply(res, 200, { protocol: "pi-host-rpc-ui-v1", ...result, ...(result.available ? { csrfToken: session.csrf } : {}) });
      } else {
        requireThat(req.method === "POST" && !url.search, 404); boundary(req, true);
        auth.checkCsrf(header(req,"x-pi-local-csrf"),session);
        const body = record(await jsonBody(req, 32768)); auth.revalidate(session);
        const { sessionId, ...answer } = body;
        reply(res, 200, await launcher.respondDialog(match[1], validSession(sessionId), answer, () => auth.revalidate(session)));
      }
      return;
    }
    if (req.url?.startsWith("/api/local/")) {
      requireThat(req.method === "POST", 404); boundary(req, true);auth.checkCsrf(header(req,"x-pi-local-csrf"),session); const body = await jsonBody(req);auth.revalidate(session);
      if (req.url === "/api/local/browse") {
        const selection=localBrowseQuery(body),key=canonical(selection),cached=directories.get(key);
        const hit=!!cached && cached.expires>Date.now();
        const page = hit ? structuredClone(cached.page) : await policy.browseEntries(selection, config.protectedRoots);
        if(!hit) {directories.delete(key);if(directories.size>=64) directories.delete(directories.keys().next().value!);directories.set(key,{expires:Date.now()+2000,page:structuredClone(page)});}
        res.setHeader("Server-Timing",`directory;desc="${hit?"hit":"miss"}"`);
        reply(res, 200, page);
      } else if (req.url === "/api/local/start") {
        const selected = await policy.resolve((body as { workspace?: unknown })?.workspace); requireThat(!denied(selected));
        const started=await launcher.start(body);store.preference("workspace",selected);reply(res, 202, started);
      } else if (req.url === "/api/local/stop") reply(res, 202, await launcher.stop(body));
      else throw new ManagerError(404);
      return;
    }
    // Browser and chat share this origin. Hub still checks exact Origin and its
    // own per-Pi capability route; we do not expose the host launch API there.
    requireThat(req.url?.startsWith("/s/") || req.url === "/api/sessions" || req.url === "/api/session-handoff", 404);
    if(req.method !== "GET" && req.method !== "HEAD") boundary(req,true);
    await new Promise<void>((resolve, reject) => {
      const upstream = request(hub!.url + req.url!.slice(1), { method: req.method, headers: localProxyHeaders(req,new URL(hub!.url).host) }, response => {
        if(!store.session(session.hash)) {upstream.destroy();reject(new ManagerError(401));return;}
        res.writeHead(response.statusCode ?? 502, localProxyResponse(response.headers)); response.pipe(res); response.once("end", resolve); response.once("error", reject);
      }); upstream.once("error", reject);upstream.setTimeout(30000,()=>upstream.destroy(new Error("upstream idle timeout"))); req.once("aborted", () => upstream.destroy());res.once("close",()=>upstream.destroy()); req.pipe(upstream);
    });
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 20000, headersTimeout: 5000 }, (req, res) => {
    const began=performance.now(),original=res.writeHead;
    res.setHeader("Referrer-Policy","no-referrer");
    res.writeHead=function(...args:any[]) {res.setHeader("Server-Timing",`app;dur=${(performance.now()-began).toFixed(2)}${res.getHeader("Server-Timing") ? ", "+res.getHeader("Server-Timing") : ""}`);return original.apply(res,args as any); } as typeof res.writeHead;
    void handle(req, res).catch(error => replyLocalError(res, error));
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    try {
      boundary(req);requireThat(header(req,"origin") === origin,403); requireThat(hub && req.url?.startsWith("/s/") && !closing, 403);
      const session=sessionFor(req);requireThat(session,401);
      proxyLocalUpgrade({url:hub.url+req.url!.slice(1),headers:localProxyHeaders(req,new URL(hub.url).host,true),browser:socket,head,
        valid:()=>!closing && !!store.session(session.hash),onOpen:()=>{websockets.set(socket,session.hash);},onClose:()=>{websockets.delete(socket);},responseHeaders:localProxyResponse});
    } catch(error) { const status=error instanceof ManagerError ? error.status : 403;socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  });
  let port=0;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
    port = (server.address() as import("node:net").AddressInfo).port; origin = config.publicOrigin ?? `http://127.0.0.1:${port}`;
    const chatFile = path.join(config.stateRoot, "chat.json");
    await writeFile(chatFile, JSON.stringify({ host: "127.0.0.1", port: config.chatPort, publicUrl: origin + "/",
      stateDir: path.join(config.stateRoot, "chat-state"), runtimeDir: path.join(config.stateRoot, "chat-runtime") }), { mode: 0o600 });
    hub = await startHub(readHubConfig(chatFile));
    // A port of 0 is useful in isolated tests. Publish the actually selected
    // private chat port to the host-only pirun registration helper.
    if (config.chatPort === 0) await writeFile(chatFile, JSON.stringify({ host: "127.0.0.1", port: Number(new URL(hub.url).port), publicUrl: origin + "/",
      stateDir: path.join(config.stateRoot, "chat-state"), runtimeDir: path.join(config.stateRoot, "chat-runtime") }), { mode: 0o600 });
    launcher = await LocalLauncher.open(config, policy, { sessionPath: async runId => {
      if (!await hub!.isRunReady(runId)) return undefined;
      return hub!.sessionPath(runId);
    } },store);
  } catch (error) {clearInterval(expiry);store.close(); await hub?.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { port, url: origin + "/", close: async () => {
    if (closing) return; closing = true;clearInterval(expiry);
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { await launcher?.close(); } finally {try{await hub?.close();}finally{store.close();} }
  } };
}
