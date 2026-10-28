#!/usr/bin/env node
import { access, chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from "node:crypto";
import http, { createServer } from "node:http";
import { Agent, request } from "node:https";
import { checkServerIdentity, rootCertificates } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import net, { isIP } from "node:net";
import { spawn } from "node:child_process";
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
function record$1(value) {
	requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
	return value;
}
function keys(value, required, optional = []) {
	requireThat(required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => [...required, ...optional].includes(k)));
}
function identifier$1(value) {
	requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value));
	return value;
}
function taskId(value) {
	requireThat(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value));
	return value;
}
function revision(value) {
	requireThat(Number.isSafeInteger(value) && value > 0);
	return value;
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	return JSON.stringify(value);
}
var digest = (value) => createHash("sha256").update(value).digest("hex");
function token(value) {
	requireThat(typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value), 401);
	return value;
}
function equalHash(a, b) {
	return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
//#endregion
//#region manager/backends/runtime-profile.ts
var absolute$4 = (v) => {
	requireThat(typeof v === "string" && path.isAbsolute(v) && v !== "/" && path.resolve(v) === v && !v.includes("\0") && !v.includes("\\"));
	return v;
};
function runtimeProfile(value) {
	const p = record$1(structuredClone(value));
	keys(p, [], [
		"runtimeVolume",
		"modelsFile",
		"environment",
		"extensions"
	]);
	if (p.runtimeVolume !== void 0) requireThat(typeof p.runtimeVolume === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(p.runtimeVolume) && !p.runtimeVolume.startsWith("pi-manager-home-"));
	if (p.modelsFile !== void 0) absolute$4(p.modelsFile);
	if (p.environment !== void 0) {
		const env = record$1(p.environment);
		requireThat(Object.keys(env).length <= 32);
		let bytes = 0;
		for (const [key, value] of Object.entries(env)) {
			requireThat(/^[A-Z_][A-Z0-9_]*$/.test(key) && ![
				"HOME",
				"PATH",
				"NODE_OPTIONS",
				"NODE_PATH"
			].includes(key) && !/^(LD_|PI_)/.test(key));
			requireThat(typeof value === "string" && !value.includes("\0"));
			bytes += Buffer.byteLength(`${key}=${value}\0`);
		}
		requireThat(bytes <= 8192);
		Object.freeze(env);
	}
	if (p.extensions !== void 0) {
		requireThat(Array.isArray(p.extensions) && p.extensions.length <= 16);
		for (const value of p.extensions) {
			const e = record$1(value);
			keys(e, ["packageRoot", "entry"]);
			absolute$4(e.packageRoot);
			requireThat(typeof e.entry === "string" && e.entry.length <= 512 && !/[\\\0]/.test(e.entry) && e.entry.split("/").every((s) => s !== "" && s !== "." && s !== "..") && /\.(ts|js|mjs)$/.test(e.entry));
			Object.freeze(e);
		}
		Object.freeze(p.extensions);
	}
	return Object.freeze(p);
}
var runtimeProfileSources = (p) => p ? [...p.modelsFile ? [p.modelsFile] : [], ...(p.extensions ?? []).map((e) => e.packageRoot)] : [];
async function validateRuntimeSources(profile) {
	try {
		if (profile.modelsFile) {
			requireThat(await realpath(profile.modelsFile) === profile.modelsFile);
			const file = await open(profile.modelsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = await file.stat();
				requireThat(info.isFile() && info.size <= 1024 * 1024);
				record$1(JSON.parse(await file.readFile("utf8")));
			} finally {
				await file.close();
			}
		}
		for (const e of profile.extensions ?? []) {
			requireThat(await realpath(e.packageRoot) === e.packageRoot && (await stat(e.packageRoot)).isDirectory());
			const entry = path.join(e.packageRoot, e.entry);
			requireThat(await realpath(entry) === entry && (await stat(entry)).isFile());
		}
	} catch {
		throw new ManagerError(400);
	}
}
function runtimeProfileMounts(p) {
	return p ? [
		...p.runtimeVolume ? [{
			Type: "volume",
			Source: p.runtimeVolume,
			Target: "/home/node/.local",
			ReadOnly: true,
			VolumeOptions: { NoCopy: true }
		}] : [],
		...p.modelsFile ? [{
			Type: "bind",
			Source: p.modelsFile,
			Target: "/home/node/.pi/manager-agent/models.json",
			ReadOnly: true
		}] : [],
		...(p.extensions ?? []).map((e, i) => ({
			Type: "bind",
			Source: e.packageRoot,
			Target: `/opt/pi-profile/extensions/${i}`,
			ReadOnly: true
		}))
	] : [];
}
//#endregion
//#region manager/enrollment/client.ts
function enrollmentConfig(value) {
	const e = record$1(structuredClone(value));
	keys(e, [
		"socketPath",
		"authorityFile",
		"registryHostDirectory",
		"exportHostDirectory"
	]);
	for (const p of Object.values(e)) requireThat(absolute$3(p) !== "/" && !p.includes("\\"));
	const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
	const paths = [
		path.dirname(e.socketPath),
		e.authorityFile,
		e.registryHostDirectory,
		e.exportHostDirectory
	];
	requireThat(!paths.some((a, i) => paths.slice(i + 1).some((b) => overlaps(a, b))));
	return Object.freeze(e);
}
/** Nonblocking descriptor checks precede reads, including for FIFOs/devices. */
async function readEnrollmentAuthority(file) {
	try {
		const handle = await open(absolute$3(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const s = await handle.stat();
			requireThat(s.isFile() && s.uid === process.getuid?.() && s.nlink === 1 && (s.mode & 63) === 0 && s.size <= 8192, 403);
			const value = record$1(JSON.parse(await handle.readFile("utf8")));
			keys(value, ["token"]);
			return token(value.token);
		} finally {
			await handle.close();
		}
	} catch {
		throw new ManagerError(403);
	}
}
var EnrollmentClient = class {
	#config;
	#active = /* @__PURE__ */ new Set();
	#closed = false;
	constructor(config) {
		this.#config = structuredClone(config);
	}
	async #call(operation, key, label, timeoutMs = 5e3) {
		const data = JSON.stringify({
			key: taskId(key),
			label: identifier$1(label)
		});
		requireThat(!this.#closed && this.#active.size < 16, 503);
		const authority = await readEnrollmentAuthority(this.#config.authorityFile);
		requireThat(!this.#closed && this.#active.size < 16, 503);
		return new Promise((resolve, reject) => {
			let done = false;
			const req = http.request({
				socketPath: this.#config.socketPath,
				path: `/${operation}`,
				method: "POST",
				agent: false,
				headers: {
					host: "pi-enrollment",
					authorization: `Bearer ${authority}`,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(data)
				}
			});
			this.#active.add(req);
			const finish = (value) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.#active.delete(req);
				req.destroy();
				if (value) resolve(value);
				else reject(new ManagerError(503));
			};
			const timer = setTimeout(() => finish(), Math.max(1, Math.min(timeoutMs, 5e3)));
			req.on("error", () => finish());
			req.on("response", (res) => {
				let size = 0;
				const chunks = [];
				res.on("error", () => finish());
				res.on("aborted", () => finish());
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > 1024) finish();
					else chunks.push(chunk);
				});
				res.on("end", () => {
					if (done) return;
					try {
						requireThat(res.statusCode === 200);
						const value = record$1(JSON.parse(Buffer.concat(chunks).toString("utf8")));
						keys(value, operation === "issue" ? ["ok"] : ["ready"]);
						requireThat(operation === "issue" ? value.ok === true : typeof value.ready === "boolean");
						finish(value);
					} catch {
						finish();
					}
				});
			});
			req.end(data);
		});
	}
	async issue(key, label) {
		await this.#call("issue", key, label);
	}
	async status(key, label, timeoutMs) {
		return (await this.#call("status", key, label, timeoutMs)).ready === true;
	}
	close() {
		this.#closed = true;
		for (const req of this.#active) req.destroy();
	}
};
//#endregion
//#region manager/config.ts
function absolute$3(value) {
	requireThat(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.resolve(value) === value);
	return value;
}
function executorConfig(value) {
	const c = record$1(structuredClone(value));
	keys(c, [
		"stateRoot",
		"submitSocket",
		"adminSocket",
		"principals",
		"trustedLocalNative",
		"native",
		"workspaces"
	], [
		"docker",
		"workspaceBrowser",
		"recoverStaleLock",
		"socketMode"
	]);
	absolute$3(c.stateRoot);
	absolute$3(c.submitSocket);
	absolute$3(c.adminSocket);
	requireThat(path.dirname(c.submitSocket) !== path.dirname(c.adminSocket));
	requireThat(typeof c.trustedLocalNative === "boolean");
	requireThat(c.recoverStaleLock === void 0 || typeof c.recoverStaleLock === "boolean");
	requireThat(c.socketMode === void 0 || [384, 432].includes(c.socketMode));
	requireThat(Array.isArray(c.principals) && c.principals.length > 0 && c.principals.length <= 100);
	const ids = /* @__PURE__ */ new Set();
	const hashes = /* @__PURE__ */ new Set();
	for (const p of c.principals) {
		const principal = record$1(p);
		keys(principal, [
			"id",
			"role",
			"tokenHash"
		]);
		identifier$1(principal.id);
		requireThat(["admin", "submitter"].includes(principal.role) && typeof principal.tokenHash === "string" && /^[0-9a-f]{64}$/.test(principal.tokenHash));
		requireThat(!ids.has(principal.id) && !hashes.has(principal.tokenHash));
		ids.add(principal.id);
		hashes.add(principal.tokenHash);
	}
	const workspaces = record$1(c.workspaces);
	requireThat(Object.keys(workspaces).length <= 100);
	requireThat(c.native === null || c.docker == null);
	if (c.docker != null) {
		const d = record$1(c.docker);
		keys(d, [
			"socketPath",
			"daemonId",
			"image",
			"pathCoordinates",
			"stateRoot",
			"workspaceRoots"
		], [
			"protectedRoots",
			"timeoutMs",
			"startupTimeoutMs",
			"entrypoint",
			"command",
			"web",
			"runtimeProfile"
		]);
		const dockerPath = (v) => {
			const p = absolute$3(v);
			requireThat(p !== path.parse(p).root);
			return p;
		};
		const contains = (root, value) => {
			const r = path.relative(root, value);
			return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
		};
		const overlaps = (a, b) => contains(a, b) || contains(b, a);
		dockerPath(d.socketPath);
		dockerPath(d.stateRoot);
		requireThat(d.pathCoordinates === "host" && typeof d.daemonId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(d.daemonId));
		requireThat(typeof d.image === "string" && /^sha256:[a-f0-9]{64}$/.test(d.image));
		requireThat(d.timeoutMs === void 0 || Number.isSafeInteger(d.timeoutMs) && d.timeoutMs >= 1 && d.timeoutMs <= 12e4);
		requireThat(d.startupTimeoutMs === void 0 || Number.isSafeInteger(d.startupTimeoutMs) && d.startupTimeoutMs >= 100 && d.startupTimeoutMs <= 12e4);
		for (const args of [d.entrypoint, d.command]) if (args !== void 0) requireThat(Array.isArray(args) && args.length > 0 && args.length <= 64 && args.every((a) => typeof a === "string" && a.length > 0 && a.length <= 8192 && !a.includes("\0")));
		requireThat(d.protectedRoots === void 0 || Array.isArray(d.protectedRoots) && d.protectedRoots.length <= 61);
		const protectedPaths = [
			c.stateRoot,
			path.dirname(c.submitSocket),
			path.dirname(c.adminSocket),
			d.stateRoot,
			d.socketPath,
			fileURLToPath(new URL("..", import.meta.url)),
			...(d.protectedRoots ?? []).map(dockerPath)
		];
		if (d.web !== void 0) {
			const w = record$1(d.web);
			keys(w, ["packageRoot", "port"], [
				"hubConfigFile",
				"enrollment",
				"provider"
			]);
			requireThat(w.hubConfigFile === void 0 !== (w.enrollment === void 0));
			protectedPaths.push(dockerPath(w.packageRoot));
			if (w.hubConfigFile !== void 0) protectedPaths.push(dockerPath(w.hubConfigFile));
			if (w.enrollment !== void 0) {
				const e = enrollmentConfig(w.enrollment);
				protectedPaths.push(path.dirname(e.socketPath), e.authorityFile, e.registryHostDirectory, e.exportHostDirectory);
			}
			requireThat(Number.isInteger(w.port) && w.port >= 1 && w.port <= 65535 && d.command === void 0 && d.entrypoint === void 0);
			if (w.provider !== void 0) {
				const p = record$1(w.provider);
				keys(p, [
					"packageRoot",
					"name",
					"model"
				]);
				protectedPaths.push(dockerPath(p.packageRoot));
				requireThat([p.name, p.model].every((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(v)));
			}
		}
		if (d.runtimeProfile !== void 0) {
			requireThat(d.web !== void 0);
			protectedPaths.push(...runtimeProfileSources(runtimeProfile(d.runtimeProfile)));
		}
		requireThat(!overlaps(c.stateRoot, d.stateRoot));
		const roots = record$1(d.workspaceRoots);
		requireThat(Object.keys(roots).length > 0 && Object.keys(roots).length <= 32);
		for (const [name, value] of Object.entries(roots)) {
			identifier$1(name);
			const root = dockerPath(value);
			requireThat(!protectedPaths.some((p) => c.workspaceBrowser === void 0 ? overlaps(root, p) : contains(p, root)));
		}
	}
	if (c.native !== null) {
		requireThat(c.trustedLocalNative === true, 403);
		const n = record$1(c.native);
		keys(n, [
			"piExecutable",
			"workspaceRoots",
			"stateRoot",
			"agentRoot"
		], [
			"provider",
			"web",
			"runtimeControl",
			"startupTimeoutMs",
			"rpcTimeoutMs",
			"generationTimeoutMs",
			"stopTimeoutMs",
			"maxFrameBytes",
			"maxStderrBytes"
		]);
		requireThat(n.runtimeControl === void 0 || typeof n.runtimeControl === "boolean");
		requireThat(!n.runtimeControl || n.web !== void 0);
		absolute$3(n.piExecutable);
		absolute$3(n.stateRoot);
		absolute$3(n.agentRoot);
		for (const [id, root] of Object.entries(record$1(n.workspaceRoots))) {
			identifier$1(id);
			absolute$3(root);
		}
		if (n.provider !== void 0) {
			const p = record$1(n.provider);
			keys(p, [
				"extensionPath",
				"name",
				"model"
			]);
			absolute$3(p.extensionPath);
		}
		if (n.web !== void 0) {
			const web = record$1(n.web);
			keys(web, [
				"extensionPath",
				"hubConfigFile",
				"port"
			]);
			absolute$3(web.extensionPath);
			absolute$3(web.hubConfigFile);
			requireThat(Number.isInteger(web.port) && web.port >= 1 && web.port <= 65535);
		}
	}
	for (const [id, value] of Object.entries(workspaces)) {
		identifier$1(id);
		const w = record$1(value);
		keys(w, [
			"label",
			"root",
			"path"
		]);
		identifier$1(w.root);
		requireThat(typeof w.label === "string" && w.label.length > 0 && w.label.length <= 100 && !/[\x00-\x1f]/.test(w.label));
		requireThat(typeof w.path === "string" && w.path.length <= 512 && !path.isAbsolute(w.path) && !w.path.includes("\\") && !w.path.includes("\0") && !w.path.split("/").includes(".."));
		const backend = c.docker ?? c.native;
		requireThat(backend !== null && Object.hasOwn(backend.workspaceRoots, w.root));
	}
	if (c.workspaceBrowser !== void 0) {
		const browser = record$1(c.workspaceBrowser);
		keys(browser, ["home", "defaultRoot"]);
		const home = absolute$3(browser.home);
		requireThat(home !== path.parse(home).root);
		const defaultRoot = identifier$1(browser.defaultRoot);
		const backend = c.docker ?? c.native;
		requireThat(backend !== null && Object.hasOwn(backend.workspaceRoots, defaultRoot));
		for (const root of Object.values(backend.workspaceRoots)) {
			const relative = path.relative(home, root);
			requireThat(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
		}
	}
	return c;
}
/** Provisioning owns OS users/groups/mounts; checking a mode is NOT proof of isolation. */
async function privateDirectory$1(directory, allowGroupSearch = false) {
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const s = await lstat(directory);
	requireThat(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & (allowGroupSearch ? 23 : 63)) === 0 && await realpath(directory) === directory, 403);
}
async function readPrivateJson$1(file) {
	const handle = await open(absolute$3(file), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = await handle.stat();
		requireThat(s.isFile() && s.uid === process.getuid?.() && (s.mode & 63) === 0 && s.size <= 1024 * 1024, 403);
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}
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
	const management = header(req, "x-pi-manager-token");
	requireThat(!(auth !== void 0 && management !== void 0));
	if (management !== void 0) return token(management);
	requireThat(auth && auth.startsWith("Bearer "), 401);
	return token(auth.slice(7));
}
async function jsonBody(req, maxBytes = 8192) {
	requireThat(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32768);
	requireThat(header(req, "content-type") === "application/json");
	const declared = header(req, "content-length");
	requireThat(!declared || Number(declared) <= maxBytes, 413);
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		requireThat(size <= maxBytes, 413);
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
//#region manager/contracts.ts
var TASK_STATES = [
	"pending_approval",
	"queued",
	"waiting_idle",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"unknown"
];
//#endregion
//#region manager/task-store.ts
var STATE_FILE = "tasks.json";
var LOCK_DIRECTORY = ".task-store.lock";
var ACQUISITION_DIRECTORY = ".task-store.acquire";
var RECOVERY_FILE = ".task-store.recovery.json";
var OWNER_FILE = "owner.json";
var MAX_REQUEST_BYTES = 64 * 1024;
var MAX_STATE_BYTES = 1024 * 1024;
var MAX_LOCK_BYTES = 4 * 1024;
var MAX_RECOVERY_BYTES = 4 * 1024;
var MAX_JSON_DEPTH = 32;
var MAX_JSON_NODES = 1e4;
var taskStateSet = new Set(TASK_STATES);
var resultStates = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"unknown"
]);
var allowedTransitions = {
	pending_approval: new Set(["queued", "cancelled"]),
	queued: new Set([
		"waiting_idle",
		"running",
		"cancelled"
	]),
	waiting_idle: new Set([
		"running",
		"cancelled",
		"failed",
		"unknown"
	]),
	running: new Set([
		"succeeded",
		"failed",
		"cancelled",
		"unknown"
	]),
	succeeded: /* @__PURE__ */ new Set(),
	failed: /* @__PURE__ */ new Set(),
	cancelled: /* @__PURE__ */ new Set(),
	unknown: /* @__PURE__ */ new Set()
};
var TaskStoreError = class extends Error {
	constructor(message) {
		super(message);
		this.name = new.target.name;
	}
};
var TaskStoreLockedError = class extends TaskStoreError {};
var TaskStoreRecoveryRequiredError = class extends TaskStoreError {};
var TaskStoreDataError = class extends TaskStoreError {};
var TaskStoreRequestError = class extends TaskStoreError {};
var TaskStoreConflictError = class extends TaskStoreError {};
var TaskStoreDurabilityError = class extends TaskStoreError {};
function isErrno(error, code) {
	return error instanceof Error && error.code === code;
}
function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function hasOnlyKeys(value, allowed) {
	const keys = Object.keys(value);
	return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
function getOwn(record, key) {
	return Object.hasOwn(record, key) ? record[key] : void 0;
}
function setOwn(record, key, value) {
	Object.defineProperty(record, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function cloneJson(value) {
	return structuredClone(value);
}
function validateJson(value, label) {
	let nodes = 0;
	const ancestors = /* @__PURE__ */ new Set();
	const visit = (candidate, depth) => {
		nodes += 1;
		if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new TaskStoreRequestError(`${label} exceeds the JSON complexity limit`);
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
			return candidate;
		}
		if (typeof candidate !== "object") throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
		if (ancestors.has(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
		ancestors.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				const ownKeys = Reflect.ownKeys(candidate);
				if (ownKeys.length !== candidate.length + 1 || !ownKeys.includes("length") || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= candidate.length))) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
				return candidate.map((item) => visit(item, depth + 1));
			}
			if (!isPlainObject(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
			const result = {};
			for (const [key, item] of Object.entries(candidate)) setOwn(result, key, visit(item, depth + 1));
			return result;
		} finally {
			ancestors.delete(candidate);
		}
	};
	return visit(value, 0);
}
function boundedJson(value, label, maximumBytes) {
	const validated = validateJson(value, label);
	const json = JSON.stringify(validated);
	if (Buffer.byteLength(json, "utf8") > maximumBytes) throw new TaskStoreRequestError(`${label} JSON size exceeds its limit`);
	return {
		value: validated,
		json
	};
}
function validateIdentifier(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TaskStoreRequestError(`${label} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf8") > 4096) throw new TaskStoreRequestError(`${label} size exceeds its limit`);
	return value;
}
function normalizeRequest(request) {
	if (!isPlainObject(request)) throw new TaskStoreRequestError("Task request must be an object");
	if (!hasOnlyKeys(request, [
		"key",
		"requester",
		"target",
		"action",
		"payload"
	])) throw new TaskStoreRequestError("Task request contains unexpected fields");
	const normalized = {
		key: validateIdentifier(request.key, "Task idempotency key"),
		requester: validateIdentifier(request.requester, "Task requester"),
		target: validateIdentifier(request.target, "Task target"),
		action: validateIdentifier(request.action, "Task action"),
		payload: validateJson(request.payload, "Task payload")
	};
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_REQUEST_BYTES) throw new TaskStoreRequestError("Task request JSON size exceeds its limit");
	return normalized;
}
function canonicalJson$1(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson$1).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson$1(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
function requestValue(request) {
	return {
		key: request.key,
		requester: request.requester,
		target: request.target,
		action: request.action,
		payload: request.payload
	};
}
function sameRequest(task, request) {
	return canonicalJson$1(requestValue(task)) === canonicalJson$1(requestValue(request));
}
function initialState() {
	return {
		schemaVersion: 1,
		tasks: {},
		idempotency: {}
	};
}
async function syncDirectory$1(directory) {
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function serializeState(state) {
	const json = `${JSON.stringify(state)}\n`;
	if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) throw new TaskStoreDataError("Task store data size exceeds its limit");
	return json;
}
async function writePrivateAtomic(file, content) {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
	let renamed = false;
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = void 0;
		await rename(temporary, file);
		renamed = true;
		await chmod(file, 384);
		await syncDirectory$1(directory);
	} finally {
		await handle?.close().catch(() => void 0);
		if (!renamed) await rm(temporary, { force: true });
	}
}
async function readBoundedPrivateFile(file, maximumBytes, label) {
	const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | noFollow);
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new TaskStoreDataError(`${label} is invalid`);
		if (metadata.size > maximumBytes) throw new TaskStoreDataError(`${label} size exceeds its limit`);
		await handle.chmod(384);
		return await handle.readFile("utf8");
	} catch (error) {
		if (error instanceof TaskStoreError || isErrno(error, "ENOENT")) throw error;
		throw new TaskStoreDataError(`${label} is invalid`);
	} finally {
		await handle?.close();
	}
}
function parseIsoDate(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validateTask(id, value) {
	if (!isPlainObject(value)) throw new TaskStoreDataError("Invalid task store data");
	if (!hasOnlyKeys(value, Object.hasOwn(value, "result") ? [
		"key",
		"requester",
		"target",
		"action",
		"payload",
		"id",
		"revision",
		"state",
		"createdAt",
		"updatedAt",
		"result"
	] : [
		"key",
		"requester",
		"target",
		"action",
		"payload",
		"id",
		"revision",
		"state",
		"createdAt",
		"updatedAt"
	])) throw new TaskStoreDataError("Invalid task store data");
	const request = normalizeRequest({
		key: value.key,
		requester: value.requester,
		target: value.target,
		action: value.action,
		payload: value.payload
	});
	if (value.id !== id || typeof value.id !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.state !== "string" || !taskStateSet.has(value.state) || !parseIsoDate(value.createdAt) || !parseIsoDate(value.updatedAt)) throw new TaskStoreDataError("Invalid task store data");
	const state = value.state;
	const hasResult = Object.hasOwn(value, "result");
	if (hasResult && !resultStates.has(state)) throw new TaskStoreDataError("Invalid task store data");
	const result = hasResult ? boundedJson(value.result, "Task result", MAX_REQUEST_BYTES).value : void 0;
	return {
		...request,
		id,
		revision: value.revision,
		state,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...result === void 0 ? {} : { result }
	};
}
function parseStoredState(content) {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		throw new TaskStoreDataError("Invalid task store data");
	}
	try {
		if (!isPlainObject(value) || !hasOnlyKeys(value, [
			"schemaVersion",
			"tasks",
			"idempotency"
		]) || value.schemaVersion !== 1 || !isPlainObject(value.tasks) || !isPlainObject(value.idempotency)) throw new TaskStoreDataError("Invalid task store data");
		const tasks = {};
		for (const [id, task] of Object.entries(value.tasks)) setOwn(tasks, id, validateTask(id, task));
		const idempotency = {};
		for (const [requester, entries] of Object.entries(value.idempotency)) {
			if (!isPlainObject(entries)) throw new TaskStoreDataError("Invalid task store data");
			const normalizedEntries = {};
			for (const [key, taskId] of Object.entries(entries)) {
				const task = typeof taskId === "string" ? getOwn(tasks, taskId) : void 0;
				if (!task || task.requester !== requester || task.key !== key) throw new TaskStoreDataError("Invalid task store data");
				setOwn(normalizedEntries, key, taskId);
			}
			setOwn(idempotency, requester, normalizedEntries);
		}
		for (const task of Object.values(tasks)) {
			const entries = getOwn(idempotency, task.requester);
			if (!entries || getOwn(entries, task.key) !== task.id) throw new TaskStoreDataError("Invalid task store data");
		}
		return {
			schemaVersion: 1,
			tasks,
			idempotency
		};
	} catch (error) {
		if (error instanceof TaskStoreDataError) throw error;
		throw new TaskStoreDataError("Invalid task store data");
	}
}
async function readProcessIdentity$1(pid) {
	try {
		const [statContent, bootId] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
		const commandEnd = statContent.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const startTicks = statContent.slice(commandEnd + 2).trim().split(/\s+/)[19];
		const boot = bootId.trim();
		const identity = startTicks && boot ? `${boot}:${startTicks}` : null;
		return identity && isProcessIdentity(identity) ? identity : null;
	} catch {
		return null;
	}
}
function isProcessIdentity(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(value);
}
async function currentLockOwner(token) {
	return {
		schemaVersion: 1,
		pid: process.pid,
		processIdentity: await readProcessIdentity$1(process.pid),
		token,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function parseLockOwner(content) {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		throw new TaskStoreLockedError("Task store lock metadata is malformed");
	}
	if (!isPlainObject(value) || !hasOnlyKeys(value, [
		"schemaVersion",
		"pid",
		"processIdentity",
		"token",
		"createdAt"
	]) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.processIdentity !== null && (typeof value.processIdentity !== "string" || !isProcessIdentity(value.processIdentity)) || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token) || !parseIsoDate(value.createdAt)) throw new TaskStoreLockedError("Task store lock metadata is malformed");
	return value;
}
async function readLockOwner(directory) {
	try {
		const metadata = await lstat(directory);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TaskStoreLockedError("Task store lock is malformed");
		return parseLockOwner(await readBoundedPrivateFile(path.join(directory, OWNER_FILE), MAX_LOCK_BYTES, "Task store lock"));
	} catch (error) {
		if (error instanceof TaskStoreLockedError) throw error;
		throw new TaskStoreLockedError("Task store lock is malformed");
	}
}
function probeProcess(pid) {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		if (isErrno(error, "ESRCH")) return "dead";
		if (isErrno(error, "EPERM")) return "ambiguous";
		return "ambiguous";
	}
}
async function inspectLock(directory) {
	const owner = await readLockOwner(directory);
	const liveness = probeProcess(owner.pid);
	if (liveness === "dead") return "stale";
	if (liveness === "ambiguous") return "ambiguous";
	const observedIdentity = await readProcessIdentity$1(owner.pid);
	if (owner.processIdentity !== null && observedIdentity !== null) return owner.processIdentity === observedIdentity ? "active" : "stale";
	return "ambiguous";
}
function parseRecoveryMarker(content) {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		throw new TaskStoreDataError("Task store recovery marker is invalid");
	}
	if (!isPlainObject(value) || !hasOnlyKeys(value, [
		"schemaVersion",
		"reason",
		"createdAt"
	]) || value.schemaVersion !== 1 || value.reason !== "stale-writer" || !parseIsoDate(value.createdAt)) throw new TaskStoreDataError("Task store recovery marker is invalid");
	return value;
}
async function readRecoveryMarker(root) {
	try {
		return parseRecoveryMarker(await readBoundedPrivateFile(path.join(root, RECOVERY_FILE), MAX_RECOVERY_BYTES, "Task store recovery marker"));
	} catch (error) {
		if (isErrno(error, "ENOENT")) return void 0;
		if (error instanceof TaskStoreDataError) throw error;
		throw new TaskStoreDataError("Task store recovery marker is invalid");
	}
}
async function ensureRecoveryMarker(root) {
	if (await readRecoveryMarker(root)) return;
	const marker = {
		schemaVersion: 1,
		reason: "stale-writer",
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await writePrivateAtomic(path.join(root, RECOVERY_FILE), `${JSON.stringify(marker)}\n`);
}
async function clearRecoveryMarker(root) {
	try {
		await rm(path.join(root, RECOVERY_FILE));
		await syncDirectory$1(root);
	} catch {
		throw new TaskStoreDataError("Task store recovery marker could not be cleared safely");
	}
}
async function createOwnedDirectory(directory) {
	const token = randomUUID();
	await mkdir(directory, { mode: 448 });
	try {
		await chmod(directory, 448);
		await writePrivateAtomic(path.join(directory, OWNER_FILE), `${JSON.stringify(await currentLockOwner(token))}\n`);
		return {
			directory,
			token
		};
	} catch (error) {
		await rm(directory, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
async function releaseOwnedDirectory(lock) {
	const owner = await readLockOwner(lock.directory);
	if (owner.pid !== process.pid || owner.token !== lock.token) throw new TaskStoreLockedError("Task store lock ownership changed unexpectedly");
	const released = `${lock.directory}.released-${randomUUID()}`;
	await rename(lock.directory, released);
	await rm(released, { recursive: true });
	await syncDirectory$1(path.dirname(lock.directory));
}
async function acquireWriterLock(root, recoverStaleLock) {
	const acquisitionDirectory = path.join(root, ACQUISITION_DIRECTORY);
	let acquisition;
	try {
		acquisition = await createOwnedDirectory(acquisitionDirectory);
	} catch (error) {
		if (isErrno(error, "EEXIST")) throw new TaskStoreLockedError("Task store lock acquisition is already in progress; offline recovery is required if it was abandoned");
		throw error;
	}
	const lockDirectory = path.join(root, LOCK_DIRECTORY);
	let quarantine;
	try {
		try {
			return { lock: await createOwnedDirectory(lockDirectory) };
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		const status = await inspectLock(lockDirectory);
		if (status === "active" || status === "ambiguous") throw new TaskStoreLockedError(status === "active" ? "Task store is locked by another writer" : "Task store lock ownership is ambiguous");
		if (!recoverStaleLock) throw new TaskStoreRecoveryRequiredError("Task store recovery is required for a stale writer lock");
		if (await inspectLock(lockDirectory) !== "stale") throw new TaskStoreLockedError("Task store lock can no longer be proven stale");
		await ensureRecoveryMarker(root);
		quarantine = path.join(root, `.task-store.stale-${randomUUID()}`);
		await rename(lockDirectory, quarantine);
		const lock = await createOwnedDirectory(lockDirectory);
		try {
			await rm(quarantine, { recursive: true });
		} catch {
			await releaseOwnedDirectory(lock);
			await rename(quarantine, lockDirectory);
			quarantine = void 0;
			throw new TaskStoreLockedError("Task store stale lock recovery could not be completed safely");
		}
		quarantine = void 0;
		return { lock };
	} catch (error) {
		if (quarantine) try {
			await rename(quarantine, lockDirectory);
		} catch {
			throw new TaskStoreLockedError("Task store stale lock recovery could not be completed safely");
		}
		throw error;
	} finally {
		await releaseOwnedDirectory(acquisition);
	}
}
async function prepareRoot(root) {
	if (typeof root !== "string" || root.trim().length === 0) throw new TaskStoreDataError("Task store root must be a non-empty path");
	const resolved = path.resolve(root);
	await mkdir(resolved, {
		recursive: true,
		mode: 448
	});
	const metadata = await lstat(resolved);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TaskStoreDataError("Task store root must be a real directory");
	await chmod(resolved, 448);
	return resolved;
}
var TaskStore = class TaskStore {
	#root;
	#stateFile;
	#lock;
	#state;
	#writeTail = Promise.resolve();
	#closePromise;
	#closing = false;
	#closed = false;
	#poisoned = false;
	constructor(root, state, lock) {
		this.#root = root;
		this.#stateFile = path.join(root, STATE_FILE);
		this.#lock = lock;
		this.#state = state;
	}
	static async open(root, options = {}) {
		const resolvedRoot = await prepareRoot(root);
		const recoverStaleLock = options.recoverStaleLock === true;
		const { lock } = await acquireWriterLock(resolvedRoot, recoverStaleLock);
		try {
			const recoveryMarker = await readRecoveryMarker(resolvedRoot);
			if (recoveryMarker && !recoverStaleLock) throw new TaskStoreRecoveryRequiredError("Task store recovery is required after a stale writer");
			const stateFile = path.join(resolvedRoot, STATE_FILE);
			let state;
			try {
				state = parseStoredState(await readBoundedPrivateFile(stateFile, MAX_STATE_BYTES, "Task store data"));
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
				state = initialState();
				await writePrivateAtomic(stateFile, serializeState(state));
			}
			if (recoveryMarker) {
				const next = cloneJson(state);
				const now = (/* @__PURE__ */ new Date()).toISOString();
				let recoveredFromCrash = false;
				for (const [id, task] of Object.entries(next.tasks)) {
					if (task.state !== "running") continue;
					setOwn(next.tasks, id, {
						...task,
						state: "unknown",
						revision: task.revision + 1,
						updatedAt: now
					});
					recoveredFromCrash = true;
				}
				if (recoveredFromCrash) {
					await writePrivateAtomic(stateFile, serializeState(next));
					state = next;
				}
				await clearRecoveryMarker(resolvedRoot);
			}
			return new TaskStore(resolvedRoot, state, lock);
		} catch (error) {
			await releaseOwnedDirectory(lock);
			throw error;
		}
	}
	async submit(request) {
		this.#assertAcceptingWrites();
		const normalized = normalizeRequest(request);
		return this.#enqueueWrite(async () => {
			const requesterEntries = getOwn(this.#state.idempotency, normalized.requester);
			const existingId = requesterEntries ? getOwn(requesterEntries, normalized.key) : void 0;
			if (existingId) {
				const existing = getOwn(this.#state.tasks, existingId);
				if (!existing || !sameRequest(existing, normalized)) throw new TaskStoreConflictError("Idempotency key is already bound to different request content");
				return cloneJson(existing);
			}
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const task = {
				...cloneJson(normalized),
				id: randomUUID(),
				revision: 1,
				state: "pending_approval",
				createdAt: now,
				updatedAt: now
			};
			const next = cloneJson(this.#state);
			setOwn(next.tasks, task.id, task);
			let entries = getOwn(next.idempotency, task.requester);
			if (!entries) {
				entries = {};
				setOwn(next.idempotency, task.requester, entries);
			}
			setOwn(entries, task.key, task.id);
			await this.#persist(next);
			return cloneJson(task);
		});
	}
	async get(id) {
		this.#assertOpen();
		const task = getOwn(this.#state.tasks, id);
		return task ? cloneJson(task) : void 0;
	}
	async list() {
		this.#assertOpen();
		return cloneJson(Object.values(this.#state.tasks));
	}
	async transition(id, expectedState, nextState, options = {}) {
		this.#assertAcceptingWrites();
		if (!taskStateSet.has(expectedState) || !taskStateSet.has(nextState)) throw new TaskStoreConflictError("Task transition contains an invalid state");
		const expectedRevision = options.expectedRevision;
		if (expectedRevision !== void 0 && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new TaskStoreConflictError("Task transition revision is invalid");
		const result = Object.hasOwn(options, "result") ? boundedJson(options.result, "Task result", MAX_REQUEST_BYTES).value : void 0;
		return this.#enqueueWrite(async () => {
			const current = getOwn(this.#state.tasks, id);
			if (!current) throw new TaskStoreConflictError("Task does not exist");
			if (current.state !== expectedState) throw new TaskStoreConflictError("Task state does not match expected state");
			if (expectedRevision !== void 0 && current.revision !== expectedRevision) throw new TaskStoreConflictError("Task revision does not match expected revision");
			if (!allowedTransitions[current.state].has(nextState)) throw new TaskStoreConflictError("Task transition is not allowed");
			if (result !== void 0 && !resultStates.has(nextState)) throw new TaskStoreConflictError("Task result is only allowed on a terminal state");
			const next = cloneJson(this.#state);
			const updated = {
				...current,
				state: nextState,
				revision: current.revision + 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				...result === void 0 ? {} : { result: cloneJson(result) }
			};
			setOwn(next.tasks, id, updated);
			await this.#persist(next);
			return cloneJson(updated);
		});
	}
	async close() {
		if (!this.#closePromise) {
			this.#closing = true;
			this.#closePromise = (async () => {
				await this.#writeTail;
				await releaseOwnedDirectory(this.#lock);
				this.#closed = true;
			})();
		}
		await this.#closePromise;
	}
	async #persist(next) {
		const serialized = serializeState(next);
		try {
			await writePrivateAtomic(this.#stateFile, serialized);
		} catch {
			this.#poisoned = true;
			throw new TaskStoreDurabilityError("Task store persistence is uncertain; close and reopen the store before reading or writing");
		}
		this.#state = next;
	}
	#enqueueWrite(operation) {
		const guardedOperation = () => {
			this.#assertDurable();
			return operation();
		};
		const result = this.#writeTail.then(guardedOperation, guardedOperation);
		this.#writeTail = result.then(() => void 0, () => void 0);
		return result;
	}
	#assertAcceptingWrites() {
		if (this.#closing || this.#closed) throw new TaskStoreError("Task store is closed");
		this.#assertDurable();
	}
	#assertOpen() {
		if (this.#closed) throw new TaskStoreError("Task store is closed");
		this.#assertDurable();
	}
	#assertDurable() {
		if (this.#poisoned) throw new TaskStoreDurabilityError("Task store persistence is uncertain; close and reopen the store before reading or writing");
	}
};
//#endregion
//#region manager/backends/docker-engine.ts
var DockerOperationError = class extends Error {
	status;
	constructor(message = "Docker operation rejected", status) {
		super(message);
		this.status = status;
	}
};
/** A failed mutating request is not evidence that Docker did nothing. */
var DockerOutcomeUnknownError = class extends DockerOperationError {
	constructor() {
		super("Docker operation outcome unknown; reconciliation required");
	}
};
function bounded$1(value, fallback, max) {
	const n = value ?? fallback;
	if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new DockerOperationError("Invalid Docker transport limit");
	return n;
}
/** Private executor infrastructure, never exposed as a general HTTP proxy. */
var DockerEngine = class {
	#socket;
	#timeout;
	#maxBytes;
	#active = /* @__PURE__ */ new Set();
	#closed = false;
	constructor(socketPath, options = {}) {
		if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) || socketPath.includes("\0")) throw new DockerOperationError("Invalid Docker socket");
		this.#socket = socketPath;
		this.#timeout = bounded$1(options.timeoutMs, 1e4, 12e4);
		this.#maxBytes = bounded$1(options.maxBytes, 1024 * 1024, 4 * 1024 * 1024);
	}
	async call(method, route, value, options = {}) {
		if (this.#closed || this.#active.size >= 16) throw new DockerOperationError("Docker transport unavailable");
		if (![
			"GET",
			"POST",
			"DELETE"
		].includes(method) || typeof route !== "string" || route.length > 8192 || !route.startsWith("/") || route.startsWith("//") || /[\x00-\x20\x7f#\\]/.test(route)) throw new DockerOperationError("Invalid Docker operation");
		let decoded;
		try {
			decoded = decodeURIComponent(route.split("?")[0]);
		} catch {
			throw new DockerOperationError("Invalid Docker operation");
		}
		if (decoded.split("/").some((part) => part === "." || part === "..") || decoded.includes("\0")) throw new DockerOperationError("Invalid Docker operation");
		if (method !== "GET" && options.allowMissing) throw new DockerOperationError("Invalid Docker operation");
		let body;
		try {
			body = value === void 0 ? void 0 : JSON.stringify(value);
		} catch {
			throw new DockerOperationError("Invalid Docker request");
		}
		if (body && Buffer.byteLength(body) > 128 * 1024 || method === "GET" && value !== void 0) throw new DockerOperationError("Invalid Docker request");
		return new Promise((resolve, reject) => {
			let done = false;
			const uncertain = () => method === "GET" ? new DockerOperationError("Docker transport unavailable") : new DockerOutcomeUnknownError();
			const request = http.request({
				socketPath: this.#socket,
				method,
				path: route,
				agent: false,
				headers: body === void 0 ? {} : {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body)
				}
			});
			this.#active.add(request);
			const timer = setTimeout(() => finish(uncertain()), this.#timeout);
			const finish = (error, result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.#active.delete(request);
				request.destroy();
				if (error) reject(error);
				else resolve(result);
			};
			request.on("error", () => finish(uncertain()));
			request.on("response", (response) => {
				let bytes = 0;
				const chunks = [];
				response.on("error", () => finish(uncertain()));
				response.on("aborted", () => finish(uncertain()));
				response.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > this.#maxBytes) {
						finish(method === "GET" ? new DockerOperationError("Docker response limit exceeded") : uncertain());
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (done) return;
					const status = response.statusCode ?? 0;
					if (status === 404 && options.allowMissing) return finish(void 0, null);
					if (status < 200 || status >= 300) return finish(new DockerOperationError("Docker operation rejected", status));
					if (!bytes) return finish(void 0, null);
					try {
						finish(void 0, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
					} catch {
						finish(method === "GET" ? new DockerOperationError("Invalid Docker response") : uncertain());
					}
				});
			});
			request.end(body);
		});
	}
	close() {
		this.#closed = true;
		for (const request of this.#active) request.destroy(/* @__PURE__ */ new Error("closed"));
	}
};
//#endregion
//#region manager/errors.ts
/** A mutation may have happened, or resource control/termination is unconfirmed.
* This signal is executor-private. Never serialize its internal cause/message.
*/
var ExecutionOutcomeUnknownError = class extends Error {
	constructor() {
		super("Execution outcome requires independent reconciliation");
		this.name = "ExecutionOutcomeUnknownError";
	}
};
//#endregion
//#region manager/updates/errors.ts
var catalogMessages = {
	"package-not-approved": "Package is not administrator approved",
	"invalid-version": "Exact stable version required",
	"invalid-query": "Invalid or expired catalog query",
	"metadata-invalid": "Official release metadata invalid",
	"registry-unavailable": "Official registry unavailable"
};
var CatalogError = class extends Error {
	code;
	constructor(code) {
		super(catalogMessages[code]);
		this.name = "CatalogError";
		this.code = code;
	}
};
//#endregion
//#region manager/updates/json.ts
/** Strict bounded JSON, including escaped duplicate keys. No revivers or prototype setters. */
function strictJson(bytes) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	let at = 0, nodes = 0;
	const bad = () => {
		throw new Error("Invalid bounded JSON");
	};
	const ws = () => {
		while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++;
	};
	function string() {
		if (text[at] !== "\"") return bad();
		const start = at++;
		while (at < text.length) {
			const char = text[at++];
			if (char === "\"") return JSON.parse(text.slice(start, at));
			if (char === "\\") at++;
		}
		return bad();
	}
	function value(depth) {
		if (depth > 64 || ++nodes > 5e5) return bad();
		ws();
		const char = text[at];
		if (char === "\"") return string();
		if (char === "{" || char === "[") {
			at++;
			ws();
			const object = char === "{";
			const result = object ? Object.create(null) : [];
			const end = object ? "}" : "]";
			if (text[at] === end) {
				at++;
				return result;
			}
			for (;;) {
				ws();
				if (object) {
					const key = string();
					ws();
					if (Object.hasOwn(result, key) || text[at++] !== ":") return bad();
					result[key] = value(depth + 1);
				} else result.push(value(depth + 1));
				ws();
				if (text[at] === end) {
					at++;
					return result;
				}
				if (text[at++] !== ",") return bad();
			}
		}
		const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
		if (!match) return bad();
		at += match[0].length;
		const result = JSON.parse(match[0]);
		if (typeof result === "number" && !Number.isFinite(result)) return bad();
		return result;
	}
	const result = value(0);
	ws();
	if (at !== text.length) return bad();
	return result;
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region manager/updates/release.ts
var PI_PACKAGE = "@earendil-works/pi-coding-agent";
var REGISTRY = "https://registry.npmjs.org/";
function stableVersion(value) {
	return typeof value === "string" && value.length <= 64 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) && value.split(".").every((n) => Number.isSafeInteger(Number(n)));
}
function compareVersions(a, b) {
	const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
	return 0;
}
function approvedPackages(extensions = []) {
	if (extensions.length > 100 || extensions.some((n) => typeof n !== "string" || n.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(n))) throw new CatalogError("package-not-approved");
	return new Set([PI_PACKAGE, ...extensions]);
}
function releaseFromMetadata(value, name, version) {
	const bad = () => {
		throw new CatalogError("metadata-invalid");
	};
	if (!stableVersion(version) || !record(value) || value.name !== name || value.version !== version || !record(value.dist) || !record(value.engines)) return bad();
	const tarball = `${REGISTRY}${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
	const integrity = value.dist.integrity, nodeEngine = value.engines.node;
	if (value.dist.tarball !== tarball || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) return bad();
	const digest = Buffer.from(integrity.slice(7), "base64");
	if (digest.length !== 64 || digest.toString("base64") !== integrity.slice(7) || typeof nodeEngine !== "string" || nodeEngine.length === 0 || nodeEngine.length > 256 || /[\x00-\x1f\x7f]/.test(nodeEngine)) return bad();
	const fields = {
		packageName: name,
		version,
		tarball,
		integrity,
		nodeEngine
	};
	const identity = createHash("sha256").update(JSON.stringify([
		"official-artifact-v1",
		name,
		version,
		tarball,
		integrity,
		nodeEngine
	])).digest("hex");
	return Object.freeze({
		...fields,
		identity
	});
}
//#endregion
//#region manager/updates/transport.ts
var TransportError = class extends Error {
	code;
	constructor(code) {
		super("Official transport refused");
		this.code = code;
	}
};
var directTransport = ({ url, signal, accept }) => new Promise((resolve, reject) => {
	const agent = new Agent({
		keepAlive: false,
		maxSockets: 1,
		proxyEnv: {}
	});
	const req = request(url, {
		agent,
		method: "GET",
		signal,
		rejectUnauthorized: true,
		ca: [...rootCertificates],
		checkServerIdentity,
		maxHeaderSize: 16 * 1024,
		headers: {
			accept,
			"accept-encoding": "identity"
		}
	}, (res) => {
		res.once("close", () => agent.destroy());
		resolve({
			url,
			statusCode: res.statusCode ?? 0,
			headers: res.headers,
			body: res
		});
	});
	req.once("error", () => {
		agent.destroy();
		reject(new TransportError("unavailable"));
	});
	req.end();
});
async function boundedDownload(url, maxBytes, timeoutMs, transport = directTransport, metadataFormat = "abbreviated") {
	const parsed = new URL(url);
	if (parsed.origin !== "https://registry.npmjs.org" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== url) throw new TransportError("refused");
	const controller = new AbortController();
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			reject(new TransportError("timeout"));
			controller.abort();
		}, timeoutMs);
	});
	const download = async () => {
		const accept = url.endsWith(".tgz") ? "application/octet-stream" : metadataFormat === "full" ? "application/json" : "application/vnd.npm.install-v1+json";
		const res = await transport(Object.freeze({
			url,
			signal: controller.signal,
			maxBytes,
			timeoutMs,
			accept
		}));
		if (res.statusCode !== 200 || res.url !== url) throw new TransportError("refused");
		const encoding = res.headers["content-encoding"];
		if (encoding !== void 0 && encoding !== "identity") throw new TransportError("refused");
		const length = res.headers["content-length"];
		if (length !== void 0 && (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxBytes)) throw new TransportError("limit");
		let size = 0;
		const chunks = [];
		for await (const chunk of res.body) {
			if (controller.signal.aborted) throw new TransportError("timeout");
			if (!(chunk instanceof Uint8Array)) throw new TransportError("refused");
			size += chunk.byteLength;
			if (size > maxBytes) throw new TransportError("limit");
			chunks.push(Buffer.from(chunk));
		}
		if (length !== void 0 && Number(length) !== size) throw new TransportError("refused");
		return Buffer.concat(chunks, size);
	};
	try {
		return await Promise.race([download(), deadline]);
	} catch (error) {
		throw error instanceof TransportError ? error : new TransportError("unavailable");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
//#endregion
//#region manager/updates/catalog.ts
var ReleaseCatalog = class {
	#packages;
	#transport;
	#now;
	#metadataDeadlineMs;
	#cache = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		const metadataDeadlineMs = options.metadataDeadlineMs === void 0 ? 8e3 : options.metadataDeadlineMs;
		if (!Number.isSafeInteger(metadataDeadlineMs) || metadataDeadlineMs < 1 || metadataDeadlineMs > 8e3) throw new CatalogError("invalid-query");
		this.#packages = approvedPackages(options.extensionPackages);
		this.#transport = options.transport;
		this.#now = options.now ?? Date.now;
		this.#metadataDeadlineMs = metadataDeadlineMs;
	}
	#approved(name) {
		if (!this.#packages.has(name)) throw new CatalogError("package-not-approved");
	}
	async #metadata(name, version) {
		try {
			return strictJson(await boundedDownload(`${REGISTRY}${encodeURIComponent(name)}${version ? "/" + version : ""}`, 8 * 1024 * 1024, this.#metadataDeadlineMs, this.#transport, version ? "full" : "abbreviated"));
		} catch (error) {
			throw new CatalogError(error instanceof TransportError && ["unavailable", "timeout"].includes(error.code) ? "registry-unavailable" : "metadata-invalid");
		}
	}
	async #refresh(name, cache) {
		if (cache.pending) return cache.pending;
		if (this.#now() < cache.retryAt) return;
		cache.pending = (async () => {
			try {
				const value = await this.#metadata(name);
				if (!record(value) || value.name !== name || !record(value.versions)) throw new CatalogError("metadata-invalid");
				const keys = Object.keys(value.versions);
				if (keys.length > 2e4) throw new CatalogError("metadata-invalid");
				const versions = keys.filter(stableVersion).sort((a, b) => compareVersions(b, a));
				for (const version of versions) releaseFromMetadata(value.versions[version], name, version);
				cache.versions = Object.freeze(versions);
				cache.checkedAt = this.#now();
				cache.freshUntil = cache.checkedAt + 3e5;
				cache.retryAt = cache.freshUntil;
			} catch {
				cache.retryAt = this.#now() + 3e4;
			}
		})();
		try {
			await cache.pending;
		} finally {
			cache.pending = void 0;
		}
	}
	async list(name, options = {}) {
		this.#approved(name);
		const { query = "", cursor, limit = 50 } = options;
		if (typeof query !== "string" || query.length > 64 || !/^[0-9.]*$/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 100 || cursor !== void 0 && (typeof cursor !== "string" || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new CatalogError("invalid-query");
		let cache = this.#cache.get(name);
		if (!cache) {
			cache = {
				checkedAt: null,
				freshUntil: 0,
				retryAt: 0
			};
			this.#cache.set(name, cache);
		}
		await this.#refresh(name, cache);
		if (!cache.versions) {
			if (cursor) throw new CatalogError("invalid-query");
			return Object.freeze({
				status: "unavailable",
				versions: Object.freeze([]),
				checkedAt: null,
				error: "registry-unavailable"
			});
		}
		const matching = cache.versions.filter((v) => v.startsWith(query));
		const tag = createHash("sha256").update(JSON.stringify([
			name,
			query,
			limit,
			cache.versions
		])).digest("hex");
		let offset = 0;
		if (cursor) try {
			const raw = Buffer.from(cursor, "base64url");
			if (raw.toString("base64url") !== cursor) throw new Error();
			const parsed = strictJson(raw);
			if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== tag || !Number.isInteger(parsed[1]) || parsed[1] <= 0 || parsed[1] >= matching.length || parsed[1] % limit) throw new Error();
			offset = parsed[1];
		} catch {
			throw new CatalogError("invalid-query");
		}
		const fresh = this.#now() < cache.freshUntil;
		return Object.freeze({
			status: fresh ? "fresh" : "stale",
			checkedAt: cache.checkedAt,
			versions: Object.freeze(matching.slice(offset, offset + limit)),
			...!fresh ? { error: "registry-unavailable" } : {},
			...offset + limit < matching.length ? { nextCursor: Buffer.from(JSON.stringify([tag, offset + limit])).toString("base64url") } : {}
		});
	}
	async resolve(name, version) {
		this.#approved(name);
		if (!stableVersion(version)) throw new CatalogError("invalid-version");
		return releaseFromMetadata(await this.#metadata(name, version), name, version);
	}
};
//#endregion
//#region protocol/connection-config.ts
/** Never include the supplied value in errors: it may contain a credential. */
function validatedPublicUrl(value) {
	if (typeof value !== "string") throw new Error("Invalid Pi Web public URL");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid Pi Web public URL");
	}
	const loopback = [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname);
	if (!(url.protocol === "https:" || url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Pi Web public URL");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}
//#endregion
//#region protocol/hub-generation.ts
var BOUNDED_GENERATION_SOURCE = "b2-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}";
var HUB_GENERATION_SOURCE = `(?:[a-f0-9]{32}|${BOUNDED_GENERATION_SOURCE})`;
new RegExp(`^${BOUNDED_GENERATION_SOURCE}$`);
new RegExp(`^${HUB_GENERATION_SOURCE}$`);
new RegExp(`^/s/${HUB_GENERATION_SOURCE}/$`);
//#endregion
//#region protocol/interactions/protocol.ts
var INTERACTION_PROTOCOL = "pi-web-interactions-v1";
var INTERACTION_LIMITS = Object.freeze({
	requestBytes: 64 * 1024,
	pendingPerPi: 8,
	pendingPerHub: 64,
	hubBytes: 4 * 1024 * 1024,
	confirmationMs: 12e4,
	oauthMs: 6e5,
	completedCount: 128,
	completedMs: 3e5,
	completedBytes: 256 * 1024,
	panelItems: 100
});
function invalidInteraction() {
	throw new Error("Invalid interaction");
}
function plainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, required, optional = []) {
	if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalidInteraction();
}
function opaqueId(value, length = 32) {
	return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}
/** Strict JSON only. Never invoke toJSON/getters or silently omit undefined fields. */
function canonicalJson(value) {
	const seen = /* @__PURE__ */ new Set();
	let budget = INTERACTION_LIMITS.requestBytes;
	const consume = (text) => {
		budget -= Buffer.byteLength(text);
		if (budget < 0) invalidInteraction();
		return text;
	};
	const visit = (item, depth) => {
		if (depth > 32) invalidInteraction();
		if (item === null || typeof item === "boolean") return consume(String(item));
		if (typeof item === "string") return consume(JSON.stringify(item));
		if (typeof item === "number" && Number.isFinite(item)) return consume(JSON.stringify(item));
		if (typeof item !== "object" || item === null || seen.has(item)) invalidInteraction();
		seen.add(item);
		let result;
		if (Array.isArray(item)) {
			if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length) invalidInteraction();
			const parts = Array.from({ length: item.length }, (_, i) => {
				const property = Object.getOwnPropertyDescriptor(item, String(i));
				if (!property || !("value" in property)) invalidInteraction();
				return visit(property.value, depth + 1);
			});
			budget -= Math.max(0, parts.length - 1);
			result = consume("[") + parts.join(",") + consume("]");
		} else {
			if (!plainRecord(item) || Object.getOwnPropertySymbols(item).length) invalidInteraction();
			const parts = Object.keys(item).sort().map((key) => {
				if ([
					"__proto__",
					"constructor",
					"prototype"
				].includes(key)) invalidInteraction();
				const property = Object.getOwnPropertyDescriptor(item, key);
				if (!property || !("value" in property)) invalidInteraction();
				return consume(JSON.stringify(key)) + consume(":") + visit(property.value, depth + 1);
			});
			budget -= Math.max(0, parts.length - 1);
			result = consume("{") + parts.join(",") + consume("}");
		}
		seen.delete(item);
		if (budget < 0) invalidInteraction();
		return result;
	};
	return visit(value, 0);
}
//#endregion
//#region protocol/interactions/enrollment.ts
/** Public authority only. This value must come from host-owned per-run enrollment. */
function validateInteractionPin(value) {
	try {
		if (!plainRecord(value)) throw new Error();
		exactKeys(value, [
			"protocol",
			"issuer",
			"publicKey"
		], ["managementOrigin"]);
		if (value.protocol !== "pi-web-interactions-v1" || !opaqueId(value.issuer, 64) || typeof value.publicKey !== "string" || value.publicKey.length > 1024) throw new Error();
		const key = createPublicKey(value.publicKey);
		const encoded = key.export({
			format: "der",
			type: "spki"
		});
		if (key.asymmetricKeyType !== "ed25519" || createHash("sha256").update(encoded).digest("hex") !== value.issuer) throw new Error();
		if (value.managementOrigin !== void 0) {
			if (typeof value.managementOrigin !== "string") throw new Error();
			const url = new URL(value.managementOrigin);
			if (url.origin !== value.managementOrigin || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && [
				"127.0.0.1",
				"[::1]",
				"localhost"
			].includes(url.hostname))) throw new Error();
		}
		return {
			protocol: INTERACTION_PROTOCOL,
			issuer: value.issuer,
			publicKey: key.export({
				type: "spki",
				format: "pem"
			}).toString(),
			...value.managementOrigin === void 0 ? {} : { managementOrigin: value.managementOrigin }
		};
	} catch {
		throw new Error("Invalid interaction authority enrollment");
	}
}
//#endregion
//#region protocol/interactions/proof.ts
function signInteractionEvidence(privateKey, claim) {
	const serialized = canonicalJson(claim);
	return {
		claim: JSON.parse(serialized),
		signature: sign(null, Buffer.from(serialized), privateKey).toString("base64url")
	};
}
//#endregion
//#region hub/state-budget.ts
var STATE_LIMIT = 8 * 1024 * 1024;
var SECURITY_RESERVE = 64 * 1024;
var SCAN_ENTRIES = 32768;
var StateBudgetError = class extends Error {
	constructor() {
		super("Hub state quota exceeded");
	}
};
function privateStat(stat) {
	if (process.platform !== "win32" && ((Number(stat.mode) & 63) !== 0 || stat.uid !== process.getuid?.())) throw new Error("Unsafe private Hub state");
}
function privateStateDirectory(directory) {
	const created = mkdirSync(directory, {
		recursive: true,
		mode: 448
	});
	const stat = lstatSync(directory);
	privateStat(stat);
	if (!stat.isDirectory()) throw new Error("Unsafe private Hub directory");
	if (created) {
		const parent = path.dirname(path.resolve(created));
		for (let current = path.resolve(directory);; current = path.dirname(current)) {
			syncDirectory(current);
			if (current === parent) break;
		}
	}
}
function readStateJson(file) {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		privateStat(stat);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Invalid private Hub file");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
function syncDirectory(directory) {
	const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** Empty directory locks are never stolen, even after a crash. No PID guessing. */
function acquireStateLock(config, name) {
	privateStateDirectory(config.stateDir);
	const root = realpathSync(config.stateDir);
	const lock = path.join(root, name);
	try {
		mkdirSync(lock, { mode: 448 });
	} catch {
		throw new Error("Hub state lock busy; trusted recovery may be required");
	}
	const identity = lstatSync(lock);
	let released = false;
	return {
		root,
		release() {
			if (released) return;
			try {
				const current = lstatSync(lock);
				if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Hub lock ownership changed");
				rmdirSync(lock);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			released = true;
		}
	};
}
function exportCharge(value) {
	const bytes = value?.exportBytes ?? 0;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8192) throw new Error("Invalid export reservation");
	return bytes;
}
function scan(root) {
	const totals = {
		logicalBytes: 0,
		files: 0,
		activeGrants: 0,
		revokedGrants: 0,
		generationFiles: 0,
		receiptFiles: 0,
		exportReservedBytes: 0
	};
	let entries = 0;
	const visit = (directory, depth) => {
		if (depth > 4) throw new StateBudgetError();
		const dir = opendirSync(directory);
		try {
			for (let item = dir.readSync(); item; item = dir.readSync()) {
				if (++entries > SCAN_ENTRIES) throw new StateBudgetError();
				const file = path.join(directory, item.name);
				const stat = lstatSync(file);
				privateStat(stat);
				if (stat.isDirectory()) {
					visit(file, depth + 1);
					continue;
				}
				if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub state");
				totals.files++;
				totals.logicalBytes += stat.size;
				const relative = path.relative(root, file);
				if (/^grants\/[a-f0-9]{32}\.json$/.test(relative)) {
					const grant = readStateJson(file);
					if (grant.revoked !== void 0 && typeof grant.revoked !== "boolean") throw new Error("Invalid grant state");
					if (grant.revoked) totals.revokedGrants++;
					else totals.activeGrants++;
					const charge = exportCharge(grant);
					totals.exportReservedBytes += charge;
					totals.logicalBytes += charge;
				}
				if (/^(generations|bounded)\//.test(relative)) totals.generationFiles++;
				if (relative.startsWith("restarts/")) totals.receiptFiles++;
			}
		} finally {
			dir.closeSync();
		}
	};
	visit(root, 0);
	return totals;
}
/** Synchronous transaction: never hold across backend proof or other await. */
var StateWriter = class {
	totals;
	root;
	constructor(root) {
		this.root = root;
	}
	/** Also fence authority-only transitions, such as legacy lease renewal. */
	assertAdmission() {
		this.totals ??= scan(this.root);
		if (this.totals.activeGrants > 512 || this.totals.logicalBytes > 8388608) throw new StateBudgetError();
	}
	destination(relative) {
		if (!/^(?:grants\/[a-f0-9]{32}\.json|generations\/[a-f0-9]{32}\.json|bounded\/[a-f0-9]{32}\.json|restarts\/[a-f0-9]{32}(?:\.started|\.verified)?\.json|management\.json|interaction-signing\.json|registry\.json)$/.test(relative)) throw new Error("Invalid Hub state destination");
		const file = path.join(this.root, relative);
		privateStateDirectory(path.dirname(file));
		return file;
	}
	write(relative, value, options = {}) {
		const file = this.destination(relative);
		const data = Buffer.from(`${JSON.stringify(value)}\n`);
		if (data.length > 8192) throw new StateBudgetError();
		let oldBytes = 0;
		let old;
		let exists = false;
		try {
			const stat = lstatSync(file);
			privateStat(stat);
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub file");
			exists = true;
			oldBytes = stat.size;
			old = readStateJson(file);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (options.exclusive && exists) throw new Error("Hub state already exists");
		this.totals ??= scan(this.root);
		const totals = this.totals;
		const isGrant = relative.startsWith("grants/");
		const oldCharge = isGrant && exists ? exportCharge(old) : 0;
		const newCharge = isGrant ? exportCharge(value) : 0;
		const activeDelta = isGrant ? Number(!value.revoked) - Number(exists && !old?.revoked) : 0;
		const peak = totals.logicalBytes + data.length + Math.max(0, newCharge - oldCharge);
		const ceiling = options.security ? STATE_LIMIT : STATE_LIMIT - SECURITY_RESERVE;
		const revocation = options.security && isGrant && activeDelta === -1 && value.revoked === true && JSON.stringify(value) === JSON.stringify({
			...old,
			revoked: true
		});
		if (peak > ceiling || (totals.activeGrants > 512 || totals.activeGrants + activeDelta > 512) && !revocation) throw new StateBudgetError();
		const temporary = path.join(path.dirname(file), `.write-${randomBytes(16).toString("hex")}`);
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (options.exclusive) {
			linkSync(temporary, file);
			unlinkSync(temporary);
		} else renameSync(temporary, file);
		syncDirectory(path.dirname(file));
		totals.logicalBytes += data.length - oldBytes + newCharge - oldCharge;
		totals.activeGrants += activeDelta;
		this.totals = void 0;
	}
	diagnostics() {
		const totals = scan(this.root);
		return {
			...totals,
			limitBytes: STATE_LIMIT,
			activeGrantLimit: 512,
			securityReserveBytes: SECURITY_RESERVE,
			overBudget: totals.logicalBytes > 8388608 || totals.activeGrants > 512
		};
	}
};
function withStateWriter(config, operation) {
	const lock = acquireStateLock(config, ".writer.lock");
	try {
		const result = operation(new StateWriter(lock.root));
		if (result && typeof result.then === "function") throw new Error("Hub writer cannot cross an await");
		return result;
	} finally {
		lock.release();
	}
}
/** Grant must already be durable and charged before publishing an export. */
function publishCredential(file, credential) {
	const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
	try {
		writeFileSync(fd, `${JSON.stringify(credential)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	syncDirectory(path.dirname(file));
}
//#endregion
//#region hub/interaction-signing.ts
function interactionSigning(config) {
	if (!config.management) throw new Error("Interaction management is not configured");
	const stored = withStateWriter(config, (writer) => {
		const file = path.join(config.stateDir, "interaction-signing.json");
		if (!existsSync(file)) {
			const pair = generateKeyPairSync("ed25519");
			writer.write("interaction-signing.json", {
				schema: 1,
				privateKey: pair.privateKey.export({
					type: "pkcs8",
					format: "pem"
				}).toString(),
				publicKey: pair.publicKey.export({
					type: "spki",
					format: "pem"
				}).toString()
			}, { exclusive: true });
		}
		return readStateJson(file);
	});
	if (stored.schema !== 1 || Object.keys(stored).sort().join(",") !== "privateKey,publicKey,schema") throw new Error("Interaction signing unavailable");
	const privateKey = createPrivateKey(stored.privateKey);
	const publicKey = createPublicKey(privateKey);
	if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.export({
		type: "spki",
		format: "pem"
	}).toString() !== stored.publicKey) throw new Error("Interaction signing unavailable");
	const pin = validateInteractionPin({
		protocol: INTERACTION_PROTOCOL,
		issuer: createHash("sha256").update(publicKey.export({
			type: "spki",
			format: "der"
		})).digest("hex"),
		publicKey: stored.publicKey,
		...config.management.publicUrl ? { managementOrigin: new URL(config.management.publicUrl).origin } : {}
	});
	const epoch = randomBytes(16).toString("hex");
	return {
		pin,
		epoch,
		sign: (claim) => signInteractionEvidence(privateKey, {
			...claim,
			protocol: INTERACTION_PROTOCOL,
			audience: "pi-interaction-broker",
			issuer: pin.issuer,
			epoch
		})
	};
}
//#endregion
//#region hub/lifecycle.ts
function lifecycleConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lifecycle provider");
	const v = value;
	if (Object.keys(v).sort().join(",") !== "credentialFile,endpoint" || typeof v.endpoint !== "string" || typeof v.credentialFile !== "string" || !path.isAbsolute(v.credentialFile) || v.credentialFile.includes("\0")) throw new Error("Invalid lifecycle provider");
	const endpoint = new URL(v.endpoint);
	if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !endpoint.port) throw new Error("Invalid lifecycle provider");
	return {
		endpoint: endpoint.origin,
		credentialFile: v.credentialFile
	};
}
//#endregion
//#region hub/config.ts
function privateDirectory(directory) {
	privateStateDirectory(directory);
}
function readPrivateJson(file) {
	return readStateJson(file);
}
function readHubConfig(file) {
	const value = readPrivateJson(file);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hub configuration");
	const host = value.host ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Hub HTTP must bind to loopback; use a trusted TLS gateway");
	const port = value.port ?? 16180;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
	const leaseMs = value.leaseMs ?? 45e3;
	if (!Number.isInteger(leaseMs) || leaseMs < 500 || leaseMs > 3e5) throw new Error("Invalid hub lease");
	const parent = path.dirname(path.resolve(file));
	if (value.stateDir !== void 0 && (typeof value.stateDir !== "string" || !value.stateDir || value.stateDir.includes("\0"))) throw new Error("Invalid hub state directory");
	const stateDir = path.resolve(parent, value.stateDir ?? "state");
	if (value.runtimeDir !== void 0 && (typeof value.runtimeDir !== "string" || !value.runtimeDir || value.runtimeDir.includes("\0"))) throw new Error("Invalid hub runtime directory");
	const runtimeDir = path.resolve(parent, value.runtimeDir ?? "runtime");
	if (runtimeDir === stateDir || runtimeDir.startsWith(`${stateDir}${path.sep}`) || stateDir.startsWith(`${runtimeDir}${path.sep}`)) throw new Error("Hub IPC and administrator state must be separate directories");
	const publicUrl = value.publicUrl === void 0 ? void 0 : validatedPublicUrl(value.publicUrl);
	if (publicUrl && new URL(publicUrl).pathname !== "/") throw new Error("Hub public URL must use the domain root");
	const managerLinks = value.managerLinks === void 0 ? void 0 : managerLinksConfig(value.managerLinks, publicUrl);
	if (process.platform === "win32") throw new Error("Bundled hub currently requires Unix IPC (Linux/macOS); standalone Pi Web still works");
	const lifecycle = value.lifecycle === void 0 ? void 0 : lifecycleConfig(value.lifecycle);
	const runtimeUpdates = value.runtimeUpdates === void 0 ? void 0 : lifecycleConfig(value.runtimeUpdates);
	const gateManagement = value.gateManagement === void 0 ? void 0 : lifecycleConfig(value.gateManagement);
	const management = value.management === void 0 ? void 0 : managementConfig(value.management, port, publicUrl);
	return {
		stateDir,
		runtimeDir,
		socketPath: path.join(runtimeDir, "registry.sock"),
		host,
		port,
		leaseMs,
		publicUrl,
		...managerLinks ? { managerLinks } : {},
		...lifecycle ? { lifecycle } : {},
		...runtimeUpdates ? { runtimeUpdates } : {},
		...gateManagement ? { gateManagement } : {},
		...management ? { management } : {}
	};
}
function managerLinksConfig(value, chatPublicUrl) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid manager links configuration");
	const links = value;
	if (Object.keys(links).some((key) => key !== "requester" && key !== "administrator") || !chatPublicUrl) throw new Error("Manager links require a canonical chat public URL");
	const root = (url) => {
		const canonical = validatedPublicUrl(url);
		if (canonical !== `${new URL(canonical).origin}/`) throw new Error("Manager links must use canonical root URLs");
		return canonical;
	};
	const requester = root(links.requester);
	const administrator = links.administrator === void 0 ? void 0 : root(links.administrator);
	const origins = [
		new URL(chatPublicUrl).origin,
		new URL(requester).origin,
		...administrator ? [new URL(administrator).origin] : []
	];
	if (new Set(origins).size !== origins.length) throw new Error("Manager links must use separate origins");
	return {
		requester,
		...administrator ? { administrator } : {}
	};
}
function managementConfig(value, chatPort, chatPublicUrl) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management configuration");
	const v = value;
	if (Object.keys(v).some((key) => ![
		"port",
		"publicUrl",
		"gateway"
	].includes(key)) || !Number.isInteger(v.port) || Number(v.port) < 0 || Number(v.port) > 65535 || v.port !== 0 && v.port === chatPort) throw new Error("Management requires a distinct port");
	const publicUrl = v.publicUrl === void 0 ? void 0 : validatedPublicUrl(v.publicUrl);
	if (publicUrl && (!chatPublicUrl || new URL(publicUrl).pathname !== "/" || new URL(publicUrl).origin === new URL(chatPublicUrl).origin)) throw new Error("Management requires a distinct canonical public origin");
	let gateway;
	if (v.gateway !== void 0) {
		const g = v.gateway;
		if (!g || typeof g !== "object" || Array.isArray(g) || Object.keys(g).join(",") !== "credentialFile" || typeof g.credentialFile !== "string" || !path.isAbsolute(g.credentialFile) || g.credentialFile.includes("\0") || publicUrl && !publicUrl.startsWith("https:")) throw new Error("Invalid management gateway configuration");
		gateway = { credentialFile: g.credentialFile };
	}
	return {
		port: Number(v.port),
		...publicUrl ? { publicUrl } : {},
		...gateway ? { gateway } : {}
	};
}
function validHost(host) {
	return Boolean(isIP(host)) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host);
}
function hasControls(value) {
	return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function readGrant(config, runId) {
	if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid session capability");
	const grant = readPrivateJson(path.join(config.stateDir, "grants", `${runId}.json`));
	if (grant.run_id !== runId || !/^[0-9a-f]{64}$/.test(grant.token) || typeof grant.label !== "string" || grant.label.length > 120 || hasControls(grant.label) || typeof grant.backendHost !== "string" || !validHost(grant.backendHost) || grant.revoked !== void 0 && typeof grant.revoked !== "boolean" || grant.provisionKey !== void 0 && !validProvisionKey(grant.provisionKey)) throw new Error("Invalid session capability");
	return grant;
}
var validProvisionKey = (key) => typeof key === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key);
/** Local private-state lookup only. Caller holds the existing state writer lock. */
function provisionGrant(config, key) {
	if (!validProvisionKey(key)) throw new Error("Invalid provisioning key");
	const dir = opendirSync(path.join(config.stateDir, "grants"));
	let found;
	let count = 0;
	try {
		for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
			if (++count > 32768) throw new Error("Hub grant scan limit exceeded");
			if (!/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
			const grant = readGrant(config, entry.name.slice(0, -5));
			if (grant.provisionKey !== key) continue;
			if (found) throw new Error("Ambiguous provisioning key");
			found = grant;
		}
	} finally {
		dir.closeSync();
	}
	return found;
}
function issueSession(config, output, options) {
	privateDirectory(config.stateDir);
	privateDirectory(path.join(config.stateDir, "grants"));
	const backendHost = options.backendHost ?? "127.0.0.1";
	if (!validHost(backendHost) || !options.label.trim() || options.label.length > 120 || hasControls(options.label)) throw new Error("Invalid session label or backend host");
	if (options.provisionKey !== void 0 && !validProvisionKey(options.provisionKey)) throw new Error("Invalid provisioning key");
	const credential = {
		run_id: randomBytes(16).toString("hex"),
		token: randomBytes(32).toString("hex"),
		...config.management ? { interactions: interactionSigning(config).pin } : {}
	};
	const grant = {
		...credential,
		label: options.label,
		backendHost,
		revoked: false,
		exportBytes: Buffer.byteLength(`${JSON.stringify(credential)}\n`),
		...options.provisionKey ? { provisionKey: options.provisionKey } : {}
	};
	const resolvedOutput = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
	const stateRoot = realpathSync(config.stateDir);
	if (resolvedOutput === config.socketPath || resolvedOutput === stateRoot || resolvedOutput.startsWith(`${stateRoot}${path.sep}`)) throw new Error("Session credential must be outside the administrator state directory");
	return withStateWriter(config, (writer) => {
		if (options.provisionKey) {
			writer.assertAdmission();
			const previous = provisionGrant(config, options.provisionKey);
			if (previous) {
				if (previous.revoked || previous.label !== options.label || previous.backendHost !== backendHost) throw new Error("Provisioning conflict");
				const saved = {
					run_id: previous.run_id,
					token: previous.token,
					...previous.interactions ? { interactions: previous.interactions } : {}
				};
				try {
					lstatSync(resolvedOutput);
					if (!isDeepStrictEqual(readPrivateJson(resolvedOutput), saved)) throw new Error("Provisioning export conflict");
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
					publishCredential(resolvedOutput, saved);
				}
				return saved;
			}
		}
		try {
			lstatSync(resolvedOutput);
			throw new Error("Credential output already exists");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		writer.write(`grants/${credential.run_id}.json`, grant, { exclusive: true });
		publishCredential(resolvedOutput, credential);
		return credential;
	});
}
function revokeSession(config, runId) {
	withStateWriter(config, (writer) => {
		const grant = readGrant(config, runId);
		if (!grant.revoked) writer.write(`grants/${runId}.json`, {
			...grant,
			revoked: true
		}, { security: true });
	});
}
//#endregion
//#region manager/workspaces.ts
var DIRECTORY_LIMIT = 200;
function contains(root, value) {
	const relative = path.relative(root, value);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function overlaps$1(left, right) {
	return contains(left, right) || contains(right, left);
}
function relativePath(value) {
	requireThat(typeof value === "string" && value.length <= 4096 && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"));
	if (value === "") return value;
	requireThat(value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
	return value;
}
function configuredRelativePath(value) {
	requireThat(typeof value === "string" && value.length <= 512 && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."));
	const normalized = path.posix.normalize(value);
	return normalized === "." ? "" : normalized;
}
function workspaceSelection(value) {
	const selection = record$1(value);
	keys(selection, ["root", "path"]);
	return {
		root: identifier$1(selection.root),
		path: relativePath(selection.path)
	};
}
function browserQuery(value) {
	return workspaceSelection(value);
}
/** Separate from launch selection: search/sort parameters can never become a workspace. */
function localBrowseQuery(value) {
	const input = record$1(value);
	keys(input, ["root", "path"], [
		"query",
		"sort",
		"offset"
	]);
	const selection = workspaceSelection({
		root: input.root,
		path: input.path
	});
	const query = input.query === void 0 ? "" : input.query;
	const sort = input.sort === void 0 ? "name-asc" : input.sort;
	const offset = input.offset === void 0 ? 0 : input.offset;
	requireThat(typeof query === "string" && query.length <= 200 && !/[\x00-\x1f\x7f]/u.test(query));
	requireThat([
		"name-asc",
		"name-desc",
		"modified-desc",
		"modified-asc"
	].includes(sort));
	requireThat(Number.isSafeInteger(offset) && Number(offset) >= 0 && Number(offset) <= 1e6);
	return {
		...selection,
		query,
		sort,
		offset
	};
}
async function canonicalFuturePath(value) {
	let current = value;
	const suffix = [];
	while (true) try {
		await lstat(current);
		return path.join(await realpath(current), ...suffix);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const parent = path.dirname(current);
		if (parent === current) throw error;
		suffix.unshift(path.basename(current));
		current = parent;
	}
}
function configuredRoots(config) {
	return (config.docker ?? config.native)?.workspaceRoots ?? {};
}
function configuredProtectedPaths(config) {
	const result = [
		config.stateRoot,
		path.dirname(config.submitSocket),
		path.dirname(config.adminSocket),
		fileURLToPath(new URL("..", import.meta.url))
	];
	if (config.docker) {
		result.push(config.docker.stateRoot, config.docker.socketPath, ...config.docker.protectedRoots ?? []);
		if (config.docker.web) {
			result.push(config.docker.web.packageRoot);
			if (config.docker.web.hubConfigFile) {
				result.push(config.docker.web.hubConfigFile);
				const hub = readHubConfig(config.docker.web.hubConfigFile);
				result.push(hub.stateDir, hub.runtimeDir);
			}
			if (config.docker.web.enrollment) {
				const e = enrollmentConfig(config.docker.web.enrollment);
				result.push(path.dirname(e.socketPath), e.authorityFile);
			}
			if (config.docker.web.provider) result.push(config.docker.web.provider.packageRoot);
		}
		result.push(...runtimeProfileSources(config.docker.runtimeProfile));
	}
	if (config.native) {
		result.push(config.native.stateRoot, config.native.agentRoot, config.native.piExecutable);
		if (config.native.provider) result.push(config.native.provider.extensionPath);
		if (config.native.web) {
			result.push(config.native.web.extensionPath, config.native.web.hubConfigFile);
			const hub = readHubConfig(config.native.web.hubConfigFile);
			result.push(hub.stateDir, hub.runtimeDir);
		}
	}
	return result;
}
/** Executor-owned filesystem policy. No requester path reaches an adapter without this resolver. */
var WorkspacePolicy = class WorkspacePolicy {
	#config;
	#roots;
	#protected;
	#browser;
	constructor(config, roots, protectedPaths) {
		this.#config = structuredClone(config);
		this.#roots = Object.freeze(roots);
		this.#protected = Object.freeze(protectedPaths);
		this.#browser = config.workspaceBrowser ? Object.freeze({
			defaultRoot: config.workspaceBrowser.defaultRoot,
			roots: Object.freeze(Object.keys(roots).map((id) => Object.freeze({
				id,
				label: id
			})))
		}) : null;
	}
	static async open(config) {
		try {
			const roots = {};
			for (const [id, configured] of Object.entries(configuredRoots(config))) {
				identifier$1(id);
				const canonical = await realpath(configured);
				requireThat(canonical === configured && (await stat(canonical)).isDirectory());
				roots[id] = canonical;
			}
			const protectedPaths = await Promise.all(configuredProtectedPaths(config).map(canonicalFuturePath));
			if (config.docker?.web?.enrollment) {
				const e = enrollmentConfig(config.docker.web.enrollment);
				protectedPaths.push(e.registryHostDirectory, e.exportHostDirectory);
			}
			if (config.workspaceBrowser) {
				const home = await realpath(config.workspaceBrowser.home);
				requireThat(home === config.workspaceBrowser.home && (await stat(home)).isDirectory());
				for (const root of Object.values(roots)) requireThat(root !== home && contains(home, root));
				requireThat(Object.hasOwn(roots, config.workspaceBrowser.defaultRoot));
				for (const root of Object.values(roots)) requireThat(!protectedPaths.some((privatePath) => contains(privatePath, root)));
			}
			return new WorkspacePolicy(config, roots, [...new Set(protectedPaths)]);
		} catch (error) {
			if (error instanceof ManagerError) throw error;
			throw new ManagerError(400);
		}
	}
	browser() {
		return this.#browser ? structuredClone(this.#browser) : null;
	}
	async #directory(selection, allowBrowserRoot) {
		try {
			requireThat(Object.hasOwn(this.#roots, selection.root));
			const root = this.#roots[selection.root];
			let current = root;
			if (selection.path !== "") for (const segment of selection.path.split("/")) {
				current = path.join(current, segment);
				const metadata = await lstat(current);
				requireThat(metadata.isDirectory() && !metadata.isSymbolicLink());
			}
			const canonical = await realpath(current);
			requireThat(canonical === current && contains(root, canonical) && (await stat(canonical)).isDirectory());
			if (!(allowBrowserRoot && selection.path === "")) requireThat(!this.#protected.some((privatePath) => overlaps$1(canonical, privatePath)));
			return canonical;
		} catch (error) {
			if (error instanceof ManagerError) throw error;
			throw new ManagerError(400);
		}
	}
	async resolve(value) {
		let selection;
		if (typeof value === "string") {
			const id = identifier$1(value);
			requireThat(Object.hasOwn(this.#config.workspaces, id));
			const configured = this.#config.workspaces[id];
			selection = {
				root: configured.root,
				path: configuredRelativePath(configured.path)
			};
		} else {
			requireThat(this.#browser !== null);
			selection = workspaceSelection(value);
		}
		await this.#directory(selection, false);
		return structuredClone(selection);
	}
	async browse(value) {
		requireThat(this.#browser !== null);
		const query = browserQuery(value);
		const directory = await this.#directory(query, true);
		const directories = [];
		let truncated = false;
		try {
			const handle = await opendir(directory);
			for await (const entry of handle) {
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
				let childPath;
				try {
					relativePath(entry.name);
					childPath = query.path ? `${query.path}/${entry.name}` : entry.name;
				} catch {
					continue;
				}
				const child = path.join(directory, entry.name);
				try {
					const metadata = await lstat(child);
					if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(child) !== child || this.#protected.some((privatePath) => overlaps$1(child, privatePath))) continue;
				} catch {
					continue;
				}
				if (directories.length === DIRECTORY_LIMIT) {
					truncated = true;
					break;
				}
				directories.push({
					name: entry.name,
					path: childPath
				});
			}
			return {
				root: query.root,
				path: query.path,
				directories,
				truncated
			};
		} catch (error) {
			if (error instanceof ManagerError) throw error;
			throw new ManagerError(400);
		}
	}
	/** Current-directory metadata only; no recursion, file reads, or symlink following. */
	async browseEntries(value, extraProtectedRoots = []) {
		requireThat(this.#browser !== null);
		const query = localBrowseQuery(value);
		const directory = await this.#directory(query, true);
		const excluded = [...this.#protected, ...extraProtectedRoots];
		if (query.path !== "") requireThat(!excluded.some((root) => overlaps$1(directory, root)));
		const search = query.query.normalize("NFKC").toLocaleLowerCase();
		const entries = [];
		try {
			let scanned = 0;
			const handle = await opendir(directory);
			for await (const entry of handle) {
				requireThat(++scanned <= 2e4, 413);
				if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile() || /[\x00-\x1f\x7f]/u.test(entry.name)) continue;
				if (!entry.name.normalize("NFKC").toLocaleLowerCase().includes(search)) continue;
				const childPath = query.path ? `${query.path}/${entry.name}` : entry.name;
				try {
					relativePath(childPath);
				} catch {
					continue;
				}
				const child = path.join(directory, entry.name);
				if (excluded.some((root) => overlaps$1(child, root))) continue;
				try {
					const metadata = await lstat(child);
					if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile() || await realpath(child) !== child) continue;
					entries.push({
						name: entry.name,
						path: childPath,
						kind: metadata.isDirectory() ? "directory" : "file",
						modifiedAt: metadata.mtimeMs
					});
				} catch {}
			}
		} catch (error) {
			if (error instanceof ManagerError) throw error;
			throw new ManagerError(400);
		}
		const collator = new Intl.Collator("zh-CN", {
			numeric: true,
			sensitivity: "base"
		});
		const byName = (left, right) => collator.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		entries.sort((left, right) => {
			if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
			if (query.sort === "name-desc") return -byName(left, right);
			if (query.sort === "modified-desc") return right.modifiedAt - left.modifiedAt || byName(left, right);
			if (query.sort === "modified-asc") return left.modifiedAt - right.modifiedAt || byName(left, right);
			return byName(left, right);
		});
		const page = entries.slice(query.offset, query.offset + DIRECTORY_LIMIT);
		const nextOffset = query.offset + page.length < entries.length ? query.offset + page.length : null;
		return {
			...query,
			entries: page,
			total: entries.length,
			nextOffset,
			truncated: nextOffset !== null,
			directories: page.filter((entry) => entry.kind === "directory").map(({ name, path }) => ({
				name,
				path
			}))
		};
	}
};
//#endregion
//#region manager/executor/engine.ts
var MAX_VERSION_QUERIES = 16;
function requestHash(t) {
	return digest(canonical({
		key: t.key,
		requester: t.requester,
		target: t.target,
		action: t.action,
		payload: t.payload
	}));
}
function view(t) {
	const { result, ...rest } = t;
	const r = result && typeof result === "object" && !Array.isArray(result) ? result : void 0;
	return {
		...rest,
		...r && typeof r.status === "string" ? { result: {
			status: r.status,
			...typeof r.instanceId === "string" ? { instanceId: r.instanceId } : {}
		} } : {}
	};
}
var TaskEngine = class TaskEngine {
	#config;
	#store;
	#adapter;
	#policyHash;
	#adapterPolicy;
	#approvals = /* @__PURE__ */ new Map();
	#running = /* @__PURE__ */ new Set();
	#catalog;
	#workspaces;
	#catalogQueries = /* @__PURE__ */ new Set();
	#shutdown = new AbortController();
	#tail = Promise.resolve();
	#closing = false;
	#closePromise;
	constructor(config, store, adapter, options) {
		this.#config = structuredClone(config);
		this.#store = store;
		this.#adapter = adapter;
		this.#catalog = options.catalog ?? new ReleaseCatalog({ metadataDeadlineMs: 2500 });
		this.#workspaces = options.workspacePolicy;
		this.#adapterPolicy = canonical({
			policy: adapter?.policy ?? null,
			actions: adapter?.actions ?? []
		});
		this.#policyHash = digest(canonical({
			workspaces: config.workspaces,
			workspaceBrowser: config.workspaceBrowser ?? null,
			principals: config.principals.map((p) => ({
				id: p.id,
				role: p.role
			})),
			adapter: this.#adapterPolicy
		}));
	}
	static async open(config, adapter, options = {}) {
		const store = await TaskStore.open(config.stateRoot, { recoverStaleLock: config.recoverStaleLock });
		try {
			const workspacePolicy = options.workspacePolicy ?? (config.workspaceBrowser ? await WorkspacePolicy.open(config) : void 0);
			const engine = new TaskEngine(config, store, adapter, {
				...options,
				workspacePolicy
			});
			for (const task of await store.list()) if (task.state === "running" || task.state === "waiting_idle") await store.transition(task.id, task.state, "unknown", { expectedRevision: task.revision });
			await adapter?.restore?.(await store.list());
			return engine;
		} catch (error) {
			await store.close();
			throw error;
		}
	}
	async dispatch(transport, credential, message) {
		requireThat(!this.#closing, 503);
		const h = digest(token(credential));
		const principal = this.#config.principals.find((p) => equalHash(p.tokenHash, h));
		requireThat(principal, 401);
		requireThat(transport === "admin" ? principal.role === "admin" : principal.role === "submitter", 403);
		const m = record$1(message);
		const admin = transport === "admin";
		if ([
			"review",
			"approve",
			"execute"
		].includes(m.op)) requireThat(admin, 403);
		const copy = structuredClone(m);
		if (copy.op === "versions") return await this.#versions(copy);
		const pending = this.#tail.then(() => this.#handle(principal, admin, copy));
		this.#tail = pending.catch(() => {});
		try {
			return await pending;
		} catch (e) {
			if (e instanceof TaskStoreConflictError) throw new ManagerError(409);
			throw e;
		}
	}
	async #versions(message) {
		keys(message, ["op", "options"]);
		const options = record$1(message.options);
		keys(options, [], [
			"query",
			"cursor",
			"limit"
		]);
		const copy = structuredClone(options);
		requireThat(this.#catalogQueries.size < MAX_VERSION_QUERIES, 503);
		const operation = this.#catalog.list(PI_PACKAGE, copy).catch((error) => {
			if (error instanceof CatalogError && error.code === "invalid-query") throw new ManagerError(400);
			throw new ManagerError(503);
		});
		this.#catalogQueries.add(operation);
		try {
			return await operation;
		} finally {
			this.#catalogQueries.delete(operation);
		}
	}
	async #task(id, p, admin) {
		const task = await this.#store.get(taskId(id));
		requireThat(task && (admin || task.requester === p.id), 404);
		return task;
	}
	#assertPolicy() {
		requireThat(canonical({
			policy: this.#adapter?.policy ?? null,
			actions: this.#adapter?.actions ?? []
		}) === this.#adapterPolicy, 409);
	}
	async #validateWorkspace(request) {
		if (request.action !== "create") return;
		const payload = record$1(request.payload);
		keys(payload, ["workspace"]);
		if (typeof payload.workspace === "string") {
			const id = identifier$1(payload.workspace);
			requireThat(Object.hasOwn(this.#config.workspaces, id));
			if (this.#workspaces) await this.#workspaces.resolve(id);
			return;
		}
		requireThat(this.#workspaces && this.#workspaces.browser());
		await this.#workspaces.resolve(workspaceSelection(payload.workspace));
	}
	async #handle(p, admin, m) {
		if (m.op === "capabilities") {
			keys(m, ["op"]);
			const capabilities = this.#adapter?.capabilities;
			return {
				native: capabilities?.native ?? false,
				docker: capabilities?.docker ?? false,
				isolation: capabilities?.isolation ?? "unavailable",
				enrollment: capabilities?.enrollment ?? false,
				updates: false,
				approval: admin
			};
		}
		if (m.op === "workspaces") {
			keys(m, ["op"]);
			return Object.entries(this.#config.workspaces).map(([id, w]) => ({
				id,
				label: w.label
			}));
		}
		if (m.op === "workspace-browser") {
			keys(m, ["op"]);
			return this.#workspaces?.browser() ?? null;
		}
		if (m.op === "browse-workspaces") {
			keys(m, ["op", "query"]);
			requireThat(this.#workspaces);
			return await this.#workspaces.browse(m.query);
		}
		if (m.op === "resources") {
			keys(m, ["op"]);
			return await this.#adapter?.resources(p.id) ?? [];
		}
		if (m.op === "list") {
			keys(m, ["op"]);
			return (await this.#store.list()).filter((t) => !!t && (admin || t.requester === p.id)).map(view);
		}
		if (m.op === "submit") {
			keys(m, ["op", "request"]);
			const r = record$1(m.request);
			requireThat(r.action === "create" || r.action === "stop" || r.action === "start", 503);
			keys(r, r.action === "create" ? [
				"key",
				"action",
				"target",
				"workspace"
			] : [
				"key",
				"action",
				"target"
			]);
			const workspace = r.action !== "create" ? void 0 : typeof r.workspace === "string" ? identifier$1(r.workspace) : workspaceSelection(r.workspace);
			const request = {
				key: identifier$1(r.key),
				requester: p.id,
				target: identifier$1(r.target),
				action: r.action,
				payload: r.action === "create" ? structuredClone({ workspace }) : {}
			};
			requireThat(this.#adapter?.actions.includes(r.action), 503);
			if (!(await this.#store.list()).find((t) => t.requester === p.id && t.key === r.key)) {
				await this.#validateWorkspace(request);
				await this.#adapter.validate(request);
			}
			return view(await this.#store.submit(request));
		}
		if (m.op === "get" || m.op === "review") {
			keys(m, ["op", "taskId"]);
			const t = await this.#task(m.taskId, p, admin);
			if (m.op === "get") return view(t);
			return {
				task: view(t),
				binding: {
					taskId: t.id,
					revision: t.revision,
					requestHash: requestHash(t),
					policyHash: this.#policyHash
				},
				requiresFreshApproval: !this.#approvals.has(t.id)
			};
		}
		if (m.op === "approve") {
			keys(m, [
				"op",
				"taskId",
				"revision",
				"requestHash",
				"policyHash"
			]);
			const t = await this.#task(m.taskId, p, admin);
			requireThat(t.requester !== p.id, 403);
			requireThat(t.revision === revision(m.revision) && ["pending_approval", "queued"].includes(t.state) && !this.#approvals.has(t.id), 409);
			requireThat(m.requestHash === requestHash(t) && m.policyHash === this.#policyHash, 409);
			this.#assertPolicy();
			await this.#validateWorkspace(t);
			requireThat(this.#adapter?.actions.includes(t.action), 503);
			await this.#adapter.validate(t);
			this.#assertPolicy();
			const approved = t.state === "pending_approval" ? await this.#store.transition(t.id, "pending_approval", "queued", { expectedRevision: t.revision }) : t;
			this.#approvals.set(t.id, {
				taskId: t.id,
				revision: approved.revision,
				requestHash: requestHash(t),
				policyHash: this.#policyHash
			});
			return view(approved);
		}
		if (m.op === "execute") {
			keys(m, [
				"op",
				"taskId",
				"revision"
			]);
			const t = await this.#task(m.taskId, p, admin);
			requireThat(t.revision === revision(m.revision) && ["pending_approval", "queued"].includes(t.state), 409);
			const approval = this.#approvals.get(t.id);
			requireThat(approval && t.state === "queued" && approval.revision === t.revision && approval.requestHash === requestHash(t) && approval.policyHash === this.#policyHash, 403);
			this.#assertPolicy();
			await this.#validateWorkspace(t);
			requireThat(this.#adapter?.actions.includes(t.action), 503);
			await this.#adapter.validate(t);
			this.#assertPolicy();
			const started = await this.#store.transition(t.id, "queued", this.#adapter.waitForIdle ? "waiting_idle" : "running", { expectedRevision: t.revision });
			this.#approvals.delete(t.id);
			const operation = this.#execute(started);
			this.#running.add(operation);
			operation.finally(() => this.#running.delete(operation));
			return view(started);
		}
		throw new ManagerError(400);
	}
	async #execute(task) {
		let executionStarted = false;
		try {
			if (task.state === "waiting_idle") {
				await this.#waitForIdle(task);
				this.#shutdown.signal.throwIfAborted();
				this.#assertPolicy();
				await this.#adapter.validate(structuredClone(task));
				this.#shutdown.signal.throwIfAborted();
				this.#assertPolicy();
				task = await this.#store.transition(task.id, "waiting_idle", "running", { expectedRevision: task.revision });
			}
			this.#shutdown.signal.throwIfAborted();
			executionStarted = true;
			const result = await this.#adapter.execute(structuredClone(task));
			await this.#store.transition(task.id, "running", "succeeded", {
				expectedRevision: task.revision,
				result
			});
		} catch (error) {
			const unknown = error instanceof DockerOutcomeUnknownError || error instanceof ExecutionOutcomeUnknownError;
			const stopping = !executionStarted && this.#shutdown.signal.aborted && error === this.#shutdown.signal.reason;
			await this.#store.transition(task.id, task.state, unknown ? "unknown" : stopping ? "cancelled" : "failed", {
				expectedRevision: task.revision,
				result: { status: unknown ? "execution-outcome-unknown" : stopping ? "executor-stopping" : "execution-failed" }
			}).catch(() => {});
		}
	}
	async #waitForIdle(task) {
		const signal = this.#shutdown.signal;
		signal.throwIfAborted();
		let rejectAbort;
		const aborted = new Promise((_resolve, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => rejectAbort(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([this.#adapter.waitForIdle(structuredClone(task), signal), aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
	close() {
		this.#closing = true;
		this.#shutdown.abort();
		return this.#closePromise ??= (async () => {
			await this.#tail;
			await Promise.all(this.#running);
			await Promise.allSettled([...this.#catalogQueries]);
			try {
				await this.#adapter?.close();
			} finally {
				this.#approvals.clear();
				await this.#store.close();
			}
		})();
	}
};
//#endregion
//#region manager/process-identity.ts
/** Linux-only observation, never authority to adopt or signal a process. */
function readProcessIdentity(pid) {
	if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const content = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = content.lastIndexOf(")");
		if (end < 0) return null;
		const startTicks = content.slice(end + 2).trim().split(/\s+/)[19];
		const identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${startTicks}`;
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(identity) ? identity : null;
	} catch {
		return null;
	}
}
function matchesProcessIdentity(pid, identity) {
	return identity !== null && readProcessIdentity(pid) === identity;
}
//#endregion
//#region manager/backends/runtime-client.ts
var object$2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var identifier = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
function command(value) {
	if (!object$2(value)) throw Error("Invalid runtime request");
	const expectedKeys = value.action === "snapshot" ? "action" : value.action === "cancel" ? "action,operation_id" : value.action === "prepare" || value.action === "commit" || value.action === "admit" ? "action,expected,operation_id" : "";
	if (!expectedKeys || Object.keys(value).sort().join() !== expectedKeys || value.action !== "snapshot" && (typeof value.operation_id !== "string" || !/^[a-f0-9]{32}$/.test(value.operation_id))) throw Error("Invalid runtime request");
	if (value.action === "prepare" && (!object$2(value.expected) || Object.keys(value.expected).sort().join() !== "leaf_id,runtime_id,session_id" || !identifier(value.expected.runtime_id) || !identifier(value.expected.session_id) || value.expected.leaf_id !== null && !identifier(value.expected.leaf_id))) throw Error("Invalid runtime request");
	if (value.action === "commit" || value.action === "admit") {
		const s = value.expected;
		const absolute = (p) => typeof p === "string" && path.isAbsolute(p) && path.resolve(p) === p && p !== "/" && p.length <= 4096 && !/\p{Cc}/u.test(p);
		if (!object$2(s) || Object.keys(s).sort().join() !== "busy,cwd,idle,leaf_id,model,pending,provider,run_id,runtime_id,session_file,session_id,thinking,version" || typeof s.run_id !== "string" || !/^[a-f0-9]{32}$/.test(s.run_id) || !identifier(s.runtime_id) || !identifier(s.session_id) || s.leaf_id !== null && !identifier(s.leaf_id) || !absolute(s.session_file) || !absolute(s.cwd) || typeof s.version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(s.version) || s.version.length > 64 || s.idle !== true || s.pending !== false || s.busy !== false || !identifier(s.thinking) || s.provider !== null && !identifier(s.provider) || s.model !== null && !identifier(s.model)) throw Error("Invalid runtime request");
	}
	return structuredClone(value);
}
/** Executor-only channel. No discovery, credential output, path creation or PID authority. */
var RuntimeClient = class {
	#socketPath;
	#token;
	#timeout;
	#identity;
	#pending = false;
	constructor(options) {
		const { socketPath, token, timeoutMs = 2e3 } = options;
		if (!path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || socketPath.includes("\0") || Buffer.byteLength(socketPath) > 100 || !/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5e3) throw Error("Invalid runtime endpoint");
		this.#socketPath = socketPath;
		this.#token = token;
		this.#timeout = timeoutMs;
	}
	async #endpoint() {
		const parent = path.dirname(this.#socketPath), directory = await lstat(parent), socket = await lstat(this.#socketPath);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 63) !== 0 || await realpath(parent) !== parent || !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 511) !== 384) throw Error("Unsafe runtime endpoint");
		const identity = `${directory.dev}:${directory.ino}:${socket.dev}:${socket.ino}`;
		if (this.#identity && identity !== this.#identity) throw Error("Changed runtime endpoint");
		this.#identity = identity;
	}
	async request(value, beforeWrite) {
		const fields = command(value);
		if (this.#pending) throw Error("Runtime request refused");
		this.#pending = true;
		try {
			await this.#endpoint();
			const result = await new Promise((resolve, reject) => {
				let data = Buffer.alloc(0), done = false;
				const peer = net.createConnection(this.#socketPath);
				const fail = () => {
					if (done) return;
					done = true;
					peer.destroy();
					reject(Error("Runtime request refused"));
				};
				const timer = setTimeout(fail, this.#timeout);
				peer.on("error", fail);
				peer.on("close", () => {
					clearTimeout(timer);
					if (!done) fail();
				});
				peer.on("connect", () => {
					if (done) return;
					try {
						const frame = JSON.stringify({
							token: this.#token,
							...fields
						}) + "\n";
						if (beforeWrite && beforeWrite() !== void 0) throw Error("Runtime write guard must be synchronous");
						peer.end(frame);
					} catch {
						fail();
					}
				});
				peer.on("data", (chunk) => {
					if (done) return;
					if (data.length + chunk.length > 16384) {
						fail();
						return;
					}
					data = Buffer.concat([data, chunk]);
				});
				peer.on("end", () => {
					if (done) return;
					try {
						if (!data.length || data.indexOf(10) !== data.length - 1) throw Error();
						const reply = strictJson(data.subarray(0, -1));
						if (!object$2(reply) || Object.keys(reply).sort().join() !== "ok,result" || reply.ok !== true) throw Error();
						done = true;
						clearTimeout(timer);
						peer.destroy();
						resolve(reply.result);
					} catch {
						fail();
					}
				});
			});
			await this.#endpoint();
			return result;
		} finally {
			this.#pending = false;
		}
	}
};
//#endregion
//#region manager/updates/candidate-storage.ts
var CandidateError = class extends Error {
	code;
	constructor(code) {
		super(`Candidate installation refused: ${code}`);
		this.name = "CandidateError";
		this.code = code;
	}
};
async function privateRoot$1(root) {
	if (!path.isAbsolute(root) || path.resolve(root) !== root || root === "/" || root.includes("\0") || await realpath(root) !== root) throw new CandidateError("root-unsafe");
	const uid = process.getuid?.(), system = (await lstat("/")).uid;
	for (let dir = root;; dir = path.dirname(dir)) {
		const s = await lstat(dir);
		if (!s.isDirectory() || s.uid !== uid && s.uid !== system || s.mode & 18 && !(s.uid === system && s.mode & 512)) throw new CandidateError("root-unsafe");
		if (dir === root && (s.uid !== uid || (s.mode & 511) !== 448)) throw new CandidateError("root-unsafe");
		if (dir === "/") break;
	}
}
async function writeNew(file, data, mode = 256) {
	const f = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
	try {
		await f.writeFile(data);
		await f.sync();
		await f.chmod(mode);
	} finally {
		await f.close();
	}
}
async function syncDir(dir) {
	const f = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await f.sync();
	} finally {
		await f.close();
	}
}
//#endregion
//#region manager/updates/session-capture.ts
var MAX_BYTES = 64 * 1024 ** 2, MAX_RETAINED = 512 * 1024 ** 2, MAX_RECEIPT = 16384;
var sha256 = (b) => createHash("sha256").update(b).digest("hex");
var fail = (code) => {
	throw Object.assign(/* @__PURE__ */ new Error(`Session capture refused: ${code}`), { code });
};
var identity = (s) => [
	s.dev,
	s.ino,
	s.mode,
	s.uid,
	s.gid,
	s.nlink,
	s.size,
	s.mtimeNs,
	s.ctimeNs
].join(":");
var absolute$2 = (p) => typeof p === "string" && path.isAbsolute(p) && path.resolve(p) === p && p !== "/" && p.length <= 4096 && !/\p{Cc}/u.test(p);
function rootIdentity(directory) {
	const root = lstatSync(directory, { bigint: true });
	const uid = BigInt(process.getuid()), system = lstatSync("/", { bigint: true }).uid;
	if (!root.isDirectory() || root.uid !== uid || (root.mode & 4095n) !== 448n || realpathSync(directory) !== directory) fail("capture-root-changed");
	for (let dir = path.dirname(directory);; dir = path.dirname(dir)) {
		const s = lstatSync(dir, { bigint: true });
		if (!s.isDirectory() || s.uid !== uid && s.uid !== system || (s.mode & 18n) !== 0n && !(s.uid === system && (s.mode & 512n) !== 0n)) fail("capture-root-changed");
		if (dir === "/") break;
	}
	return `${root.dev}:${root.ino}:${root.mode}:${root.uid}`;
}
function options(value) {
	if (!value || Object.keys(value).sort().join() !== "expiresAt,operationId,root,sessionsRoot,snapshot") fail("capture-options-invalid");
	const o = structuredClone(value), s = o.snapshot;
	const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
	if (!absolute$2(o.root) || !absolute$2(o.sessionsRoot) || o.root === o.sessionsRoot || o.root.startsWith(o.sessionsRoot + path.sep) || o.sessionsRoot.startsWith(o.root + path.sep) || !/^[a-f0-9]{32}$/.test(o.operationId) || !Number.isFinite(o.expiresAt) || o.expiresAt <= performance.now() || o.expiresAt > performance.now() + 15e4 || !s || Object.keys(s).sort().join() !== "busy,cwd,idle,leaf_id,model,pending,provider,run_id,runtime_id,session_file,session_id,thinking,version" || !id(s.runtime_id) || !id(s.session_id) || s.leaf_id !== null && !id(s.leaf_id) || !/^[a-f0-9]{32}$/.test(s.run_id) || !id(s.version) || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(s.version) || !id(s.thinking) || s.provider !== null && !id(s.provider) || s.model !== null && !id(s.model) || !absolute$2(s.cwd) || !absolute$2(s.session_file) || path.dirname(s.session_file) !== o.sessionsRoot || s.idle !== true || s.pending !== false || s.busy !== false) fail("capture-options-invalid");
	return Object.freeze({
		...o,
		snapshot: Object.freeze(s)
	});
}
/** O_NONBLOCK prevents a substituted FIFO from waiting for an external writer. */
async function bytes(file, copy = false) {
	const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await f.stat({ bigint: true });
		if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_BYTES) || (before.mode & 3657n) !== 0n || copy && (before.mode & 4095n) !== 256n || identity(await lstat(file, { bigint: true })) !== identity(before) || await realpath(file) !== file) fail("capture-file-unsafe");
		const data = Buffer.alloc(Number(before.size) + 1);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await f.read(data, offset, data.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== Number(before.size) || identity(await f.stat({ bigint: true })) !== identity(before) || identity(await lstat(file, { bigint: true })) !== identity(before)) fail("capture-file-changed");
		return {
			data: data.subarray(0, offset),
			identity: identity(before)
		};
	} finally {
		await f.close();
	}
}
async function admission(root, operationId) {
	const reservations = /* @__PURE__ */ new Set();
	let size = 0, entries = 0;
	for await (const e of await opendir(root, { bufferSize: 1 })) {
		if (++entries > 25) fail("capture-resource-limit");
		const s = await lstat(path.join(root, e.name));
		if (!e.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || s.mode & 3657 || s.mode & 18 || !/^(?:\.writer|restore-[a-f0-9]{32}\.(?:jsonl|receipt\.json))$/.test(e.name)) fail("capture-root-unsafe");
		if (e.name !== ".writer") {
			const prefix = e.name.slice(0, 40);
			if (prefix === `restore-${operationId}`) fail("capture-operation-exists");
			reservations.add(prefix);
		}
		size += s.size;
		if (size + MAX_BYTES + MAX_RECEIPT > MAX_RETAINED || reservations.size >= 8) fail("capture-resource-limit");
	}
}
/** Byte capture only: the caller separately owns input-lease, compatibility and stop authorization. */
var SessionCapture = class SessionCapture {
	#options;
	#sourceIdentity;
	#copyIdentity;
	#rootIdentity;
	#sessionRootIdentity;
	#descriptor;
	constructor(o, source, copy, roots, descriptor) {
		this.#options = o;
		this.#sourceIdentity = source;
		this.#copyIdentity = copy;
		[this.#rootIdentity, this.#sessionRootIdentity] = roots;
		this.#descriptor = Object.freeze(descriptor);
	}
	static async create(value) {
		const o = options(value);
		const roots = [rootIdentity(o.root), rootIdentity(o.sessionsRoot)];
		await privateRoot$1(o.root);
		await privateRoot$1(o.sessionsRoot);
		if (rootIdentity(o.root) !== roots[0] || rootIdentity(o.sessionsRoot) !== roots[1]) fail("capture-root-changed");
		const lockPath = path.join(o.root, ".writer");
		const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
		try {
			await lock.writeFile(JSON.stringify({ operationId: o.operationId }));
			await lock.sync();
			await syncDir(o.root);
			await admission(o.root, o.operationId);
			const source = await bytes(o.snapshot.session_file);
			const newline = source.data.indexOf(10);
			if (newline < 1 || newline > 65536) fail("capture-header-invalid");
			const header = strictJson(source.data.subarray(0, newline));
			if (!record(header) || header.type !== "session" || !Number.isSafeInteger(header.version) || header.version < 1 || header.id !== o.snapshot.session_id || header.cwd !== o.snapshot.cwd) fail("capture-header-invalid");
			if (performance.now() >= o.expiresAt) fail("capture-expired");
			const descriptor = {
				reference: `restore-${o.operationId}.jsonl`,
				sha256: sha256(source.data),
				bytes: source.data.length,
				sessionId: o.snapshot.session_id,
				leafId: o.snapshot.leaf_id,
				expiresAt: o.expiresAt
			};
			const copy = path.join(o.root, descriptor.reference);
			await writeNew(copy, source.data);
			const copyIdentity = identity(await lstat(copy, { bigint: true }));
			const receipt = JSON.stringify({
				schema: 1,
				descriptor,
				operationId: o.operationId,
				snapshot: o.snapshot,
				sourceIdentity: source.identity,
				copyIdentity
			});
			if (Buffer.byteLength(receipt) > MAX_RECEIPT) fail("capture-resource-limit");
			await writeNew(path.join(o.root, `restore-${o.operationId}.receipt.json`), receipt);
			await syncDir(o.root);
			const capture = new SessionCapture(o, source.identity, copyIdentity, roots, descriptor);
			await capture.verify(o.snapshot);
			return capture;
		} finally {
			try {
				const current = await lstat(lockPath), original = await lock.stat();
				if (current.ino !== original.ino || current.dev !== original.dev || !current.isFile()) fail("capture-lock-changed");
				await unlink(lockPath);
				await syncDir(o.root);
			} finally {
				await lock.close();
			}
		}
	}
	descriptor() {
		return Object.freeze({ ...this.#descriptor });
	}
	/** Synchronous short final check; perform expensive content verification before a fresh live runtime handshake. */
	fence(snapshot) {
		const o = this.#options;
		if (performance.now() >= o.expiresAt || canonical(snapshot) !== canonical(o.snapshot)) fail("capture-expired-or-changed");
		for (const [dir, expected] of [[o.root, this.#rootIdentity], [o.sessionsRoot, this.#sessionRootIdentity]]) if (rootIdentity(dir) !== expected) fail("capture-root-changed");
		if (identity(lstatSync(o.snapshot.session_file, { bigint: true })) !== this.#sourceIdentity || identity(lstatSync(path.join(o.root, this.#descriptor.reference), { bigint: true })) !== this.#copyIdentity || performance.now() >= o.expiresAt) fail("capture-file-changed");
	}
	async verify(snapshot) {
		this.fence(snapshot);
		const source = await bytes(this.#options.snapshot.session_file);
		if (source.identity !== this.#sourceIdentity || sha256(source.data) !== this.#descriptor.sha256) fail("capture-content-changed");
		const copy = await bytes(path.join(this.#options.root, this.#descriptor.reference), true);
		if (copy.identity !== this.#copyIdentity || sha256(copy.data) !== this.#descriptor.sha256) fail("capture-content-changed");
		this.fence(snapshot);
	}
};
//#endregion
//#region manager/backends/native.ts
function runtimeFields(value, runId, workspace) {
	const identifier = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
	if (!object$1(value) || Object.keys(value).sort().join() !== "busy,cwd,idle,leaf_id,model,pending,provider,run_id,runtime_id,session_file,session_id,thinking,version" || typeof value.run_id !== "string" || !/^[a-f0-9]{32}$/.test(value.run_id) || value.run_id !== runId || value.cwd !== workspace || !identifier(value.runtime_id) || !identifier(value.session_id) || value.leaf_id !== null && !identifier(value.leaf_id) || typeof value.version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version) || value.version.length > 64 || [
		"idle",
		"pending",
		"busy"
	].some((k) => typeof value[k] !== "boolean") || ["provider", "model"].some((k) => value[k] !== null && !identifier(value[k])) || !identifier(value.thinking)) throw Error("Invalid runtime snapshot");
	return Object.freeze(structuredClone(value));
}
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	promise.catch(() => {});
	return {
		promise,
		resolve,
		reject
	};
}
function object$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sameRuntime(a, b) {
	return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}
function instanceId(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid instance ID");
}
function absolute$1(value) {
	if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Administrator paths must be absolute");
	return path.resolve(value);
}
function limit(value, fallback, maximum) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("Invalid native backend limit");
	return result;
}
async function privateRoot(directory) {
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 63) !== 0 || await realpath(directory) !== directory) throw new Error("Native state/agent root must be a canonical private owned directory");
	return directory;
}
async function exitedWithin(entry, ms) {
	if (entry.exited) return true;
	let timer;
	try {
		return await Promise.race([entry.exit.promise.then(() => true), new Promise((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		})]);
	} finally {
		clearTimeout(timer);
	}
}
/** Private trusted-local infrastructure. Cwd restrictions are NOT a filesystem jail. */
var NativeBackend = class {
	#config;
	#owned = /* @__PURE__ */ new Map();
	#starting = /* @__PURE__ */ new Map();
	#startupMs;
	#rpcMs;
	#generationMs;
	#stopMs;
	#frameBytes;
	#stderrBytes;
	constructor(config) {
		if (process.platform !== "linux" || readProcessIdentity(process.pid) === null) throw new Error("Native backend requires Linux /proc process identities");
		const roots = Object.fromEntries(Object.entries(config.workspaceRoots).map(([key, value]) => [key, absolute$1(value)]));
		if (!Object.keys(roots).length) throw new Error("At least one allowed workspace root is required");
		this.#config = Object.freeze({
			...config,
			piExecutable: absolute$1(config.piExecutable),
			stateRoot: absolute$1(config.stateRoot),
			agentRoot: absolute$1(config.agentRoot),
			workspaceRoots: Object.freeze(roots),
			provider: config.provider ? Object.freeze({
				...config.provider,
				extensionPath: absolute$1(config.provider.extensionPath)
			}) : void 0,
			web: config.web ? Object.freeze({
				...config.web,
				extensionPath: absolute$1(config.web.extensionPath),
				hubConfigFile: absolute$1(config.web.hubConfigFile)
			}) : void 0
		});
		if (config.provider && [config.provider.name, config.provider.model].some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value))) throw new Error("Invalid administrator provider selection");
		if (config.web && (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535)) throw new Error("Invalid administrator Web port");
		if (config.runtimeControl !== void 0 && typeof config.runtimeControl !== "boolean") throw new Error("Invalid runtime control option");
		if (config.runtimeControl && !config.web) throw new Error("Managed runtime control requires an explicit Web profile");
		this.#startupMs = limit(config.startupTimeoutMs, 1e4, 12e4);
		this.#rpcMs = limit(config.rpcTimeoutMs, 5e3, 12e4);
		this.#generationMs = limit(config.generationTimeoutMs, 3e4, 6e5);
		this.#stopMs = limit(config.stopTimeoutMs, 1e3, 3e4);
		this.#frameBytes = limit(config.maxFrameBytes, 1024 * 1024, 4 * 1024 * 1024);
		this.#stderrBytes = limit(config.maxStderrBytes, 16 * 1024, 1024 * 1024);
	}
	async create(request, options = {}) {
		return this.#begin(request, options);
	}
	/** Executor-private recovery of SAVED DATA. Never reconstructs a child handle or signals the old PID. */
	async resume(request, previous, options = {}) {
		return this.#begin(request, options, structuredClone(previous));
	}
	/** Private saved-data launch only. Candidate approval and compatibility remain coordinator obligations. */
	async resumeForActivation(request, previous, value) {
		if (!this.#config.runtimeControl || !this.#config.web || !object$1(value) || Object.keys(value).sort().join() !== "operationId,snapshot" || typeof value.operationId !== "string" || !/^[a-f0-9]{32}$/.test(value.operationId)) throw Error("Invalid managed successor request");
		const prior = structuredClone(previous), copy = structuredClone(value);
		const snapshot = runtimeFields(copy.snapshot, copy.snapshot?.run_id, prior.workspace);
		const cliValue = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/.test(x);
		if (!snapshot.idle || snapshot.pending || snapshot.busy || typeof snapshot.session_file !== "string" || path.dirname(snapshot.session_file) !== path.join(prior.stateDir, "sessions") || path.resolve(snapshot.session_file) !== snapshot.session_file || !cliValue(snapshot.provider) || !cliValue(snapshot.model) || !/^[a-z][a-z0-9-]{0,31}$/.test(snapshot.thinking)) throw Error("Invalid managed successor snapshot");
		return this.#begin(request, {}, prior, {
			operationId: copy.operationId,
			snapshot
		});
	}
	async #begin(request, options, previous, successor) {
		if (!object$1(request) || Object.keys(request).some((key) => !["instanceId", "workspace"].includes(key))) throw new Error("Invalid create request");
		instanceId(request.instanceId);
		if (this.#starting.has(request.instanceId) || this.#owned.has(request.instanceId)) throw new Error("Instance already owned or starting");
		if (!object$1(request.workspace) || Object.keys(request.workspace).some((key) => !["root", "path"].includes(key))) throw new Error("Invalid workspace request");
		const copy = {
			instanceId: request.instanceId,
			workspace: { ...request.workspace }
		};
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		const promise = this.#launch(copy, signal, previous, successor);
		this.#starting.set(copy.instanceId, {
			controller,
			promise
		});
		try {
			return await promise;
		} finally {
			this.#starting.delete(copy.instanceId);
		}
	}
	list() {
		return [...this.#owned.values()].filter((entry) => !entry.exited).map((entry) => entry.identity);
	}
	async inspect(id) {
		instanceId(id);
		const entry = this.#owned.get(id);
		if (!entry || entry.exited) return null;
		if (!matchesProcessIdentity(entry.identity.pid, entry.identity.processIdentity)) entry.status = "ownership-lost";
		return Object.freeze({
			...entry.identity,
			status: entry.status,
			stderrBytes: entry.stderr.length,
			stderrTruncated: entry.stderrTruncated
		});
	}
	async stop(id) {
		instanceId(id);
		const starting = this.#starting.get(id);
		starting?.controller.abort();
		const entry = this.#owned.get(id);
		if (entry) return this.#stop(entry);
		if (starting) await starting.promise.catch(() => {});
		return { status: "not-owned" };
	}
	#runtimeEntry(id) {
		instanceId(id);
		const entry = this.#owned.get(id);
		if (!entry || entry.exited || entry.status !== "ready" || entry.error || !matchesProcessIdentity(entry.identity.pid, entry.identity.processIdentity)) throw Error("Runtime is not ready and owned");
		if (!entry.runtime) throw Error("Runtime control is unavailable");
		return entry;
	}
	async #runtimeSnapshot(entry, value) {
		const snapshot = runtimeFields(value, entry.runtime.runId, entry.identity.workspace);
		if (snapshot.session_file !== null) {
			const file = snapshot.session_file, root = path.join(entry.identity.stateDir, "sessions");
			if (typeof file !== "string" || !file.startsWith(root + path.sep) || path.resolve(file) !== file || file.length > 4096 || /\p{Cc}/u.test(file)) throw Error("Invalid runtime session");
			const s = await lstat(file), directory = await lstat(root);
			if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 4095) !== 448 || !s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 3657) !== 0 || await realpath(file) !== file || await realpath(root) !== root) throw Error("Invalid runtime session");
		}
		if (this.#runtimeEntry(entry.identity.instanceId) !== entry) throw Error("Original runtime generation is no longer owned");
		return snapshot;
	}
	async snapshotRuntime(id) {
		const entry = this.#runtimeEntry(id);
		return this.#runtimeSnapshot(entry, await entry.runtime.client.request({ action: "snapshot" }));
	}
	/** Cooperative input lease only; this does not authorize stopping or replacing a process. */
	async prepareRuntime(id, operation, expected) {
		const entry = this.#runtimeEntry(id), runtime = entry.runtime;
		if (typeof operation !== "string" || !/^[a-f0-9]{32}$/.test(operation)) throw Error("Invalid runtime operation");
		if (runtime.barrier || runtime.uncertain || entry.generation || entry.pending.size) throw Error("Runtime barrier unavailable");
		if (runtime.pendingAdmission && runtime.pendingAdmission !== operation) throw Error("Successor admission operation mismatch");
		const copy = structuredClone(expected);
		const expiresAt = performance.now() + 15e4;
		runtime.barrier = operation;
		runtime.inFlight = true;
		let sent = false;
		try {
			const valid = await this.#runtimeSnapshot(entry, copy);
			if (!valid.idle || valid.pending || valid.busy || !valid.session_file || performance.now() >= expiresAt) throw Error("Runtime snapshot is busy or expired");
			sent = true;
			const value = await runtime.client.request({
				action: "prepare",
				operation_id: operation,
				expected: {
					runtime_id: valid.runtime_id,
					session_id: valid.session_id,
					leaf_id: valid.leaf_id
				}
			});
			const held = await this.#runtimeSnapshot(entry, value);
			if (!sameRuntime(held, valid) || performance.now() >= expiresAt) throw Error("Runtime changed or expired during preparation");
			runtime.lease = {
				snapshot: held,
				expiresAt
			};
			return held;
		} catch (error) {
			if (sent) {
				runtime.uncertain = true;
				throw new ExecutionOutcomeUnknownError();
			}
			runtime.barrier = void 0;
			throw error;
		} finally {
			runtime.inFlight = false;
		}
	}
	#runtimeLease(id, operation) {
		const entry = this.#runtimeEntry(id), runtime = entry.runtime;
		if (typeof operation !== "string" || !/^[a-f0-9]{32}$/.test(operation) || runtime.barrier !== operation || !runtime.lease || runtime.inFlight || runtime.uncertain || runtime.committed || performance.now() >= runtime.lease.expiresAt) throw Error("Original runtime lease unavailable or expired");
		return {
			entry,
			runtime,
			lease: runtime.lease
		};
	}
	/** Executor-private data capture. The original lease and child generation cannot be substituted. */
	async captureRuntime(id, operation, capturesRoot) {
		const { entry, runtime, lease } = this.#runtimeLease(id, operation);
		if (lease.capture) throw Error("Original runtime capture already exists");
		runtime.inFlight = true;
		try {
			if (!sameRuntime(await this.#runtimeSnapshot(entry, await runtime.client.request({ action: "snapshot" })), lease.snapshot)) throw Error("Runtime changed during capture");
			const capture = await SessionCapture.create({
				root: capturesRoot,
				sessionsRoot: path.join(entry.identity.stateDir, "sessions"),
				operationId: operation,
				snapshot: lease.snapshot,
				expiresAt: lease.expiresAt
			});
			if (this.#runtimeEntry(id) !== entry || runtime.lease !== lease) throw Error("Original runtime generation changed");
			capture.fence(lease.snapshot);
			lease.capture = capture;
			return capture;
		} finally {
			runtime.inFlight = false;
		}
	}
	/** Permanent child input latch only; stopping still requires independently authorized ownership. */
	async commitRuntime(id, operation, capture) {
		const { entry, runtime, lease } = this.#runtimeLease(id, operation);
		if (lease.capture !== capture || !(capture instanceof SessionCapture)) throw Error("Original runtime capture required");
		runtime.inFlight = true;
		let sent = false;
		try {
			await capture.verify(lease.snapshot);
			const fresh = await this.#runtimeSnapshot(entry, await runtime.client.request({ action: "snapshot" }));
			if (!sameRuntime(fresh, lease.snapshot) || runtime.lease !== lease) throw Error("Runtime changed before final commit");
			const reply = await runtime.client.request({
				action: "commit",
				operation_id: operation,
				expected: fresh
			}, () => {
				if (this.#runtimeEntry(id) !== entry || entry.runtime !== runtime || runtime.lease !== lease || runtime.barrier !== operation || !runtime.inFlight || runtime.uncertain || runtime.committed || lease.capture !== capture || performance.now() >= lease.expiresAt) throw Error("Original runtime commit lease unavailable");
				capture.fence(fresh);
				sent = true;
			});
			if (!object$1(reply) || Object.keys(reply).sort().join() !== "committed,operation_id,snapshot" || reply.committed !== true || reply.operation_id !== operation) throw Error("Invalid runtime commit acknowledgement");
			const confirmed = await this.#runtimeSnapshot(entry, reply.snapshot);
			if (!sameRuntime(confirmed, lease.snapshot) || performance.now() >= lease.expiresAt) throw Error("Runtime commit acknowledgement changed or expired");
			runtime.committed = true;
			return confirmed;
		} catch (error) {
			if (sent) {
				runtime.uncertain = true;
				throw new ExecutionOutcomeUnknownError();
			}
			throw error;
		} finally {
			runtime.inFlight = false;
		}
	}
	async cancelRuntime(id, operation) {
		const entry = this.#runtimeEntry(id), runtime = entry.runtime;
		if (typeof operation !== "string" || !/^[a-f0-9]{32}$/.test(operation) || runtime.barrier !== operation || runtime.inFlight || runtime.uncertain || runtime.committed) throw Error("Runtime lease operation mismatch or unavailable");
		runtime.inFlight = true;
		try {
			const reply = await runtime.client.request({
				action: "cancel",
				operation_id: operation
			});
			if (!object$1(reply) || Object.keys(reply).join() !== "cancelled" || reply.cancelled !== true) throw Error();
			if (this.#runtimeEntry(id) !== entry) throw Error("Original runtime generation is no longer owned");
			runtime.barrier = void 0;
			runtime.lease = void 0;
		} catch {
			runtime.uncertain = true;
			throw new ExecutionOutcomeUnknownError();
		} finally {
			runtime.inFlight = false;
		}
	}
	/** Only a verified coordinator may call this after publishing the selected generation. */
	async admitRuntime(id, operation, expected) {
		const { entry, runtime, lease } = this.#runtimeLease(id, operation);
		if (runtime.pendingAdmission !== operation || !sameRuntime(expected, lease.snapshot)) throw Error("Original successor admission required");
		runtime.inFlight = true;
		let sent = false;
		try {
			const reply = await runtime.client.request({
				action: "admit",
				operation_id: operation,
				expected: lease.snapshot
			}, () => {
				if (this.#runtimeEntry(id) !== entry || entry.runtime !== runtime || runtime.lease !== lease || runtime.barrier !== operation || runtime.pendingAdmission !== operation || !runtime.inFlight || runtime.uncertain || runtime.committed || performance.now() >= lease.expiresAt) throw Error("Original successor lease unavailable");
				sent = true;
			});
			if (!object$1(reply) || Object.keys(reply).sort().join() !== "admitted,operation_id,snapshot" || reply.admitted !== true || reply.operation_id !== operation) throw Error("Invalid successor acknowledgement");
			const confirmed = await this.#runtimeSnapshot(entry, reply.snapshot);
			if (!sameRuntime(confirmed, lease.snapshot) || performance.now() >= lease.expiresAt) throw Error("Successor acknowledgement changed or expired");
			runtime.pendingAdmission = void 0;
			runtime.barrier = void 0;
			runtime.lease = void 0;
			return confirmed;
		} catch (error) {
			if (sent) {
				runtime.uncertain = true;
				throw new ExecutionOutcomeUnknownError();
			}
			throw error;
		} finally {
			runtime.inFlight = false;
		}
	}
	async generate(id, message) {
		instanceId(id);
		const entry = this.#owned.get(id);
		if (!entry || entry.exited || entry.status !== "ready" || entry.error) throw new Error("Instance is not ready and owned");
		if (entry.runtime?.barrier || entry.runtime?.uncertain || entry.runtime?.pendingAdmission) throw new Error("Runtime input is fenced by an update lease");
		if (entry.generation) throw new Error("Instance is busy");
		if (typeof message !== "string" || !message.length || Buffer.byteLength(JSON.stringify(message)) + 256 > this.#frameBytes) throw new Error("Invalid or oversized prompt");
		const generation = {
			...deferred(),
			text: "",
			agentEndObserved: false,
			settled: false,
			aborted: false,
			lastMessageFailed: false
		};
		entry.generation = generation;
		const timer = setTimeout(() => this.#fail(entry, /* @__PURE__ */ new Error("Generation deadline exceeded")), this.#generationMs);
		try {
			const response = await this.#request(entry, "prompt", { message }, this.#rpcMs);
			const disposition = object$1(response.data) ? response.data.disposition : void 0;
			if (disposition !== "started" && disposition !== "handled") throw new Error("Unexpected prompt disposition");
			if (disposition === "started") await generation.promise;
			return {
				disposition,
				text: generation.text,
				agentEndObserved: generation.agentEndObserved,
				settled: generation.settled,
				aborted: generation.aborted
			};
		} catch (error) {
			await this.#stop(entry);
			throw error;
		} finally {
			clearTimeout(timer);
			entry.generation = void 0;
		}
	}
	async #recovery(previous, request, workspace, stateRoot, agentRoot) {
		if (!object$1(previous) || previous.instanceId !== request.instanceId || previous.workspace !== workspace || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.processIdentity !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]*)$/.test(previous.processIdentity) || !Number.isSafeInteger(previous.generation ?? 0) || (previous.generation ?? 0) < 0 || (previous.generation ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid private recovery identity");
		for (const [directory, parent] of [[previous.stateDir, stateRoot], [previous.agentDir, agentRoot]]) {
			if (typeof directory !== "string" || path.dirname(directory) !== parent || !path.basename(directory).startsWith(request.instanceId + "-")) throw new Error("Invalid private recovery directory");
			await privateRoot(directory);
		}
		const auditFile = previous.auditFile ?? "identity.json";
		if (auditFile !== "identity.json" && !/^identity-[a-f0-9-]{36}\.json$/.test(auditFile)) throw new Error("Invalid private recovery audit");
		const handle = await open(path.join(previous.stateDir, auditFile), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const s = await handle.stat();
			if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 511) !== 384 || s.size > 8192) throw new Error("Unsafe private recovery audit");
			const audit = JSON.parse(await handle.readFile("utf8"));
			if (!object$1(audit) || audit.schemaVersion !== 1 || Object.keys(audit).length !== Object.keys(previous).length + 1 || Object.entries(previous).some(([k, v]) => audit[k] !== v)) throw new Error("Private recovery identity differs from audit");
		} finally {
			await handle.close();
		}
		const observed = readProcessIdentity(previous.pid);
		if (observed === previous.processIdentity) throw new Error("Previous native generation is still active");
		if (observed === null) {
			try {
				process.kill(previous.pid, 0);
			} catch (error) {
				if (error.code === "ESRCH") return;
				throw new ExecutionOutcomeUnknownError();
			}
			throw new ExecutionOutcomeUnknownError();
		}
	}
	async #launch(request, signal, previous, successor) {
		signal.throwIfAborted();
		const rootName = request.workspace.root;
		const selection = request.workspace.path;
		if (typeof rootName !== "string" || !Object.hasOwn(this.#config.workspaceRoots, rootName) || typeof selection !== "string" || path.isAbsolute(selection) || selection.includes("\0") || selection.split(/[\\/]/).includes("..")) throw new Error("Invalid workspace selection");
		const root = await realpath(this.#config.workspaceRoots[rootName]);
		const workspace = await realpath(path.resolve(root, selection));
		const relative = path.relative(root, workspace);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(workspace)).isDirectory()) throw new Error("Workspace escapes allowed root or is not a directory");
		let executable;
		try {
			executable = await realpath(this.#config.piExecutable);
			await access(executable, constants.X_OK);
			if (!(await stat(executable)).isFile()) throw new Error();
		} catch {
			throw new Error("Configured Pi executable is unavailable");
		}
		const stateRoot = await privateRoot(this.#config.stateRoot);
		const agentRoot = await privateRoot(this.#config.agentRoot);
		if (previous) await this.#recovery(previous, request, workspace, stateRoot, agentRoot);
		const stateDir = previous?.stateDir ?? await mkdtemp(path.join(stateRoot, `${request.instanceId}-`));
		const agentDir = previous?.agentDir ?? await mkdtemp(path.join(agentRoot, `${request.instanceId}-`));
		const subdir = (name) => path.join(stateDir, name);
		for (const name of [
			"home",
			"config",
			"cache",
			"data",
			"state",
			"run",
			"tmp",
			"sessions"
		]) if (previous) await privateRoot(subdir(name));
		else await mkdir(subdir(name), { mode: 448 });
		if (successor) {
			const file = successor.snapshot.session_file, s = await lstat(file);
			if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 3657 || await realpath(file) !== file) throw Error("Unsafe successor saved session");
		}
		const args = [
			"--mode",
			"rpc",
			...successor ? ["--session", successor.snapshot.session_file] : [this.#config.web ? "--continue" : "--no-session"],
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			"--no-tools",
			"--no-mcp",
			"--session-dir",
			subdir("sessions")
		];
		if (this.#config.provider) {
			const provider = this.#config.provider;
			args.push("--extension", await realpath(provider.extensionPath), "--provider", provider.name, "--model", provider.model);
		}
		if (successor) args.push("--provider", successor.snapshot.provider, "--model", successor.snapshot.model, "--thinking", successor.snapshot.thinking);
		let enrollment;
		let runtime, runtimeEnv = {}, preload;
		if (this.#config.runtimeControl) {
			const socketPath = subdir("run/control.sock"), token = randomBytes(32).toString("hex"), runId = randomBytes(16).toString("hex");
			const client = new RuntimeClient({
				socketPath,
				token
			});
			preload = await realpath(fileURLToPath(new URL("../../runtime/pi_rpc_guard.mjs", import.meta.url)));
			await access(preload, constants.R_OK);
			runtime = {
				client,
				runId,
				pendingAdmission: successor?.operationId
			};
			runtimeEnv = {
				PI_RUNTIME_RUN_ID: runId,
				PI_RUNTIME_CHILD_TOKEN: token,
				PI_RUNTIME_EXTENSION_SOCKET: socketPath,
				PI_RUNTIME_RPC_WEB_INPUT: "correlated-text-v1"
			};
			if (successor) runtimeEnv.PI_RUNTIME_PENDING_ACTIVATION = successor.operationId;
		}
		let webEnv = {};
		if (this.#config.web) {
			const web = this.#config.web;
			const config = readHubConfig(web.hubConfigFile);
			const credentialFile = subdir(previous ? `web-registration-${randomUUID()}.json` : "web-registration.json");
			const extension = await realpath(web.extensionPath);
			enrollment = {
				config,
				runId: issueSession(config, credentialFile, { label: request.instanceId }).run_id
			};
			args.push("--extension", extension);
			webEnv = {
				PI_WEB_UI_HOST: "127.0.0.1",
				PI_WEB_UI_PORT: String(web.port),
				PI_WEB_UI_DISABLED: "false",
				PI_WEB_UI_REGISTRY_SOCKET: config.socketPath,
				PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: credentialFile
			};
		}
		signal.throwIfAborted();
		const child = spawn(preload ? process.execPath : executable, preload ? [
			"--import",
			preload,
			executable,
			...args
		] : args, {
			cwd: workspace,
			shell: false,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
				LANG: "C.UTF-8",
				HOME: subdir("home"),
				TMPDIR: subdir("tmp"),
				XDG_CONFIG_HOME: subdir("config"),
				XDG_CACHE_HOME: subdir("cache"),
				XDG_DATA_HOME: subdir("data"),
				XDG_STATE_HOME: subdir("state"),
				XDG_RUNTIME_DIR: subdir("run"),
				PI_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SESSION_DIR: subdir("sessions"),
				PI_MANAGER_CONFIG: subdir("manager.json"),
				PI_WEB_UI_HUB_CONFIG: subdir("legacy-manager.json"),
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				...webEnv,
				...runtimeEnv
			}
		});
		const processIdentity = child.pid ? readProcessIdentity(child.pid) : null;
		const auditFile = previous ? `identity-${randomUUID()}.json` : "identity.json";
		const identity = Object.freeze({
			instanceId: request.instanceId,
			pid: child.pid ?? 0,
			processIdentity: processIdentity ?? "",
			workspace,
			stateDir,
			agentDir,
			auditFile,
			generation: (previous?.generation ?? -1) + 1
		});
		const entry = {
			child,
			identity,
			status: "starting",
			exited: false,
			exit: deferred(),
			buffer: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
			stderrTruncated: false,
			pending: /* @__PURE__ */ new Map(),
			enrollment,
			runtime
		};
		this.#owned.set(request.instanceId, entry);
		child.on("error", () => {
			this.#fail(entry, /* @__PURE__ */ new Error("Pi child spawn or process error"));
			if (!child.pid) this.#finish(entry);
		});
		child.once("exit", () => this.#finish(entry));
		child.stdin.on("error", () => this.#fail(entry, /* @__PURE__ */ new Error("Pi stdin failed")));
		child.stdout.on("error", () => this.#fail(entry, /* @__PURE__ */ new Error("Pi stdout failed")));
		child.stderr.on("error", () => this.#fail(entry, /* @__PURE__ */ new Error("Pi stderr failed")));
		child.stdout.on("data", (chunk) => this.#consume(entry, chunk));
		child.stdout.on("end", () => {
			if (!entry.stop && !entry.exited) this.#fail(entry, /* @__PURE__ */ new Error("Pi stdout ended before shutdown"));
		});
		child.stderr.on("data", (chunk) => {
			entry.stderrTruncated ||= entry.stderr.length + chunk.length > this.#stderrBytes;
			entry.stderr = Buffer.from(Buffer.concat([entry.stderr, chunk]).subarray(-this.#stderrBytes));
		});
		const abort = () => this.#fail(entry, /* @__PURE__ */ new Error("Startup aborted"));
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (!processIdentity) throw new Error("Child process identity unavailable");
			await writeFile(subdir(auditFile), JSON.stringify({
				schemaVersion: 1,
				...identity
			}) + "\n", {
				flag: "wx",
				mode: 384
			});
			const response = await this.#request(entry, "get_state", {}, this.#startupMs);
			if (!object$1(response.data) || typeof response.data.isStreaming !== "boolean" || typeof response.data.isCompacting !== "boolean") throw new Error("Invalid readiness state");
			if (entry.error) throw entry.error;
			signal.throwIfAborted();
			entry.status = "ready";
			if (successor) {
				const restored = await this.#runtimeSnapshot(entry, await runtime.client.request({ action: "snapshot" }));
				for (const field of [
					"session_id",
					"leaf_id",
					"session_file",
					"cwd",
					"provider",
					"model",
					"thinking"
				]) if (restored[field] !== successor.snapshot[field]) throw Error("Restored successor differs from captured context");
				if (!restored.idle || restored.pending || restored.busy) throw Error("Restored successor is not quiescent");
			}
			return identity;
		} catch (error) {
			if ((await this.#stop(entry)).status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
			throw error;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	#request(entry, command, fields, ms) {
		if (entry.error || entry.exited || entry.stop) return Promise.reject(entry.error ?? /* @__PURE__ */ new Error("Pi child stopped"));
		const id = randomUUID();
		const pending = {
			...deferred(),
			command,
			timer: setTimeout(() => this.#fail(entry, /* @__PURE__ */ new Error(`${command} RPC deadline exceeded`)), ms)
		};
		entry.pending.set(id, pending);
		entry.child.stdin.write(JSON.stringify({
			id,
			type: command,
			...fields
		}) + "\n", (error) => {
			if (error) this.#fail(entry, /* @__PURE__ */ new Error("Pi command write failed"));
		});
		return pending.promise;
	}
	#consume(entry, chunk) {
		if (entry.error) return;
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			const part = chunk.subarray(offset, end);
			if (entry.buffer.length + part.length > this.#frameBytes) return this.#fail(entry, /* @__PURE__ */ new Error("RPC frame exceeds limit"));
			entry.buffer = Buffer.concat([entry.buffer, part]);
			if (newline < 0) return;
			try {
				const line = new TextDecoder("utf-8", { fatal: true }).decode(entry.buffer);
				const record = JSON.parse(line);
				if (!object$1(record) || typeof record.type !== "string") throw new Error();
				this.#record(entry, record);
			} catch {
				this.#fail(entry, /* @__PURE__ */ new Error("Invalid UTF-8 JSON RPC frame"));
			}
			entry.buffer = Buffer.alloc(0);
			if (entry.error) return;
			offset = newline + 1;
		}
	}
	#record(entry, record) {
		if (record.type === "response") {
			const pending = typeof record.id === "string" ? entry.pending.get(record.id) : void 0;
			if (!pending) return;
			if (record.command !== pending.command || typeof record.success !== "boolean") return this.#fail(entry, /* @__PURE__ */ new Error("Mismatched RPC response"));
			clearTimeout(pending.timer);
			entry.pending.delete(record.id);
			if (record.success) pending.resolve(record);
			else pending.reject(/* @__PURE__ */ new Error(`${pending.command} RPC rejected`));
			return;
		}
		const generation = entry.generation;
		if (!generation) return;
		if (record.type === "agent_end") generation.agentEndObserved = true;
		if (record.type === "message_end" && object$1(record.message) && record.message.role === "assistant") {
			generation.lastMessageFailed = record.message.stopReason === "error";
			if (generation.lastMessageFailed) return;
			if (Array.isArray(record.message.content)) {
				for (const part of record.message.content) if (object$1(part) && part.type === "text" && typeof part.text === "string") {
					if (Buffer.byteLength(generation.text) + Buffer.byteLength(part.text) > this.#frameBytes) return this.#fail(entry, /* @__PURE__ */ new Error("Generation output exceeds limit"));
					generation.text += part.text;
				}
			}
		}
		if (record.type === "agent_settled") {
			if (typeof record.aborted !== "boolean") return this.#fail(entry, /* @__PURE__ */ new Error("Invalid settled event"));
			generation.settled = true;
			generation.aborted = record.aborted;
			if (generation.lastMessageFailed && !generation.aborted) return this.#fail(entry, /* @__PURE__ */ new Error("Pi generation failed"));
			generation.resolve();
		}
	}
	#fail(entry, error) {
		entry.error ??= error;
		for (const pending of entry.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(entry.error);
		}
		entry.pending.clear();
		entry.generation?.reject(entry.error);
		entry.buffer = Buffer.alloc(0);
		if (entry.status === "ready" && !entry.stop) this.#stop(entry).catch(() => {});
	}
	#finish(entry) {
		if (entry.enrollment) try {
			revokeSession(entry.enrollment.config, entry.enrollment.runId);
		} catch {
			entry.enrollment.revokeFailed = true;
		}
		if (entry.exited) return;
		entry.exited = true;
		this.#fail(entry, /* @__PURE__ */ new Error("Pi child exited"));
		entry.exit.resolve();
		if (this.#owned.get(entry.identity.instanceId) === entry) this.#owned.delete(entry.identity.instanceId);
		entry.child.stdin.destroy();
		entry.child.stdout.destroy();
		entry.child.stderr.destroy();
	}
	#stop(entry) {
		if (entry.stop) return entry.stop;
		entry.status = "stopping";
		this.#fail(entry, /* @__PURE__ */ new Error("Pi child stopping"));
		entry.stop = this.#shutdown(entry);
		return entry.stop;
	}
	async #shutdown(entry) {
		let forced = false;
		entry.child.stdin.end();
		for (const signal of ["SIGTERM", "SIGKILL"]) {
			if (await exitedWithin(entry, this.#stopMs)) break;
			if (entry.child.pid !== entry.identity.pid || !matchesProcessIdentity(entry.identity.pid, entry.identity.processIdentity)) {
				entry.status = "ownership-lost";
				return { status: "ownership-lost" };
			}
			if (entry.child.exitCode !== null || entry.child.signalCode !== null) break;
			forced = true;
			try {
				entry.child.kill(signal);
			} catch {
				entry.status = "ownership-lost";
				return { status: "ownership-lost" };
			}
		}
		if (!await exitedWithin(entry, this.#stopMs)) {
			entry.status = "ownership-lost";
			return { status: "ownership-lost" };
		}
		if (entry.enrollment?.revokeFailed) throw new ExecutionOutcomeUnknownError();
		return {
			status: "stopped",
			exitCode: entry.child.exitCode,
			signal: entry.child.signalCode,
			forced
		};
	}
};
//#endregion
//#region manager/executor/native-adapter.ts
var NativeTaskAdapter = class {
	actions;
	capabilities;
	policy;
	#backend;
	#config;
	#workspaces;
	#owners = /* @__PURE__ */ new Map();
	#starting = /* @__PURE__ */ new Map();
	#saved = /* @__PURE__ */ new Map();
	#blocked = /* @__PURE__ */ new Set();
	constructor(config, workspaces) {
		requireThat(config.trustedLocalNative && config.native, 503);
		this.#config = structuredClone(config);
		this.#workspaces = workspaces;
		this.#backend = new NativeBackend(this.#config.native);
		this.actions = Object.freeze(config.native.web ? [
			"create",
			"stop",
			"start"
		] : ["create", "stop"]);
		this.capabilities = {
			native: true,
			docker: false,
			isolation: "trusted-local-development",
			enrollment: !!config.native.web
		};
		this.policy = JSON.parse(JSON.stringify({
			native: config.native,
			workspaces: config.workspaces,
			trustedLocalNative: true
		}));
	}
	async validate(request) {
		if (request.action === "stop") {
			requireThat(this.#owners.get(request.target) === request.requester, 403);
			return;
		}
		if (request.action === "start") {
			requireThat(this.#config.native.web, 503);
			requireThat(this.#owners.get(request.target) === request.requester, 403);
			requireThat(this.#saved.has(request.target) && !this.#blocked.has(request.target) && !this.#starting.has(request.target), 409);
			requireThat(await this.#backend.inspect(request.target) === null, 409);
			return;
		}
		requireThat(request.action === "create", 503);
		requireThat(!this.#owners.has(request.target), 409);
		await this.#workspace(request);
	}
	async #workspace(request) {
		const payload = record$1(request.payload);
		keys(payload, ["workspace"]);
		const selection = payload.workspace;
		if (this.#workspaces) return await this.#workspaces.resolve(selection);
		requireThat(typeof selection === "string" && Object.hasOwn(this.#config.workspaces, selection));
		const w = this.#config.workspaces[selection];
		try {
			const root = await realpath(this.#config.native.workspaceRoots[w.root]);
			const selected = await realpath(path.resolve(root, w.path));
			const relative = path.relative(root, selected);
			requireThat(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && (await stat(selected)).isDirectory());
		} catch {
			requireThat(false);
		}
		return {
			root: w.root,
			path: w.path
		};
	}
	async execute(task) {
		if (task.action === "create") {
			requireThat(!this.#owners.has(task.target), 409);
			this.#owners.set(task.target, task.requester);
			const controller = new AbortController();
			this.#starting.set(task.target, controller);
			try {
				const resolved = await this.#workspace(task);
				controller.signal.throwIfAborted();
				const identity = await this.#backend.create({
					instanceId: task.target,
					workspace: resolved
				}, { signal: controller.signal });
				const saved = {
					workspace: structuredClone(record$1(task.payload).workspace),
					identity
				};
				this.#saved.set(task.target, saved);
				return {
					status: "created",
					instanceId: identity.instanceId,
					saved: JSON.parse(JSON.stringify(saved))
				};
			} finally {
				this.#starting.delete(task.target);
			}
		}
		if (task.action === "start") {
			requireThat(this.#config.native.web, 503);
			requireThat(this.#owners.get(task.target) === task.requester, 403);
			requireThat(this.#saved.has(task.target) && !this.#blocked.has(task.target) && !this.#starting.has(task.target), 409);
			const controller = new AbortController();
			this.#starting.set(task.target, controller);
			try {
				requireThat(await this.#backend.inspect(task.target) === null, 409);
				controller.signal.throwIfAborted();
				const saved = this.#saved.get(task.target);
				const resolved = this.#workspaces ? await this.#workspaces.resolve(saved.workspace) : (() => {
					requireThat(typeof saved.workspace === "string" && Object.hasOwn(this.#config.workspaces, saved.workspace), 409);
					const w = this.#config.workspaces[saved.workspace];
					return {
						root: w.root,
						path: w.path
					};
				})();
				const identity = await this.#backend.resume({
					instanceId: task.target,
					workspace: resolved
				}, saved.identity, { signal: controller.signal });
				const next = {
					workspace: saved.workspace,
					identity
				};
				this.#saved.set(task.target, next);
				return {
					status: "started",
					instanceId: task.target,
					saved: JSON.parse(JSON.stringify(next))
				};
			} catch (error) {
				this.#blocked.add(task.target);
				throw error;
			} finally {
				this.#starting.delete(task.target);
			}
		}
		await this.validate(task);
		this.#starting.get(task.target)?.abort();
		try {
			const result = await this.#backend.stop(task.target);
			if (result.status === "ownership-lost") throw new ExecutionOutcomeUnknownError();
			return {
				status: result.status,
				instanceId: task.target
			};
		} catch (error) {
			if (error instanceof ExecutionOutcomeUnknownError) this.#blocked.add(task.target);
			throw error;
		}
	}
	restore(records) {
		for (const task of records) if (task.action === "create" && [
			"running",
			"succeeded",
			"failed",
			"unknown"
		].includes(task.state)) this.#owners.set(task.target, task.requester);
		for (const task of records) {
			if (this.#owners.get(task.target) !== task.requester) continue;
			if ([
				"create",
				"start",
				"stop"
			].includes(task.action) && ["unknown", "running"].includes(task.state)) this.#blocked.add(task.target);
			if (task.action === "start" && task.state === "failed") this.#blocked.add(task.target);
			if (!["create", "start"].includes(task.action) || task.state !== "succeeded") continue;
			if (task.result === void 0) continue;
			const result = record$1(task.result);
			if (result.saved === void 0) continue;
			const saved = record$1(result.saved), identity = record$1(saved.identity);
			const workspace = saved.workspace;
			const dynamic = workspace !== null && typeof workspace === "object" && !Array.isArray(workspace) ? workspace : void 0;
			requireThat(typeof workspace === "string" && Object.hasOwn(this.#config.workspaces, workspace) || this.#config.workspaceBrowser !== void 0 && dynamic !== void 0 && Object.keys(dynamic).length === 2 && typeof dynamic.root === "string" && typeof dynamic.path === "string", 409);
			requireThat(identity.instanceId === task.target && Number.isSafeInteger(identity.generation), 409);
			const prior = this.#saved.get(task.target);
			if (!prior || identity.generation > (prior.identity.generation ?? 0)) this.#saved.set(task.target, structuredClone(saved));
		}
	}
	resources(requester) {
		return this.#backend.list().filter((i) => this.#owners.get(i.instanceId) === requester).map((i) => ({ instanceId: i.instanceId }));
	}
	async close() {
		requireThat((await Promise.allSettled(this.#backend.list().map((i) => this.#backend.stop(i.instanceId)))).every((r) => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
	}
};
//#endregion
//#region manager/backends/docker.ts
var OWNER = "cn.swordfate.pi-manager.owner";
var INSTANCE = "cn.swordfate.pi-manager.instance";
var NONCE = "cn.swordfate.pi-manager.nonce";
var HEX = /^[a-f0-9]{64}$/;
var ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
var hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
var overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
var inside = (root, value) => value === root || value.startsWith(root + path.sep);
function absolute(v) {
	if (typeof v !== "string" || !path.isAbsolute(v) || v === "/" || path.resolve(v) !== v || v.includes("\0")) throw new DockerOperationError("Invalid administrator path");
	return v;
}
function fixedArgs(v, fallback) {
	const args = v ?? fallback;
	if (!Array.isArray(args) || !args.length || args.length > 64 || args.some((s) => typeof s !== "string" || !s || s.includes("\0") || s.length > 8192)) throw new DockerOperationError("Invalid administrator image contract");
	return Object.freeze([...args]);
}
/**
* Executor-only Docker lifecycle. Never pulls, builds, prunes, adopts foreign
* containers, or deletes homes. The private TaskStore is an ownership journal,
* not a second public approval queue. Approval is the enclosing executor's job.
*/
var DockerBackend = class DockerBackend {
	#config;
	#engine;
	#journal;
	#owner;
	#protected;
	#hub;
	#enrollment;
	#tail = Promise.resolve();
	#closed = false;
	constructor(config, journal, owner, protectedPaths, hub) {
		this.#config = config;
		this.#journal = journal;
		this.#owner = owner;
		this.#protected = protectedPaths;
		this.#hub = hub;
		this.#enrollment = config.web?.enrollment ? new EnrollmentClient(config.web.enrollment) : void 0;
		this.#engine = new DockerEngine(config.socketPath, { timeoutMs: config.timeoutMs });
	}
	static async open(input, options = {}) {
		if (!object(input) || Object.keys(input).some((k) => ![
			"socketPath",
			"daemonId",
			"image",
			"pathCoordinates",
			"stateRoot",
			"workspaceRoots",
			"protectedRoots",
			"timeoutMs",
			"startupTimeoutMs",
			"runtimeProfile",
			"entrypoint",
			"command",
			"web"
		].includes(k))) throw new DockerOperationError("Invalid Docker configuration");
		if (input.startupTimeoutMs !== void 0 && (!Number.isInteger(input.startupTimeoutMs) || input.startupTimeoutMs < 100 || input.startupTimeoutMs > 12e4)) throw new DockerOperationError("Invalid startup limit");
		if (input.runtimeProfile !== void 0 && input.web === void 0) throw new DockerOperationError("Runtime profile requires Web");
		const profile = input.runtimeProfile === void 0 ? void 0 : runtimeProfile(input.runtimeProfile);
		if (input.pathCoordinates !== "host" || typeof input.daemonId !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.daemonId) || typeof input.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new DockerOperationError("Pinned daemon and image identities required");
		const socketPath = absolute(input.socketPath);
		const stateRoot = absolute(input.stateRoot);
		if (!object(input.workspaceRoots) || !Object.keys(input.workspaceRoots).length || Object.keys(input.workspaceRoots).length > 32) throw new DockerOperationError("Invalid workspace policy");
		const roots = {};
		for (const [name, root] of Object.entries(input.workspaceRoots)) {
			if (!ID.test(name) || name === "__proto__") throw new DockerOperationError("Invalid workspace policy");
			const source = absolute(root);
			if (await realpath(source) !== source || !(await stat(source)).isDirectory()) throw new DockerOperationError("Canonical workspace roots required");
			if (options.allowProtectedDescendants ? inside(stateRoot, source) || inside(socketPath, source) : overlaps(source, stateRoot) || overlaps(source, socketPath)) throw new DockerOperationError("Workspace overlaps private authority");
			roots[name] = source;
		}
		if (input.protectedRoots !== void 0 && (!Array.isArray(input.protectedRoots) || input.protectedRoots.length > 64)) throw new DockerOperationError("Invalid protected paths");
		let web;
		let hub;
		const webProtected = [];
		if (input.web !== void 0) {
			const w = input.web;
			if (!object(w) || Object.keys(w).some((k) => ![
				"packageRoot",
				"hubConfigFile",
				"enrollment",
				"port",
				"provider"
			].includes(k)) || w.hubConfigFile === void 0 === (w.enrollment === void 0) || !Number.isInteger(w.port) || w.port < 1 || w.port > 65535 || input.command !== void 0 || input.entrypoint !== void 0) throw new DockerOperationError("Invalid explicit Web profile");
			for (const p of [absolute(w.packageRoot), ...w.hubConfigFile === void 0 ? [] : [absolute(w.hubConfigFile)]]) if (await realpath(p) !== p) throw new DockerOperationError("Canonical Web paths required");
			if (!(await stat(path.join(w.packageRoot, "extensions/mirror-server.ts"))).isFile() || !(await stat(path.join(w.packageRoot, "dist/index.html"))).isFile()) throw new DockerOperationError("Installed Web package required");
			webProtected.push(w.packageRoot);
			if (w.hubConfigFile !== void 0) {
				const h = hub = readHubConfig(w.hubConfigFile);
				webProtected.push(w.hubConfigFile, h.stateDir, h.runtimeDir);
			}
			if (w.enrollment !== void 0) {
				const e = enrollmentConfig(w.enrollment);
				for (const p of [path.dirname(e.socketPath), e.authorityFile]) if (await realpath(p) !== p) throw new DockerOperationError("Canonical enrollment paths required");
				await readEnrollmentAuthority(e.authorityFile);
				webProtected.push(path.dirname(e.socketPath), e.authorityFile, e.registryHostDirectory, e.exportHostDirectory);
			}
			if (w.provider !== void 0) {
				const p = w.provider;
				if (!exact(p, [
					"packageRoot",
					"name",
					"model"
				]) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(p.name) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(p.model) || await realpath(absolute(p.packageRoot)) !== p.packageRoot || !(await stat(path.join(p.packageRoot, "index.ts"))).isFile()) throw new DockerOperationError("Invalid explicit provider profile");
				webProtected.push(p.packageRoot);
			}
			web = Object.freeze({
				...w,
				...w.enrollment ? { enrollment: enrollmentConfig(w.enrollment) } : {},
				...w.provider ? { provider: Object.freeze({ ...w.provider }) } : {}
			});
		}
		const authorityPaths = [
			stateRoot,
			socketPath,
			...(input.protectedRoots ?? []).map(absolute),
			...hub ? [
				hub.stateDir,
				hub.runtimeDir,
				input.web.hubConfigFile
			] : [],
			...web?.enrollment ? [
				path.dirname(web.enrollment.socketPath),
				web.enrollment.authorityFile,
				web.enrollment.registryHostDirectory,
				web.enrollment.exportHostDirectory
			] : []
		];
		if (web && [web.packageRoot, ...web.provider ? [web.provider.packageRoot] : []].some((source) => authorityPaths.some((p) => overlaps(source, p)))) throw new DockerOperationError("Web source overlaps private authority");
		if (profile) {
			if (runtimeProfileSources(profile).some((source) => authorityPaths.some((p) => overlaps(source, p)))) throw new DockerOperationError("Runtime source overlaps private authority");
			await validateRuntimeSources(profile);
		}
		const protectedPaths = [
			stateRoot,
			socketPath,
			fileURLToPath(new URL("../..", import.meta.url)),
			...webProtected,
			...(input.protectedRoots ?? []).map(absolute),
			...runtimeProfileSources(profile)
		];
		for (const root of Object.values(roots)) if (protectedPaths.some((p) => options.allowProtectedDescendants ? inside(p, root) : overlaps(root, p))) throw new DockerOperationError("Workspace overlaps private authority");
		const config = Object.freeze({
			...input,
			socketPath,
			stateRoot,
			workspaceRoots: Object.freeze(roots),
			protectedRoots: Object.freeze(protectedPaths),
			entrypoint: fixedArgs(input.entrypoint, ["/usr/local/bin/pi-entrypoint"]),
			runtimeProfile: profile,
			web,
			command: fixedArgs(input.command, web ? [
				"--mode",
				"rpc",
				"--continue",
				...profile ? [] : ["--offline"],
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				...profile ? [] : ["--no-tools"],
				"--no-mcp",
				"--no-approve",
				"--session-dir",
				"/home/node/.pi/manager-sessions",
				"--extension",
				"/opt/pi-web/extensions/mirror-server.ts",
				...web.provider ? [
					"--extension",
					"/opt/pi-provider/index.ts",
					"--provider",
					web.provider.name,
					"--model",
					web.provider.model
				] : [],
				...(profile?.extensions ?? []).flatMap((e, i) => ["--extension", `/opt/pi-profile/extensions/${i}/${e.entry}`])
			] : [
				"--mode",
				"rpc",
				"--no-session",
				"--offline"
			])
		});
		const owner = hash({
			daemonId: config.daemonId,
			image: config.image,
			stateRoot,
			roots,
			protectedPaths,
			entrypoint: config.entrypoint,
			command: config.command,
			web,
			...profile ? { runtimeProfile: profile } : {},
			...input.startupTimeoutMs === void 0 ? {} : { startupTimeoutMs: input.startupTimeoutMs }
		});
		const journal = await TaskStore.open(stateRoot);
		try {
			for (const record of await journal.list()) if (record.requester !== owner || record.action !== "docker.create") throw new DockerOperationError("Docker journal policy changed; explicit migration required");
			return new DockerBackend(config, journal, owner, protectedPaths, hub);
		} catch (error) {
			await journal.close();
			throw error;
		}
	}
	#serial(operation) {
		if (this.#closed) return Promise.reject(new DockerOperationError("Docker backend closed"));
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => {});
		return result;
	}
	async #daemon() {
		const info = await this.#engine.call("GET", "/info");
		if (!object(info) || info.ID !== this.#config.daemonId) throw new DockerOperationError("Docker daemon identity changed");
	}
	async #workspace(request) {
		if (!exact(request, ["instanceId", "workspace"]) || !ID.test(request.instanceId) || !exact(request.workspace, ["root", "path"])) throw new DockerOperationError("Invalid Docker create request");
		const { root: key, path: selection } = request.workspace;
		if (typeof key !== "string" || !Object.hasOwn(this.#config.workspaceRoots, key) || typeof selection !== "string" || path.isAbsolute(selection) || selection.includes("\0") || selection.includes("\\") || selection.split("/").includes("..")) throw new DockerOperationError("Invalid workspace selection");
		const root = this.#config.workspaceRoots[key];
		if (await realpath(root) !== root) throw new DockerOperationError("Workspace root changed");
		const selected = path.resolve(root, selection);
		let current = root;
		for (const segment of path.relative(root, selected).split(path.sep).filter(Boolean)) {
			current = path.join(current, segment);
			const metadata = await lstat(current);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DockerOperationError("Workspace directory changed");
		}
		const workspace = await realpath(selected);
		const relative = path.relative(root, workspace);
		if (workspace !== selected || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(workspace)).isDirectory() || this.#protected.some((p) => overlaps(workspace, p))) throw new DockerOperationError("Workspace escapes policy or overlaps private authority");
		return workspace;
	}
	async #savedWorkspace(task) {
		try {
			const payload = task.payload;
			const saved = object(payload) ? payload.workspace : void 0;
			if (typeof saved !== "string" || absolute(saved) !== saved) throw new Error();
			const root = Object.entries(this.#config.workspaceRoots).find(([, directory]) => inside(directory, saved));
			if (!root || await this.#workspace({
				instanceId: task.target,
				workspace: {
					root: root[0],
					path: path.relative(root[1], saved)
				}
			}) !== saved) throw new Error();
		} catch {
			throw new DockerOperationError("Saved workspace no longer satisfies the approved policy");
		}
	}
	/** Approval/execution preflight; inspection and stop deliberately stay independent. */
	validateStart(instanceId) {
		return this.#serial(async () => {
			const task = await this.#record(instanceId);
			if (!task) throw new DockerOperationError("Instance not owned");
			this.#identity(task);
			await this.#savedWorkspace(task);
		});
	}
	#labels(task) {
		return {
			[OWNER]: this.#owner,
			[INSTANCE]: task.target,
			[NONCE]: task.id
		};
	}
	#home(task) {
		return `pi-manager-home-${task.id.replaceAll("-", "")}`;
	}
	#identity(task) {
		const result = task.result;
		if (task.state !== "succeeded" || !exact(result, ["containerId", "homeVolume"]) || !HEX.test(result.containerId) || result.homeVolume !== this.#home(task)) throw new DockerOperationError("Docker identity unavailable; reconciliation required");
		return Object.freeze({
			instanceId: task.target,
			containerId: result.containerId,
			homeVolume: result.homeVolume,
			image: this.#config.image
		});
	}
	#webMounts(task) {
		const w = this.#config.web;
		if (!w) return [];
		const h = this.#hub;
		return [
			{
				Type: "bind",
				Source: w.packageRoot,
				Target: "/opt/pi-web",
				ReadOnly: true
			},
			{
				Type: "bind",
				Source: w.enrollment?.registryHostDirectory ?? h.runtimeDir,
				Target: "/run/pi-registry",
				ReadOnly: true
			},
			{
				Type: "bind",
				Source: path.join(w.enrollment?.exportHostDirectory ?? this.#config.stateRoot, `registration-${task.id}.json`),
				Target: "/run/pi-web/credential.json",
				ReadOnly: true
			},
			...w.provider ? [{
				Type: "bind",
				Source: w.provider.packageRoot,
				Target: "/opt/pi-provider",
				ReadOnly: true
			}] : []
		];
	}
	#environment() {
		const web = this.#config.web;
		return [
			"HOME=/home/node",
			"PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin",
			...web ? [
				"PI_AGENT_DIR=/home/node/.pi/manager-agent",
				"PI_CODING_AGENT_DIR=/home/node/.pi/manager-agent",
				...this.#config.runtimeProfile ? [] : ["PI_OFFLINE=1"],
				"PI_SKIP_VERSION_CHECK=1",
				"PI_WEB_UI_HOST=127.0.0.1",
				`PI_WEB_UI_PORT=${web.port}`,
				"PI_WEB_UI_DISABLED=false",
				"PI_WEB_UI_REGISTRY_SOCKET=/run/pi-registry/registry.sock",
				"PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=/run/pi-web/credential.json"
			] : [],
			...Object.entries(this.#config.runtimeProfile?.environment ?? {}).map(([key, value]) => `${key}=${value}`)
		];
	}
	async #image() {
		const image = await this.#engine.call("GET", `/images/${encodeURIComponent(this.#config.image)}/json`);
		if (!object(image) || image.Id !== this.#config.image || !object(image.Config) || image.Config.Volumes && Object.keys(image.Config.Volumes).length) throw new DockerOperationError("Pinned Docker image contract unavailable");
		if (this.#config.runtimeProfile && Array.isArray(image.Config.Env) && image.Config.Env.some((e) => typeof e === "string" && (e === "PI_OFFLINE" || e.startsWith("PI_OFFLINE=")))) throw new DockerOperationError("Pinned Docker image contract unavailable");
		if (this.#config.runtimeProfile?.modelsFile && image.Config.Labels?.["cn.swordfate.pi-manager.profile-home"] !== "uid1000-v1") throw new DockerOperationError("Pinned Docker image contract unavailable");
		return image;
	}
	async #runtime() {
		const p = this.#config.runtimeProfile;
		if (!p) return;
		await validateRuntimeSources(p);
		if (p.runtimeVolume) {
			const v = await this.#engine.call("GET", `/volumes/${p.runtimeVolume}`, void 0, { allowMissing: true });
			if (!object(v) || v.Name !== p.runtimeVolume || v.Driver !== "local" || v.Options && Object.keys(v.Options).length) throw new DockerOperationError("Existing local runtime volume required");
		}
	}
	async #ready(task) {
		if (!this.#enrollment) return;
		if ((await this.#owned(task))?.State?.Running !== true) throw new DockerOperationError("Pi is not running; retained identity requires approved start");
		const deadline = Date.now() + (this.#config.startupTimeoutMs ?? 2e4);
		while (Date.now() < deadline) {
			let ready = false;
			try {
				ready = await this.#enrollment.status(task.id, task.target, deadline - Date.now());
			} catch {}
			if (ready) return;
			const remaining = deadline - Date.now();
			if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
		}
		throw new DockerOperationError("Pi registration readiness timed out; retained identity requires approved start");
	}
	async #record(instanceId) {
		if (typeof instanceId !== "string" || !ID.test(instanceId)) throw new DockerOperationError("Invalid instance ID");
		return (await this.#journal.list()).find((task) => task.target === instanceId);
	}
	async #owned(task) {
		const identity = this.#identity(task);
		const info = await this.#engine.call("GET", `/containers/${identity.containerId}/json`, void 0, { allowMissing: true });
		if (info === null) return null;
		const expected = this.#labels(task);
		const cfg = object(info) && object(info.Config) ? info.Config : void 0;
		const host = object(info) && object(info.HostConfig) ? info.HostConfig : void 0;
		const webMounts = [...this.#webMounts(task), ...runtimeProfileMounts(this.#config.runtimeProfile)];
		if (!object(info) || info.Id !== identity.containerId || info.Image !== identity.image || !cfg || !object(cfg.Labels) || Object.entries(expected).some(([k, v]) => cfg.Labels[k] !== v) || cfg.User !== "1000:1000" || !host || host.Privileged !== false || host.ReadonlyRootfs !== true || JSON.stringify(host.CapDrop) !== "[\"ALL\"]" || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges:true") || host.NetworkMode !== (this.#config.web ? "host" : "none") || !Array.isArray(info.Mounts) || info.Mounts.length !== 2 + webMounts.length) throw new DockerOperationError("Container ownership or safety contract mismatch");
		for (const expected of webMounts) {
			const mount = info.Mounts.find((m) => m.Destination === expected.Target);
			if (!mount || mount.Type !== expected.Type || (expected.Type === "volume" ? mount.Name : mount.Source) !== expected.Source || mount.RW !== false) throw new DockerOperationError("Container enrollment/profile mount mismatch");
			if (expected.Type === "volume") {
				const configured = host.Mounts?.find((m) => m.Target === expected.Target);
				if (configured?.VolumeOptions?.NoCopy !== true || configured?.ReadOnly !== true) throw new DockerOperationError("Container runtime volume safety contract mismatch");
			}
		}
		const image = await this.#image();
		const environment = (entries) => {
			if (!Array.isArray(entries)) throw new DockerOperationError("Container environment contract mismatch");
			const result = /* @__PURE__ */ new Map();
			for (const entry of entries) {
				if (typeof entry !== "string" || !entry.includes("=") || entry.includes("\0")) throw new DockerOperationError("Container environment contract mismatch");
				const name = entry.slice(0, entry.indexOf("="));
				if (!name || result.has(name)) throw new DockerOperationError("Container environment contract mismatch");
				result.set(name, entry.slice(entry.indexOf("=") + 1));
			}
			return result;
		};
		const merged = environment(image.Config.Env ?? []);
		for (const [k, v] of environment(this.#environment())) merged.set(k, v);
		const actual = environment(cfg.Env);
		if (actual.size !== merged.size || [...merged].some(([k, v]) => actual.get(k) !== v) || JSON.stringify(cfg.Entrypoint) !== JSON.stringify(this.#config.entrypoint) || JSON.stringify(cfg.Cmd) !== JSON.stringify(this.#config.command) || cfg.WorkingDir !== "/workspace") throw new DockerOperationError("Container execution contract mismatch");
		const payload = task.payload;
		const workspace = object(payload) ? payload.workspace : void 0;
		const bind = info.Mounts.find((m) => m.Destination === "/workspace");
		const home = info.Mounts.find((m) => m.Destination === "/home/node");
		if (!bind || bind.Type !== "bind" || bind.Source !== workspace || bind.RW !== true || !home || home.Type !== "volume" || home.Name !== identity.homeVolume || home.RW !== true) throw new DockerOperationError("Container ownership mount mismatch");
		return info;
	}
	create(request, authority) {
		let copy;
		try {
			copy = structuredClone(request);
		} catch {
			return Promise.reject(new DockerOperationError("Invalid Docker create request"));
		}
		const binding = authority === void 0 ? void 0 : structuredClone(authority);
		if (binding && (!exact(binding, ["taskId", "requester"]) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(binding.taskId) || !ID.test(binding.requester))) return Promise.reject(new DockerOperationError("Invalid private task binding"));
		return this.#serial(async () => {
			const workspace = await this.#workspace(copy);
			await this.#daemon();
			const payload = {
				workspace,
				profile: this.#owner,
				...binding ? { authority: binding } : {}
			};
			let task = await this.#journal.submit({
				key: copy.instanceId,
				requester: this.#owner,
				target: copy.instanceId,
				action: "docker.create",
				payload
			});
			if (task.state === "succeeded") {
				if (!await this.#owned(task)) throw new DockerOperationError("Owned container missing; reconciliation required");
				await this.#ready(task);
				return this.#identity(task);
			}
			if (task.state !== "pending_approval") throw new DockerOperationError("Prior Docker operation requires reconciliation");
			await this.#image();
			await this.#runtime();
			task = await this.#journal.transition(task.id, "pending_approval", "queued", { expectedRevision: task.revision });
			task = await this.#journal.transition(task.id, "queued", "running", { expectedRevision: task.revision });
			try {
				const labels = this.#labels(task);
				const web = this.#config.web;
				const webMounts = [...this.#webMounts(task), ...runtimeProfileMounts(this.#config.runtimeProfile)];
				if (this.#enrollment) await this.#enrollment.issue(task.id, task.target);
				else if (web) {
					const h = this.#hub;
					const credential = webMounts.find((m) => m.Target === "/run/pi-web/credential.json").Source;
					issueSession(h, credential, { label: task.target });
					await chmod(credential, 292);
				}
				const homeVolume = this.#home(task);
				if (await this.#engine.call("GET", `/volumes/${homeVolume}`, void 0, { allowMissing: true }) !== null) throw new DockerOperationError("Preexisting volume requires reconciliation");
				const volume = await this.#engine.call("POST", "/volumes/create", {
					Name: homeVolume,
					Driver: "local",
					Labels: labels
				});
				if (!object(volume) || volume.Name !== homeVolume || volume.Driver !== "local" || volume.Options && Object.keys(volume.Options).length || !object(volume.Labels) || Object.entries(labels).some(([k, v]) => volume.Labels[k] !== v)) throw new DockerOutcomeUnknownError();
				const definition = {
					Image: this.#config.image,
					User: "1000:1000",
					WorkingDir: "/workspace",
					Entrypoint: [...this.#config.entrypoint],
					Cmd: [...this.#config.command],
					Env: this.#environment(),
					Labels: labels,
					AttachStdin: true,
					OpenStdin: true,
					StdinOnce: false,
					Tty: false,
					HostConfig: {
						Privileged: false,
						ReadonlyRootfs: true,
						NetworkMode: web ? "host" : "none",
						CapDrop: ["ALL"],
						SecurityOpt: ["no-new-privileges:true"],
						Memory: 1024 * 1024 * 1024,
						MemorySwap: 1024 * 1024 * 1024,
						NanoCpus: 1e9,
						PidsLimit: 256,
						RestartPolicy: {
							Name: "no",
							MaximumRetryCount: 0
						},
						LogConfig: {
							Type: "json-file",
							Config: {
								"max-size": "10m",
								"max-file": "3"
							}
						},
						Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777" },
						Mounts: [
							{
								Type: "bind",
								Source: workspace,
								Target: "/workspace",
								ReadOnly: false,
								BindOptions: { Propagation: "rprivate" }
							},
							{
								Type: "volume",
								Source: homeVolume,
								Target: "/home/node",
								ReadOnly: false
							},
							...webMounts
						]
					}
				};
				const created = await this.#engine.call("POST", `/containers/create?name=pi-manager-${task.id.replaceAll("-", "")}`, definition);
				if (!object(created) || typeof created.Id !== "string" || !HEX.test(created.Id)) throw new DockerOutcomeUnknownError();
				task = await this.#journal.transition(task.id, "running", "succeeded", {
					expectedRevision: task.revision,
					result: {
						containerId: created.Id,
						homeVolume
					}
				});
				if (!await this.#owned(task)) throw new DockerOutcomeUnknownError();
				await this.#savedWorkspace(task);
				await this.#engine.call("POST", `/containers/${created.Id}/start`);
				await this.#ready(task);
				return this.#identity(task);
			} catch (error) {
				if (task.state === "running") await this.#journal.transition(task.id, "running", "unknown", {
					expectedRevision: task.revision,
					result: { reason: "docker_reconciliation_required" }
				});
				throw error;
			}
		});
	}
	inspect(instanceId) {
		return this.#serial(async () => {
			const task = await this.#record(instanceId);
			if (!task) return null;
			await this.#daemon();
			const info = await this.#owned(task);
			return {
				...this.#identity(task),
				status: !info ? "missing" : info.State?.Running === true ? "running" : "stopped"
			};
		});
	}
	list() {
		return this.#serial(async () => (await this.#journal.list()).filter((t) => t.state === "succeeded").map((t) => this.#identity(t)));
	}
	boundAuthority(instanceId) {
		return this.#serial(async () => {
			const payload = (await this.#journal.list()).find((t) => t.target === instanceId && t.state === "succeeded")?.payload;
			const value = object(payload) ? payload.authority : void 0;
			return object(value) && typeof value.taskId === "string" && typeof value.requester === "string" ? {
				taskId: value.taskId,
				requester: value.requester
			} : null;
		});
	}
	start(instanceId) {
		return this.#change(instanceId, "start");
	}
	stop(instanceId) {
		return this.#change(instanceId, "stop");
	}
	#change(instanceId, action) {
		return this.#serial(async () => {
			const task = await this.#record(instanceId);
			if (!task) throw new DockerOperationError("Instance not owned");
			await this.#daemon();
			const info = await this.#owned(task);
			if (!info) throw new DockerOperationError("Owned container missing");
			const running = info.State?.Running === true;
			if (action === "start") {
				await this.#savedWorkspace(task);
				await this.#runtime();
				if (this.#enrollment) await this.#enrollment.issue(task.id, task.target);
				await this.#savedWorkspace(task);
			}
			if (action === "start" !== running) await this.#engine.call("POST", `/containers/${this.#identity(task).containerId}/${action}${action === "stop" ? "?t=10" : ""}`);
			const after = await this.#owned(task);
			if (!after || after.State?.Running === true !== (action === "start")) throw new DockerOutcomeUnknownError();
			if (action === "start") await this.#ready(task);
			return {
				...this.#identity(task),
				status: action === "start" ? "running" : "stopped"
			};
		});
	}
	async close() {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		this.#engine.close();
		this.#enrollment?.close();
		await this.#journal.close();
	}
};
//#endregion
//#region manager/executor/docker-adapter.ts
/** Requester authority belongs to TaskStore; exact container identity belongs to DockerBackend. */
var DockerTaskAdapter = class DockerTaskAdapter {
	actions = [
		"create",
		"stop",
		"start"
	];
	capabilities;
	policy;
	#config;
	#backend;
	#workspaces;
	#owners = /* @__PURE__ */ new Map();
	constructor(config, backend, workspaces) {
		this.#config = config;
		this.#backend = backend;
		this.#workspaces = workspaces;
		this.capabilities = {
			native: false,
			docker: true,
			isolation: "fixed-container",
			enrollment: !!config.docker?.web
		};
		this.policy = JSON.parse(JSON.stringify({
			docker: config.docker,
			workspaces: config.workspaces
		}));
	}
	static async open(value, workspacePolicy) {
		const config = executorConfig(value);
		requireThat(config.docker, 503);
		config.docker = {
			...config.docker,
			socketPath: await realpath(config.docker.socketPath)
		};
		executorConfig(config);
		await privateDirectory$1(config.docker.stateRoot);
		config.docker = {
			...config.docker,
			protectedRoots: [
				...config.docker.protectedRoots ?? [],
				config.stateRoot,
				path.dirname(config.submitSocket),
				path.dirname(config.adminSocket)
			]
		};
		const workspaces = workspacePolicy ?? await WorkspacePolicy.open(config);
		return new DockerTaskAdapter(config, await DockerBackend.open(config.docker, { allowProtectedDescendants: config.workspaceBrowser !== void 0 }), workspaces);
	}
	async restore(records) {
		for (const task of records) {
			if (task.action !== "create" || ![
				"succeeded",
				"unknown",
				"failed"
			].includes(task.state)) continue;
			if (task.state === "failed") {
				const binding = await this.#backend.boundAuthority(task.target);
				if (binding?.taskId !== task.id || binding.requester !== task.requester) continue;
			}
			requireThat(!this.#owners.has(task.target), 409);
			this.#owners.set(task.target, task.requester);
		}
	}
	async #workspace(request) {
		const payload = record$1(request.payload);
		keys(payload, ["workspace"]);
		return await this.#workspaces.resolve(payload.workspace);
	}
	async validate(request) {
		if (request.action === "create") {
			requireThat(!this.#owners.has(request.target), 409);
			requireThat(!(await this.#backend.list()).some((i) => i.instanceId === request.target), 409);
			await this.#workspace(request);
			return;
		}
		requireThat(request.action === "stop" || request.action === "start", 503);
		keys(record$1(request.payload), []);
		requireThat(this.#owners.get(request.target) === request.requester, 403);
		const owned = await this.#backend.inspect(request.target);
		requireThat(owned && owned.status !== "missing", 409);
		if (request.action === "start") await this.#backend.validateStart(request.target);
	}
	async execute(task) {
		if (task.action === "create") {
			requireThat(!this.#owners.has(task.target), 409);
			this.#owners.set(task.target, task.requester);
			requireThat(!(await this.#backend.list()).some((i) => i.instanceId === task.target), 409);
			const w = await this.#workspace(task);
			return {
				status: "created",
				instanceId: (await this.#backend.create({
					instanceId: task.target,
					workspace: {
						root: w.root,
						path: w.path
					}
				}, {
					taskId: task.id,
					requester: task.requester
				})).instanceId
			};
		}
		await this.validate(task);
		return {
			status: (task.action === "start" ? await this.#backend.start(task.target) : await this.#backend.stop(task.target)).status,
			instanceId: task.target
		};
	}
	async resources(requester) {
		return (await this.#backend.list()).filter((i) => this.#owners.get(i.instanceId) === requester).map((i) => ({ instanceId: i.instanceId }));
	}
	close() {
		return this.#backend.close();
	}
};
//#endregion
//#region manager/executor/main.ts
async function startExecutor(value) {
	const config = executorConfig(value);
	const workspacePolicy = await WorkspacePolicy.open(config);
	await privateDirectory$1(config.stateRoot);
	for (const socket of [config.submitSocket, config.adminSocket]) {
		requireThat(Buffer.byteLength(socket) <= 100);
		await privateDirectory$1(path.dirname(socket), config.socketMode === 432);
		let exists = true;
		try {
			await lstat(socket);
		} catch (e) {
			if (e.code === "ENOENT") exists = false;
			else throw e;
		}
		requireThat(!exists, 409);
	}
	const adapter = config.docker ? await DockerTaskAdapter.open(config, workspacePolicy) : config.native ? new NativeTaskAdapter(config, workspacePolicy) : void 0;
	let engine;
	try {
		engine = await TaskEngine.open(config, adapter, { workspacePolicy });
	} catch (error) {
		await adapter?.close();
		throw error;
	}
	const servers = [];
	try {
		for (const [transport, socket] of [["submit", config.submitSocket], ["admin", config.adminSocket]]) {
			servers.push(await listen(async (req, res) => {
				requireThat(req.method === "POST" && req.url === "/rpc" && header(req, "host") === "executor");
				const credential = bearer(req);
				const message = await jsonBody(req);
				reply(res, 200, await engine.dispatch(transport, credential, message));
			}, socket));
			await chmod(socket, config.socketMode ?? 384);
		}
	} catch (error) {
		await Promise.allSettled(servers.map((s) => s.close()));
		await engine.close();
		throw error;
	}
	let closing;
	return { close: () => closing ??= (async () => {
		const results = await Promise.allSettled(servers.map((s) => s.close()));
		await engine.close();
		requireThat(results.every((r) => r.status === "fulfilled"), 503);
	})() };
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
//#region bin/pi-manager-executor.mjs
await runProcess(async () => startExecutor(await readPrivateJson$1(configArgument(process.argv.slice(2)))));
//#endregion
export {};
