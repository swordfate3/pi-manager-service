#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createServer, request } from "node:http";
//#region manager/validation.ts
var ManagerError = class extends Error {
	status;
	constructor(status) {
		super({
			400: "Invalid request",
			401: "Authentication required",
			403: "Forbidden",
			404: "Not found",
			409: "Conflict; review current task",
			413: "Request too large",
			503: "Capability unavailable"
		}[status] ?? "Service unavailable");
		this.status = status;
	}
};
function requireThat(condition, status = 400) {
	if (!condition) throw new ManagerError(status);
}
function record(value) {
	requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
	return value;
}
function keys(value, required, optional = []) {
	requireThat(required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => [...required, ...optional].includes(k)));
}
function taskId(value) {
	requireThat(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value));
	return value;
}
function token(value) {
	requireThat(typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value), 401);
	return value;
}
//#endregion
//#region manager/config.ts
function absolute(value) {
	requireThat(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.resolve(value) === value);
	return value;
}
function origin(value) {
	requireThat(typeof value === "string");
	const u = new URL(value);
	requireThat(u.origin === value && ["http:", "https:"].includes(u.protocol));
	requireThat(u.protocol === "https:" || [
		"127.0.0.1",
		"[::1]",
		"localhost"
	].includes(u.hostname));
	return value;
}
function serviceConfig(value) {
	const c = record(value);
	keys(c, [
		"socketPath",
		"origin",
		"chatOrigin",
		"port"
	]);
	const result = {
		socketPath: absolute(c.socketPath),
		origin: origin(c.origin),
		chatOrigin: origin(c.chatOrigin),
		port: c.port
	};
	requireThat(result.origin !== result.chatOrigin && Number.isInteger(result.port) && result.port >= 0 && result.port <= 65535);
	return Object.freeze(result);
}
async function readPrivateJson(file) {
	const handle = await open(absolute(file), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = await handle.stat();
		requireThat(s.isFile() && s.uid === process.getuid?.() && (s.mode & 63) === 0 && s.size <= 1024 * 1024, 403);
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}
//#endregion
//#region manager/executor/client.ts
/** No TaskStore, backend, admin credential, subprocess or policy dependency. */
var ExecutorClient = class {
	#socketPath;
	#credential;
	constructor(options) {
		this.#socketPath = options.socketPath;
		this.#credential = token(options.credential);
	}
	call(message) {
		const data = JSON.stringify(message);
		requireThat(Buffer.byteLength(data) <= 8192, 413);
		return new Promise((resolve, reject) => {
			const req = request({
				socketPath: this.#socketPath,
				path: "/rpc",
				method: "POST",
				agent: false,
				headers: {
					Host: "executor",
					Authorization: `Bearer ${this.#credential}`,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(data)
				}
			}, (res) => {
				let size = 0;
				const chunks = [];
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > 1024 * 1024) req.destroy();
					else chunks.push(chunk);
				});
				res.on("error", () => reject(new ManagerError(503)));
				res.on("end", () => {
					clearTimeout(timer);
					if (res.statusCode !== 200) return reject(new ManagerError([
						400,
						401,
						403,
						404,
						409,
						413,
						503
					].includes(res.statusCode) ? res.statusCode : 503));
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						reject(new ManagerError(503));
					}
				});
			});
			const timer = setTimeout(() => req.destroy(), 4e3);
			req.on("error", () => {
				clearTimeout(timer);
				reject(new ManagerError(503));
			});
			req.end(data);
		});
	}
	submitTask(request) {
		return this.call({
			op: "submit",
			request
		});
	}
	getTask(taskId) {
		return this.call({
			op: "get",
			taskId
		});
	}
	listTasks() {
		return this.call({ op: "list" });
	}
	workspaces() {
		return this.call({ op: "workspaces" });
	}
	capabilities() {
		return this.call({ op: "capabilities" });
	}
	resources() {
		return this.call({ op: "resources" });
	}
};
//#endregion
//#region manager/http.ts
function header(req, name) {
	const values = [];
	for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[i + 1]);
	requireThat(values.length <= 1);
	return values[0];
}
function bearer(req) {
	const auth = header(req, "authorization");
	requireThat(auth && auth.startsWith("Bearer "), 401);
	return token(auth.slice(7));
}
function boundary(req, origin) {
	requireThat(header(req, "host") === new URL(origin).host, 403);
	const from = header(req, "origin");
	requireThat(req.method === "GET" ? from === void 0 || from === origin : from === origin, 403);
	header(req, "authorization");
	header(req, "cookie");
	header(req, "content-type");
	requireThat(req.url && req.url.length <= 512 && !/[\\%?#]/.test(req.url));
}
async function jsonBody(req) {
	requireThat(header(req, "content-type") === "application/json");
	const declared = header(req, "content-length");
	requireThat(!declared || Number(declared) <= 8192, 413);
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		requireThat(size <= 8192, 413);
		chunks.push(chunk);
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw new ManagerError(400);
	}
}
function reply(res, status, value) {
	if (res.destroyed || res.writableEnded) return;
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
async function listen(handler, endpoint) {
	const sockets = /* @__PURE__ */ new Set();
	const server = createServer({
		maxHeaderSize: 8192,
		requestTimeout: 5e3,
		headersTimeout: 5e3,
		connectionsCheckingInterval: 250
	}, (req, res) => {
		const deadline = setTimeout(() => {
			reply(res, 408, { error: "Request deadline exceeded" });
			req.socket.destroy();
		}, 5e3);
		handler(req, res).catch((error) => reply(res, error instanceof ManagerError ? error.status : 503, { error: error instanceof ManagerError ? error.message : "Service unavailable" })).finally(() => clearTimeout(deadline));
	});
	server.maxConnections = 64;
	server.maxRequestsPerSocket = 20;
	server.keepAliveTimeout = 1e3;
	server.setTimeout(5e3, (socket) => socket.destroy());
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("clientError", (_error, socket) => {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		if (typeof endpoint === "number") server.listen(endpoint, "127.0.0.1", resolve);
		else server.listen(endpoint, resolve);
	});
	let closing;
	return {
		port: typeof server.address() === "object" ? server.address().port : 0,
		close() {
			return closing ??= new Promise((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
				for (const socket of sockets) socket.destroy();
			});
		}
	};
}
//#endregion
//#region manager/ui.ts
function renderPage(res, admin) {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer"
	});
	res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Manager</title>
<style>body{font:16px system-ui;background:#f4f6fa;color:#17253d;margin:0}main{max-width:850px;margin:32px auto;padding:20px}section{background:white;border:1px solid #ccd5e2;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;max-width:100%;box-sizing:border-box}input,select{width:100%}button{cursor:pointer;margin:5px 8px 5px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#message{min-height:24px}li{margin:15px 0;overflow-wrap:anywhere}.notice{color:#61451b}button:disabled{cursor:default;opacity:.5}</style>
<main data-admin="${admin}"><h1>Pi Manager</h1><p>Independent task management · available with zero Pi instances</p>
<p class="notice">Native execution is trusted-local development only, not untrusted isolation. Docker, updates and Pi→Web enrollment are unavailable in this slice.</p>
<section><h2>${admin ? "Private administrator entry" : "Task requester entry"}</h2><p>${admin ? "Enter your separately provisioned administrator credential. Agent credentials cannot approve. You cannot approve your own request." : "Enter a requester credential. Approval happens separately in the private administrator entry."}</p>
<form id="login"><label>Credential<input id="credential" type="password" autocomplete="off" required></label><button>Unlock</button></form><button id="logout" hidden>Lock</button></section>
<p id="message" role="status" aria-live="polite"></p><section id="content" hidden><h2>Create or stop a managed Pi</h2><p id="capabilities"></p>
<form id="task"><label>Action<select id="action"><option value="create">Create native Pi</option><option value="stop">Stop owned native Pi</option></select></label><label>Target ID<input id="target" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label><label>Allowed directory<select id="workspace"></select></label><button id="submit">Submit for independent approval</button></form>
<button id="refresh">Refresh tasks</button><h2>Tasks</h2><p>After a lost response, refresh to reconcile before any new action. Restarted queued tasks require fresh review and approval; unknown tasks are never replayed.</p><ul id="tasks"></ul></section>
<section id="review" hidden><h2>Exact task review</h2><pre id="review-data"></pre><button id="approve">Approve and execute this revision</button><button id="cancel">Close review</button></section></main><script src="/app.js" defer><\/script></html>`);
}
var browserScript = `"use strict";
const el = id => document.getElementById(id);
const administrator = document.querySelector('main').dataset.admin === 'true';
let credential = '', reviewed = null, busy = false, lastSubmission = null;
const message = text => { el('message').textContent = text; };
async function api(route, data) {
  const headers = {};
  if (!administrator && credential) headers.Authorization = 'Bearer ' + credential;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/manager/' + route, {method:data === undefined ? 'GET':'POST',headers,credentials:'same-origin',cache:'no-store',body:data === undefined ? undefined:JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Request failed'); return value;
}
function hideReview() { reviewed = null; el('review').hidden = true; el('review-data').textContent = ''; }
async function refresh() {
  const tasks = await api('tasks'); el('tasks').replaceChildren();
  for (const task of tasks) {
    const item = document.createElement('li');
    const label = document.createElement('span'); label.textContent = task.id + ' · ' + task.requester + ' · ' + task.action + ' ' + task.target + ' · ' + task.state + ' (r' + task.revision + ')'; item.append(label);
    if (administrator && ['pending_approval','queued'].includes(task.state)) {
      const button = document.createElement('button'); button.textContent = 'Review';
      button.onclick = async () => { try { reviewed = await api('tasks/' + task.id + '/review'); el('review-data').textContent = JSON.stringify(reviewed, null, 2); el('approve').textContent = reviewed.requiresFreshApproval ? 'Approve and execute this revision' : 'Execute this already approved revision'; el('review').hidden = false; } catch(e) { message(e.message); } };
      item.append(button);
    }
    el('tasks').append(item);
  }
}
el('login').onsubmit = async e => {
  e.preventDefault(); const input = el('credential').value; el('credential').value = '';
  try {
    if (administrator) await api('login', {credential:input}); else credential = input;
    const capabilities = await api('capabilities'); const choices = await api('workspaces');
    el('capabilities').textContent = capabilities.native ? 'Native: trusted-local development. Enrollment/chat unavailable.' : 'Native execution is not configured.';
    el('submit').disabled = !capabilities.native; el('workspace').replaceChildren();
    for (const w of choices) { const option = document.createElement('option'); option.value = w.id; option.textContent = w.label; el('workspace').append(option); }
    el('content').hidden = false; el('login').hidden = true; el('logout').hidden = false; message('Unlocked. No task has been approved.'); await refresh();
  } catch(e) { credential = ''; message(e.message); }
};
el('task').onsubmit = async e => {
  e.preventDefault(); if (busy) return; busy = true; el('submit').disabled = true;
  const request = {action:el('action').value,target:el('target').value}; if (request.action === 'create') request.workspace = el('workspace').value;
  const signature = JSON.stringify(request);
  if (!lastSubmission || lastSubmission.signature !== signature) lastSubmission = {signature,key:crypto.randomUUID()};
  try { const task = await api('tasks', {...request,key:lastSubmission.key}); message('Task ' + task.id + ': ' + task.state); await refresh(); }
  catch(e) { message(e.message + '. Delivery may be unknown; refresh tasks before retrying. The same unchanged request retains its idempotency key.'); }
  finally { busy = false; el('submit').disabled = false; }
};
el('approve').onclick = async () => {
  if (!reviewed || busy) return;
  if (!confirm('Approve exactly ' + reviewed.task.action + ' ' + reviewed.task.target + ' at revision ' + reviewed.binding.revision + '?')) return;
  busy = true; el('approve').disabled = true; const binding = reviewed.binding; const fresh = reviewed.requiresFreshApproval; hideReview();
  try { await api(fresh ? 'approve':'execute',fresh ? binding : {taskId:binding.taskId,revision:binding.revision}); message('Approval accepted; execution is owned by the executor.'); await refresh(); }
  catch(e) { message(e.message + '. Refresh and review current state; do not replay an approval.'); }
  finally { busy = false; el('approve').disabled = false; }
};
el('refresh').onclick = () => refresh().catch(e => message(e.message));
el('cancel').onclick = hideReview;
el('logout').onclick = async () => {
  try { if (administrator) await api('logout',{}); } catch(e) { message(e.message); return; }
  credential = ''; lastSubmission = null; hideReview(); el('content').hidden = true; el('tasks').replaceChildren(); el('login').hidden = false; el('logout').hidden = true; message('Locked.');
};
`;
function renderScript(res) {
	res.writeHead(200, {
		"Content-Type": "text/javascript; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	res.end(browserScript);
}
//#endregion
//#region manager/service.ts
/** Public process: no TaskStore, native backend, spawn, policy or admin client. */
async function startService(value) {
	const config = serviceConfig(value);
	return listen(async (req, res) => {
		boundary(req, config.origin);
		if (req.method === "GET" && req.url === "/") {
			renderPage(res, false);
			return;
		}
		if (req.method === "GET" && req.url === "/app.js") {
			renderScript(res);
			return;
		}
		const client = new ExecutorClient({
			socketPath: config.socketPath,
			credential: bearer(req)
		});
		if (/\/(approve|execute|review)(\/|$)/.test(req.url)) throw new ManagerError(403);
		if (req.method === "POST" && req.url === "/api/manager/tasks") {
			reply(res, 202, await client.submitTask(await jsonBody(req)));
			return;
		}
		requireThat(req.method === "GET", 404);
		if (req.url === "/api/manager/tasks") reply(res, 200, await client.listTasks());
		else if (req.url === "/api/manager/workspaces") reply(res, 200, await client.workspaces());
		else if (req.url === "/api/manager/capabilities") reply(res, 200, await client.capabilities());
		else if (req.url === "/api/manager/resources") reply(res, 200, await client.resources());
		else if (req.url?.startsWith("/api/manager/tasks/")) reply(res, 200, await client.getTask(taskId(req.url.slice(19))));
		else throw new ManagerError(404);
	}, config.port);
}
//#endregion
//#region manager/process-entry.ts
/** Shared signal lifecycle only. No policy, credentials or process spawning. */
async function runProcess(start) {
	try {
		const service = await start();
		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			try {
				await service.close();
				process.exitCode = 0;
			} catch {
				process.stderr.write("Manager shutdown incomplete\n");
				process.exitCode = 1;
			} finally {
				if (process.connected) process.disconnect?.();
			}
		};
		process.once("SIGTERM", () => {
			close();
		});
		process.once("SIGINT", () => {
			close();
		});
		process.once("disconnect", () => {
			close();
		});
		if (process.send) process.send({
			ready: true,
			...service.port === void 0 ? {} : { port: service.port }
		});
		else process.stdout.write(JSON.stringify({
			ready: true,
			...service.port === void 0 ? {} : { port: service.port }
		}) + "\n");
	} catch {
		process.stderr.write("Manager service failed\n");
		process.exitCode = 1;
		if (process.connected) process.disconnect?.();
	}
}
function configArgument(args) {
	if (args.length !== 2 || args[0] !== "--config") throw new Error("Explicit configuration required");
	return args[1];
}
//#endregion
//#region bin/pi-manager-public.mjs
await runProcess(async () => startService(await readPrivateJson(configArgument(process.argv.slice(2)))));
//#endregion
export {};
