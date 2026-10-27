#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
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
var digest = (value) => createHash("sha256").update(value).digest("hex");
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
	], [
		"docker",
		"recoverStaleLock",
		"socketMode"
	]);
	absolute(c.stateRoot);
	absolute(c.submitSocket);
	absolute(c.adminSocket);
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
	requireThat(c.native === null || c.docker == null);
	if (c.docker != null) {
		const d = record(c.docker);
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
			"entrypoint",
			"command",
			"web"
		]);
		const dockerPath = (v) => {
			const p = absolute(v);
			requireThat(p !== path.parse(p).root);
			return p;
		};
		const overlaps = (a, b) => {
			const contains = (root, value) => {
				const r = path.relative(root, value);
				return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
			};
			return contains(a, b) || contains(b, a);
		};
		dockerPath(d.socketPath);
		dockerPath(d.stateRoot);
		requireThat(d.pathCoordinates === "host" && typeof d.daemonId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(d.daemonId));
		requireThat(typeof d.image === "string" && /^sha256:[a-f0-9]{64}$/.test(d.image));
		requireThat(d.timeoutMs === void 0 || Number.isSafeInteger(d.timeoutMs) && d.timeoutMs >= 1 && d.timeoutMs <= 12e4);
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
			const w = record(d.web);
			keys(w, [
				"packageRoot",
				"hubConfigFile",
				"port"
			], ["provider"]);
			protectedPaths.push(dockerPath(w.packageRoot), dockerPath(w.hubConfigFile));
			requireThat(Number.isInteger(w.port) && w.port >= 1 && w.port <= 65535 && d.command === void 0 && d.entrypoint === void 0);
			if (w.provider !== void 0) {
				const p = record(w.provider);
				keys(p, [
					"packageRoot",
					"name",
					"model"
				]);
				protectedPaths.push(dockerPath(p.packageRoot));
				requireThat([p.name, p.model].every((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(v)));
			}
		}
		requireThat(!overlaps(c.stateRoot, d.stateRoot));
		const roots = record(d.workspaceRoots);
		requireThat(Object.keys(roots).length > 0 && Object.keys(roots).length <= 32);
		for (const [name, value] of Object.entries(roots)) {
			identifier(name);
			const root = dockerPath(value);
			requireThat(!protectedPaths.some((p) => overlaps(root, p)));
		}
	}
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
		absolute(n.piExecutable);
		absolute(n.stateRoot);
		absolute(n.agentRoot);
		for (const [id, root] of Object.entries(record(n.workspaceRoots))) {
			identifier(id);
			absolute(root);
		}
		if (n.provider !== void 0) {
			const p = record(n.provider);
			keys(p, [
				"extensionPath",
				"name",
				"model"
			]);
			absolute(p.extensionPath);
		}
		if (n.web !== void 0) {
			const web = record(n.web);
			keys(web, [
				"extensionPath",
				"hubConfigFile",
				"port"
			]);
			absolute(web.extensionPath);
			absolute(web.hubConfigFile);
			requireThat(Number.isInteger(web.port) && web.port >= 1 && web.port <= 65535);
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
		const backend = c.docker ?? c.native;
		requireThat(backend !== null && Object.hasOwn(backend.workspaceRoots, w.root));
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
//#region manager/initialize.ts
async function initialize(options) {
	const directory = absolute(options.get("--directory"));
	const chatOrigin = origin(options.get("--chat-origin"));
	const native = options.has("--native-executable");
	requireThat(native ? options.get("--trusted-local-native") === "yes" && options.has("--workspace") : !options.has("--trusted-local-native") && !options.has("--workspace"));
	const submitSocket = path.join(directory, "submit", "rpc.sock"), adminSocket = path.join(directory, "admin", "rpc.sock");
	requireThat(Buffer.byteLength(submitSocket) <= 100 && Buffer.byteLength(adminSocket) <= 100);
	const requester = randomBytes(32).toString("hex"), admin = randomBytes(32).toString("hex");
	const executor = executorConfig({
		stateRoot: path.join(directory, "tasks"),
		submitSocket,
		adminSocket,
		principals: [{
			id: "requester",
			role: "submitter",
			tokenHash: digest(requester)
		}, {
			id: "administrator",
			role: "admin",
			tokenHash: digest(admin)
		}],
		trustedLocalNative: native,
		native: native ? {
			piExecutable: absolute(options.get("--native-executable")),
			workspaceRoots: { allowed: absolute(options.get("--workspace")) },
			stateRoot: path.join(directory, "native-state"),
			agentRoot: path.join(directory, "native-agents")
		} : null,
		workspaces: native ? { project: {
			label: "Allowed project",
			root: "allowed",
			path: "."
		} } : {}
	});
	const publicConfig = serviceConfig({
		socketPath: submitSocket,
		origin: options.get("--public-origin") ?? "http://127.0.0.1:18201",
		chatOrigin,
		port: Number(new URL(options.get("--public-origin") ?? "http://127.0.0.1:18201").port || 80)
	});
	const adminConfig = serviceConfig({
		socketPath: adminSocket,
		origin: options.get("--admin-origin") ?? "http://127.0.0.1:18202",
		chatOrigin,
		port: Number(new URL(options.get("--admin-origin") ?? "http://127.0.0.1:18202").port || 80)
	});
	requireThat(publicConfig.origin !== adminConfig.origin);
	await mkdir(directory, { mode: 448 });
	await privateDirectory(directory);
	for (const name of [
		"submit",
		"admin",
		"public-home",
		"admin-home",
		"executor-home"
	]) await privateDirectory(path.join(directory, name));
	const documents = {
		"executor.json": executor,
		"public.json": publicConfig,
		"admin.json": adminConfig,
		"chat.json": {
			port: Number(new URL(chatOrigin).port || (chatOrigin.startsWith("https:") ? 443 : 80)),
			stateDir: path.join(directory, "chat-state"),
			runtimeDir: path.join(directory, "chat-runtime")
		},
		"requester-credential.json": { credential: requester },
		"administrator-credential.json": { credential: admin },
		"supervisor.json": {
			trustedLocalDevelopment: true,
			executorConfig: path.join(directory, "executor.json"),
			publicConfig: path.join(directory, "public.json"),
			adminConfig: path.join(directory, "admin.json"),
			chatConfig: path.join(directory, "chat.json")
		}
	};
	for (const [name, data] of Object.entries(documents)) await writeFile(path.join(directory, name), JSON.stringify(data, null, 2) + "\n", {
		mode: 384,
		flag: "wx"
	});
}
//#endregion
//#region manager/supervisor.ts
async function supervise(value, entryUrl) {
	const config = record(value);
	keys(config, [
		"trustedLocalDevelopment",
		"executorConfig",
		"publicConfig",
		"adminConfig"
	], ["chatConfig"]);
	requireThat(config.trustedLocalDevelopment === true, 403);
	for (const name of [
		"executorConfig",
		"publicConfig",
		"adminConfig"
	]) absolute(config[name]);
	if (config.chatConfig !== void 0) absolute(config.chatConfig);
	const publicConfig = serviceConfig(await readPrivateJson(config.publicConfig));
	const adminConfig = serviceConfig(await readPrivateJson(config.adminConfig));
	requireThat(publicConfig.origin !== adminConfig.origin && publicConfig.chatOrigin === adminConfig.chatOrigin);
	const children = [];
	let stopping = false;
	let shutdown;
	const close = () => shutdown ??= (async () => {
		stopping = true;
		requireThat((await Promise.all(children.map((child) => new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode === 0);
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve(false);
			}, 13e4);
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code === 0);
			});
			child.kill("SIGTERM");
		})))).every(Boolean), 503);
	})();
	const onSignal = () => {
		close().then(() => {
			process.exitCode = 0;
		}, () => {
			process.stderr.write("Manager shutdown incomplete\n");
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	async function launch(role, file) {
		const home = path.join(path.dirname(file), role + "-home");
		await privateDirectory(home);
		const child = spawn(process.execPath, [
			fileURLToPath(new URL(`pi-manager-${role}.mjs`, entryUrl)),
			"--config",
			file
		], {
			stdio: [
				"ignore",
				"ignore",
				"ignore",
				"ipc"
			],
			env: {
				PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
				LANG: "C.UTF-8",
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				PI_MANAGER_CONFIG: path.join(home, "unused.json"),
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				PI_WEB_UI_HUB_CONFIG: path.join(home, "unused-hub.json")
			}
		});
		children.push(child);
		child.on("exit", () => {
			if (!stopping) {
				process.stderr.write("Manager owned service exited\n");
				close().finally(() => {
					process.exitCode = 1;
				}).catch(() => {});
			}
		});
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(Error("Service startup deadline")), 1e4);
			child.once("error", () => {
				clearTimeout(timer);
				reject(Error("Service start failed"));
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(Error("Service exited before ready"));
			});
			child.once("message", (message) => {
				clearTimeout(timer);
				if (message && typeof message === "object" && "ready" in message && message.ready === true) resolve(message);
				else reject(Error("Invalid readiness"));
			});
		});
	}
	try {
		const chat = config.chatConfig ? await launch("chat", config.chatConfig) : void 0;
		await launch("executor", config.executorConfig);
		const pub = await launch("public", config.publicConfig);
		const admin = await launch("admin", config.adminConfig);
		return {
			publicPort: pub.port,
			adminPort: admin.port,
			...chat ? { chatPort: chat.port } : {},
			close
		};
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}
//#endregion
//#region manager/main.ts
async function main(args, entryUrl) {
	if (!args.length || ["help", "--help"].includes(args[0])) {
		process.stdout.write(`Pi Manager independent task service (legacy pi-manager Hub CLI is unchanged)\n
pi-manager-service init --directory /private/new-directory --chat-origin http://127.0.0.1:18200
  [--public-origin http://127.0.0.1:18201] [--admin-origin http://127.0.0.1:18202]
  [--trusted-local-native yes --native-executable /absolute/pi --workspace /allowed/project]
pi-manager-service serve --config /private/new-directory/supervisor.json

Init writes credentials into separate private files, never stdout. No legacy state is read.
Serve is opt-in trusted-local development, NOT isolation from same-UID code. It owns four
service children and does not depend on a Pi/client lifetime. Native is unavailable by default.
For separately provisioned isolation, start pi-manager-public, pi-manager-admin and
pi-manager-executor independently, each with --config /its/private/config.json. Provision
distinct OS/container permissions and submit/admin socket directory access externally.
No configuration assertion proves isolation. No host users/groups/sudo are changed here.
Admin UI login uses administrator-credential.json only on the private administrator origin.
Requester credentials never approve. Queued tasks require fresh approval after restart;
unknown tasks are never replayed. Existing Pi PIDs are never adopted.
MCP is available at the public origin's /mcp endpoint using requester credentials only.
Native Web needs explicit installed-extension and registrar configuration. Updates are unavailable.
`);
		return;
	}
	const command = args[0];
	requireThat(command === "init" || command === "serve");
	const allowed = command === "serve" ? ["--config"] : [
		"--directory",
		"--chat-origin",
		"--public-origin",
		"--admin-origin",
		"--trusted-local-native",
		"--native-executable",
		"--workspace"
	];
	const options = /* @__PURE__ */ new Map();
	for (let i = 1; i < args.length; i += 2) {
		requireThat(allowed.includes(args[i]) && !options.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"));
		options.set(args[i], args[i + 1]);
	}
	if (command === "init") {
		await initialize(options);
		process.stdout.write("{\"initialized\":true,\"scope\":\"trusted-local-development\"}\n");
	} else {
		requireThat(options.has("--config"));
		const supervisor = await supervise(await readPrivateJson(options.get("--config")), entryUrl);
		process.stdout.write(JSON.stringify({
			ready: true,
			publicPort: supervisor.publicPort,
			adminPort: supervisor.adminPort,
			...supervisor.chatPort ? { chatPort: supervisor.chatPort } : {},
			scope: "trusted-local-development"
		}) + "\n");
	}
}
//#endregion
//#region bin/pi-manager-service.mjs
await main(process.argv.slice(2), import.meta.url).catch(() => {
	process.stderr.write("Manager command failed; use --help and check private configuration\n");
	process.exitCode = 1;
});
//#endregion
export {};
