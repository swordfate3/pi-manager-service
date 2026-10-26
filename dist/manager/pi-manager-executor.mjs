#!/usr/bin/env node
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants, readFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
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
function record(value) {
	requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
	return value;
}
function keys(value, required, optional = []) {
	requireThat(required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => [...required, ...optional].includes(k)));
}
function identifier(value) {
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
//#region manager/config.ts
function absolute$1(value) {
	requireThat(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.resolve(value) === value);
	return value;
}
function executorConfig(value) {
	const c = record(structuredClone(value));
	keys(c, [
		"stateRoot",
		"submitSocket",
		"adminSocket",
		"principals",
		"trustedLocalNative",
		"native",
		"workspaces"
	], ["recoverStaleLock", "socketMode"]);
	absolute$1(c.stateRoot);
	absolute$1(c.submitSocket);
	absolute$1(c.adminSocket);
	requireThat(path.dirname(c.submitSocket) !== path.dirname(c.adminSocket));
	requireThat(typeof c.trustedLocalNative === "boolean");
	requireThat(c.recoverStaleLock === void 0 || typeof c.recoverStaleLock === "boolean");
	requireThat(c.socketMode === void 0 || [384, 432].includes(c.socketMode));
	requireThat(Array.isArray(c.principals) && c.principals.length > 0 && c.principals.length <= 100);
	const ids = /* @__PURE__ */ new Set();
	const hashes = /* @__PURE__ */ new Set();
	for (const p of c.principals) {
		const principal = record(p);
		keys(principal, [
			"id",
			"role",
			"tokenHash"
		]);
		identifier(principal.id);
		requireThat(["admin", "submitter"].includes(principal.role) && typeof principal.tokenHash === "string" && /^[0-9a-f]{64}$/.test(principal.tokenHash));
		requireThat(!ids.has(principal.id) && !hashes.has(principal.tokenHash));
		ids.add(principal.id);
		hashes.add(principal.tokenHash);
	}
	const workspaces = record(c.workspaces);
	requireThat(Object.keys(workspaces).length <= 100);
	if (c.native !== null) {
		requireThat(c.trustedLocalNative === true, 403);
		const n = record(c.native);
		keys(n, [
			"piExecutable",
			"workspaceRoots",
			"stateRoot",
			"agentRoot"
		], [
			"provider",
			"startupTimeoutMs",
			"rpcTimeoutMs",
			"generationTimeoutMs",
			"stopTimeoutMs",
			"maxFrameBytes",
			"maxStderrBytes"
		]);
		absolute$1(n.piExecutable);
		absolute$1(n.stateRoot);
		absolute$1(n.agentRoot);
		for (const [id, root] of Object.entries(record(n.workspaceRoots))) {
			identifier(id);
			absolute$1(root);
		}
		if (n.provider !== void 0) {
			const p = record(n.provider);
			keys(p, [
				"extensionPath",
				"name",
				"model"
			]);
			absolute$1(p.extensionPath);
		}
	}
	for (const [id, value] of Object.entries(workspaces)) {
		identifier(id);
		const w = record(value);
		keys(w, [
			"label",
			"root",
			"path"
		]);
		identifier(w.root);
		requireThat(typeof w.label === "string" && w.label.length > 0 && w.label.length <= 100 && !/[\x00-\x1f]/.test(w.label));
		requireThat(typeof w.path === "string" && w.path.length <= 512 && !path.isAbsolute(w.path) && !w.path.includes("\\") && !w.path.includes("\0") && !w.path.split("/").includes(".."));
		requireThat(c.native !== null && Object.hasOwn(c.native.workspaceRoots, w.root));
	}
	return c;
}
/** Provisioning owns OS users/groups/mounts; checking a mode is NOT proof of isolation. */
async function privateDirectory(directory, allowGroupSearch = false) {
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const s = await lstat(directory);
	requireThat(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & (allowGroupSearch ? 23 : 63)) === 0 && await realpath(directory) === directory, 403);
}
async function readPrivateJson(file) {
	const handle = await open(absolute$1(file), constants.O_RDONLY | constants.O_NOFOLLOW);
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
	requireThat(auth && auth.startsWith("Bearer "), 401);
	return token(auth.slice(7));
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
	waiting_idle: new Set(["running", "cancelled"]),
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
function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
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
	return canonicalJson(requestValue(task)) === canonicalJson(requestValue(request));
}
function initialState() {
	return {
		schemaVersion: 1,
		tasks: {},
		idempotency: {}
	};
}
async function syncDirectory(directory) {
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
		await syncDirectory(directory);
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
		await syncDirectory(root);
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
	await syncDirectory(path.dirname(lock.directory));
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
//#region manager/executor/engine.ts
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
	#tail = Promise.resolve();
	#closing = false;
	#closePromise;
	constructor(config, store, adapter) {
		this.#config = structuredClone(config);
		this.#store = store;
		this.#adapter = adapter;
		this.#adapterPolicy = canonical({
			policy: adapter?.policy ?? null,
			actions: adapter?.actions ?? []
		});
		this.#policyHash = digest(canonical({
			workspaces: config.workspaces,
			principals: config.principals.map((p) => ({
				id: p.id,
				role: p.role
			})),
			adapter: this.#adapterPolicy
		}));
	}
	static async open(config, adapter) {
		const store = await TaskStore.open(config.stateRoot, { recoverStaleLock: config.recoverStaleLock });
		const engine = new TaskEngine(config, store, adapter);
		try {
			for (const task of await store.list()) if (task.state === "running") await store.transition(task.id, "running", "unknown", { expectedRevision: task.revision });
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
		const m = record(message);
		const admin = transport === "admin";
		if ([
			"review",
			"approve",
			"execute"
		].includes(m.op)) requireThat(admin, 403);
		const copy = structuredClone(m);
		const pending = this.#tail.then(() => this.#handle(principal, admin, copy));
		this.#tail = pending.catch(() => {});
		try {
			return await pending;
		} catch (e) {
			if (e instanceof TaskStoreConflictError) throw new ManagerError(409);
			throw e;
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
	async #handle(p, admin, m) {
		if (m.op === "capabilities") {
			keys(m, ["op"]);
			return {
				native: !!this.#adapter,
				isolation: this.#adapter ? "trusted-local-development" : "unavailable",
				enrollment: false,
				docker: false,
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
		if (m.op === "resources") {
			keys(m, ["op"]);
			return this.#adapter?.resources(p.id) ?? [];
		}
		if (m.op === "list") {
			keys(m, ["op"]);
			return (await this.#store.list()).filter((t) => !!t && (admin || t.requester === p.id)).map(view);
		}
		if (m.op === "submit") {
			keys(m, ["op", "request"]);
			const r = record(m.request);
			requireThat(r.action === "create" || r.action === "stop", 503);
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
			const request = {
				key: identifier(r.key),
				requester: p.id,
				target: identifier(r.target),
				action: r.action,
				payload: r.action === "create" ? { workspace: identifier(r.workspace) } : {}
			};
			if (r.action === "create") requireThat(Object.hasOwn(this.#config.workspaces, r.workspace));
			requireThat(this.#adapter?.actions.includes(r.action), 503);
			if (!(await this.#store.list()).find((t) => t.requester === p.id && t.key === r.key)) await this.#adapter.validate(request);
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
			requireThat(this.#adapter?.actions.includes(t.action), 503);
			await this.#adapter.validate(t);
			this.#assertPolicy();
			const running = await this.#store.transition(t.id, "queued", "running", { expectedRevision: t.revision });
			this.#approvals.delete(t.id);
			const operation = this.#execute(running);
			this.#running.add(operation);
			operation.finally(() => this.#running.delete(operation));
			return view(running);
		}
		throw new ManagerError(400);
	}
	async #execute(task) {
		try {
			const result = await this.#adapter.execute(task);
			await this.#store.transition(task.id, "running", "succeeded", {
				expectedRevision: task.revision,
				result
			});
		} catch {
			await this.#store.transition(task.id, "running", "failed", {
				expectedRevision: task.revision,
				result: { status: "execution-failed" }
			}).catch(() => {});
		}
	}
	close() {
		this.#closing = true;
		return this.#closePromise ??= (async () => {
			await this.#tail;
			await Promise.all(this.#running);
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
//#region manager/backends/native.ts
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
function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function instanceId(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid instance ID");
}
function absolute(value) {
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
		const roots = Object.fromEntries(Object.entries(config.workspaceRoots).map(([key, value]) => [key, absolute(value)]));
		if (!Object.keys(roots).length) throw new Error("At least one allowed workspace root is required");
		this.#config = Object.freeze({
			...config,
			piExecutable: absolute(config.piExecutable),
			stateRoot: absolute(config.stateRoot),
			agentRoot: absolute(config.agentRoot),
			workspaceRoots: Object.freeze(roots),
			provider: config.provider ? Object.freeze({
				...config.provider,
				extensionPath: absolute(config.provider.extensionPath)
			}) : void 0
		});
		if (config.provider && [config.provider.name, config.provider.model].some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value))) throw new Error("Invalid administrator provider selection");
		this.#startupMs = limit(config.startupTimeoutMs, 1e4, 12e4);
		this.#rpcMs = limit(config.rpcTimeoutMs, 5e3, 12e4);
		this.#generationMs = limit(config.generationTimeoutMs, 3e4, 6e5);
		this.#stopMs = limit(config.stopTimeoutMs, 1e3, 3e4);
		this.#frameBytes = limit(config.maxFrameBytes, 1024 * 1024, 4 * 1024 * 1024);
		this.#stderrBytes = limit(config.maxStderrBytes, 16 * 1024, 1024 * 1024);
	}
	async create(request, options = {}) {
		if (!object(request) || Object.keys(request).some((key) => !["instanceId", "workspace"].includes(key))) throw new Error("Invalid create request");
		instanceId(request.instanceId);
		if (this.#starting.has(request.instanceId) || this.#owned.has(request.instanceId)) throw new Error("Instance already owned or starting");
		if (!object(request.workspace) || Object.keys(request.workspace).some((key) => !["root", "path"].includes(key))) throw new Error("Invalid workspace request");
		const copy = {
			instanceId: request.instanceId,
			workspace: { ...request.workspace }
		};
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		const promise = this.#launch(copy, signal);
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
	async generate(id, message) {
		instanceId(id);
		const entry = this.#owned.get(id);
		if (!entry || entry.exited || entry.status !== "ready" || entry.error) throw new Error("Instance is not ready and owned");
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
			const disposition = object(response.data) ? response.data.disposition : void 0;
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
	async #launch(request, signal) {
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
		const stateDir = await mkdtemp(path.join(stateRoot, `${request.instanceId}-`));
		const agentDir = await mkdtemp(path.join(agentRoot, `${request.instanceId}-`));
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
		]) await mkdir(subdir(name), { mode: 448 });
		const args = [
			"--mode",
			"rpc",
			"--no-session",
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
		signal.throwIfAborted();
		const child = spawn(executable, args, {
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
				PI_TELEMETRY: "0"
			}
		});
		const processIdentity = child.pid ? readProcessIdentity(child.pid) : null;
		const identity = Object.freeze({
			instanceId: request.instanceId,
			pid: child.pid ?? 0,
			processIdentity: processIdentity ?? "",
			workspace,
			stateDir,
			agentDir
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
			pending: /* @__PURE__ */ new Map()
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
			await writeFile(subdir("identity.json"), JSON.stringify({
				schemaVersion: 1,
				...identity
			}) + "\n", {
				flag: "wx",
				mode: 384
			});
			const response = await this.#request(entry, "get_state", {}, this.#startupMs);
			if (!object(response.data) || typeof response.data.isStreaming !== "boolean" || typeof response.data.isCompacting !== "boolean") throw new Error("Invalid readiness state");
			if (entry.error) throw entry.error;
			signal.throwIfAborted();
			entry.status = "ready";
			return identity;
		} catch (error) {
			if ((await this.#stop(entry)).status === "ownership-lost") throw new Error("Startup failed; child ownership or exit unconfirmed, further signals refused");
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
				if (!object(record) || typeof record.type !== "string") throw new Error();
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
		if (record.type === "message_end" && object(record.message) && record.message.role === "assistant") {
			generation.lastMessageFailed = record.message.stopReason === "error";
			if (generation.lastMessageFailed) return;
			if (Array.isArray(record.message.content)) {
				for (const part of record.message.content) if (object(part) && part.type === "text" && typeof part.text === "string") {
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
		if (entry.status === "ready" && !entry.stop) this.#stop(entry);
	}
	#finish(entry) {
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
	actions = ["create", "stop"];
	policy;
	#backend;
	#config;
	#owners = /* @__PURE__ */ new Map();
	constructor(config) {
		requireThat(config.trustedLocalNative && config.native, 503);
		this.#config = structuredClone(config);
		this.#backend = new NativeBackend(this.#config.native);
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
		requireThat(request.action === "create", 503);
		const selection = record(request.payload).workspace;
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
	}
	async execute(task) {
		await this.validate(task);
		if (task.action === "create") {
			const w = this.#config.workspaces[record(task.payload).workspace];
			const identity = await this.#backend.create({
				instanceId: task.target,
				workspace: {
					root: w.root,
					path: w.path
				}
			});
			this.#owners.set(identity.instanceId, task.requester);
			return {
				status: "created",
				instanceId: identity.instanceId
			};
		}
		const result = await this.#backend.stop(task.target);
		requireThat(result.status !== "ownership-lost", 503);
		this.#owners.delete(task.target);
		return {
			status: result.status,
			instanceId: task.target
		};
	}
	resources(requester) {
		return this.#backend.list().filter((i) => this.#owners.get(i.instanceId) === requester).map((i) => ({ instanceId: i.instanceId }));
	}
	async close() {
		requireThat((await Promise.allSettled(this.#backend.list().map((i) => this.#backend.stop(i.instanceId)))).every((r) => r.status === "fulfilled" && r.value.status !== "ownership-lost"), 503);
	}
};
//#endregion
//#region manager/executor/main.ts
async function startExecutor(value) {
	const config = executorConfig(value);
	await privateDirectory(config.stateRoot);
	for (const socket of [config.submitSocket, config.adminSocket]) {
		requireThat(Buffer.byteLength(socket) <= 100);
		await privateDirectory(path.dirname(socket), config.socketMode === 432);
		let exists = true;
		try {
			await lstat(socket);
		} catch (e) {
			if (e.code === "ENOENT") exists = false;
			else throw e;
		}
		requireThat(!exists, 409);
	}
	const engine = await TaskEngine.open(config, config.native ? new NativeTaskAdapter(config) : void 0);
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
await runProcess(async () => startExecutor(await readPrivateJson(configArgument(process.argv.slice(2)))));
//#endregion
export {};
