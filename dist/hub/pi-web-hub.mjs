#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import net, { isIP } from "node:net";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream";
import { constants as constants$1, createBrotliCompress, createGzip } from "node:zlib";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region protocol/connection-config.ts
var connection_config_exports = /* @__PURE__ */ __exportAll({
	localWebUrl: () => localWebUrl,
	resolveConnectionConfig: () => resolveConnectionConfig,
	validatedPublicUrl: () => validatedPublicUrl
});
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
function resolveConnectionConfig(settings = {}, env = process.env) {
	const portValue = env.PI_WEB_UI_PORT ?? settings.port ?? 3001;
	if (!/^\d+$/.test(String(portValue))) throw new Error("Invalid Pi Web port");
	const port = Number(portValue);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Pi Web port");
	const host = env.PI_WEB_UI_HOST ?? settings.host ?? "127.0.0.1";
	if (typeof host !== "string" || !isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw new Error("Invalid Pi Web host");
	const disabled = env.PI_WEB_UI_DISABLED;
	if (disabled !== void 0 && ![
		"0",
		"1",
		"true",
		"false"
	].includes(disabled)) throw new Error("Invalid Pi Web disabled option");
	const warnings = [];
	let publicUrl;
	const suppliedUrl = env.PI_WEB_UI_PUBLIC_URL ?? settings.publicUrl;
	if (suppliedUrl !== void 0) try {
		publicUrl = validatedPublicUrl(suppliedUrl);
	} catch {
		warnings.push("Pi Web public URL ignored: use HTTPS without credentials, query or fragment");
	}
	const socketPath = env.PI_WEB_UI_REGISTRY_SOCKET ?? settings.registration?.socketPath;
	const credentialFile = env.PI_WEB_UI_REGISTRY_CREDENTIAL_FILE ?? settings.registration?.credentialFile;
	let registration;
	if (socketPath !== void 0 || credentialFile !== void 0) if (typeof socketPath === "string" && socketPath.trim() && !socketPath.includes("\0") && typeof credentialFile === "string" && credentialFile.trim() && !credentialFile.includes("\0")) registration = {
		socketPath,
		credentialFile
	};
	else warnings.push("Pi Web registration disabled: configure both socketPath and credentialFile");
	return {
		host,
		port,
		publicUrl,
		registration,
		warnings,
		autoStart: disabled === void 0 ? settings.disabled !== true : disabled !== "1" && disabled !== "true"
	};
}
function localWebUrl(host, port) {
	const browserHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
	return `http://${isIP(browserHost) === 6 ? `[${browserHost}]` : browserHost}:${port}/`;
}
var init_connection_config = __esmMin((() => {}));
//#endregion
//#region protocol/hub-generation.ts
var BOUNDED_PROTOCOL, BOUNDED_GENERATION_SOURCE, HUB_GENERATION_SOURCE, bounded, generation, sessionPath, isBoundedGeneration, isHubGeneration, isHubSessionPath;
var init_hub_generation = __esmMin((() => {
	BOUNDED_PROTOCOL = "bounded-v2";
	BOUNDED_GENERATION_SOURCE = "b2-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}";
	HUB_GENERATION_SOURCE = `(?:[a-f0-9]{32}|${BOUNDED_GENERATION_SOURCE})`;
	bounded = new RegExp(`^${BOUNDED_GENERATION_SOURCE}$`);
	generation = new RegExp(`^${HUB_GENERATION_SOURCE}$`);
	sessionPath = new RegExp(`^/s/${HUB_GENERATION_SOURCE}/$`);
	isBoundedGeneration = (value) => typeof value === "string" && bounded.test(value);
	isHubGeneration = (value) => typeof value === "string" && generation.test(value);
	isHubSessionPath = (value) => typeof value === "string" && sessionPath.test(value);
}));
//#endregion
//#region protocol/interactions/protocol.ts
function invalidInteraction() {
	throw new Error("Invalid interaction");
}
function plainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, required, optional = []) {
	if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalidInteraction();
}
function safeLabel(value, max = 256) {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}
function opaqueId(value, length = 32) {
	return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}
function validateIdentity(value) {
	if (!plainRecord(value)) invalidInteraction();
	exactKeys(value, [
		"runId",
		"generation",
		"runtimeId",
		"sessionId"
	]);
	if (!opaqueId(value.runId) || !isHubGeneration(value.generation) || !safeLabel(value.runtimeId) || !safeLabel(value.sessionId)) invalidInteraction();
}
function readInteractionRegistration(value) {
	if (value === void 0) return void 0;
	canonicalJson(value);
	if (!plainRecord(value)) invalidInteraction();
	exactKeys(value, [
		"protocol",
		"runtimeId",
		"sessionId"
	]);
	if (value.protocol !== "pi-web-interactions-v1" || !safeLabel(value.runtimeId) || !safeLabel(value.sessionId)) invalidInteraction();
	return {
		protocol: INTERACTION_PROTOCOL,
		runtimeId: value.runtimeId,
		sessionId: value.sessionId
	};
}
function validateAdapter(value) {
	if (!plainRecord(value)) invalidInteraction();
	exactKeys(value, [
		"id",
		"version",
		"packageName"
	]);
	if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || !safeLabel(value.version, 64) || !safeLabel(value.packageName, 128)) invalidInteraction();
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
function validateSchema(value) {
	if (!plainRecord(value)) invalidInteraction();
	if (value.kind === "confirm") exactKeys(value, ["kind"]);
	else if (value.kind === "select") {
		exactKeys(value, ["kind", "options"]);
		if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 100 || value.options.some((option) => !safeLabel(option, 512)) || new Set(value.options).size !== value.options.length) invalidInteraction();
	} else if (value.kind === "text") {
		exactKeys(value, ["kind", "maxBytes"]);
		if (!Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > 32 * 1024) invalidInteraction();
	} else invalidInteraction();
}
function validateAnswer(schema, answer) {
	validateSchema(schema);
	if (schema.kind === "confirm" && typeof answer === "boolean") return answer;
	if (schema.kind === "select" && typeof answer === "string" && schema.options.includes(answer)) return answer;
	if (schema.kind === "text" && typeof answer === "string" && Buffer.byteLength(answer) <= schema.maxBytes) return answer;
	return invalidInteraction();
}
function validateSpec(spec, createdAt) {
	if (!safeLabel(spec.action, 64) || !/^[a-z][a-z0-9_.-]*$/.test(spec.action) || !safeLabel(spec.revision, 256) || !["session", "sensitive"].includes(spec.classification) || ![
		"confirm",
		"select",
		"input",
		"editor"
	].includes(spec.method)) invalidInteraction();
	validateSchema(spec.schema);
	if (spec.method === "confirm" !== (spec.schema.kind === "confirm") || spec.method === "select" !== (spec.schema.kind === "select")) invalidInteraction();
	if (!plainRecord(spec.content) || !Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(spec.deadline) || spec.deadline <= createdAt || spec.purpose !== void 0 && spec.purpose !== "oauth") invalidInteraction();
	if (spec.deadline - createdAt > (spec.purpose === "oauth" ? INTERACTION_LIMITS.oauthMs : INTERACTION_LIMITS.confirmationMs)) invalidInteraction();
}
function validateInteractionRequest(value) {
	const serialized = canonicalJson(value);
	if (!plainRecord(value)) invalidInteraction();
	exactKeys(value, [
		"protocol",
		"schemaVersion",
		"requestId",
		"operationId",
		"identity",
		"adapter",
		"createdAt",
		"digest",
		"action",
		"revision",
		"classification",
		"method",
		"schema",
		"content",
		"deadline"
	], ["purpose"]);
	if (value.protocol !== "pi-web-interactions-v1" || value.schemaVersion !== 1 || !opaqueId(value.requestId) || !opaqueId(value.operationId) || !opaqueId(value.digest, 64)) invalidInteraction();
	validateIdentity(value.identity);
	validateAdapter(value.adapter);
	validateSpec(value, value.createdAt);
	const { digest, ...body } = value;
	if (contentDigest(body) !== digest) invalidInteraction();
	return JSON.parse(serialized);
}
var INTERACTION_PROTOCOL, INTERACTION_LIMITS, contentDigest;
var init_protocol = __esmMin((() => {
	init_hub_generation();
	INTERACTION_PROTOCOL = "pi-web-interactions-v1";
	INTERACTION_LIMITS = Object.freeze({
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
	contentDigest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
}));
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
var init_enrollment = __esmMin((() => {
	init_protocol();
}));
//#endregion
//#region protocol/interactions/proof.ts
function signInteractionEvidence(privateKey, claim) {
	const serialized = canonicalJson(claim);
	return {
		claim: JSON.parse(serialized),
		signature: sign(null, Buffer.from(serialized), privateKey).toString("base64url")
	};
}
var init_proof = __esmMin((() => {
	init_protocol();
}));
//#endregion
//#region hub/state-budget.ts
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
var STATE_LIMIT, SECURITY_RESERVE, SCAN_ENTRIES, StateBudgetError, StateWriter, storageDiagnostics;
var init_state_budget = __esmMin((() => {
	STATE_LIMIT = 8 * 1024 * 1024;
	SECURITY_RESERVE = 64 * 1024;
	SCAN_ENTRIES = 32768;
	StateBudgetError = class extends Error {
		constructor() {
			super("Hub state quota exceeded");
		}
	};
	StateWriter = class {
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
	storageDiagnostics = (config) => withStateWriter(config, (writer) => writer.diagnostics());
}));
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
var init_interaction_signing = __esmMin((() => {
	init_enrollment();
	init_proof();
	init_protocol();
	init_state_budget();
}));
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
var hex$6, text$2, GateLifecycle;
var init_lifecycle = __esmMin((() => {
	init_config();
	hex$6 = (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
	text$2 = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
	GateLifecycle = class {
		config;
		constructor(config) {
			this.config = lifecycleConfig(config);
		}
		async request(method, route, value) {
			const credential = readPrivateJson(this.config.credentialFile);
			if (!credential || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new Error("Lifecycle provider unavailable");
			const body = value ? JSON.stringify(value) : void 0;
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (result) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					request.destroy();
					if (result) resolve(result);
					else reject(/* @__PURE__ */ new Error("Lifecycle provider rejected or unavailable"));
				};
				const request = http.request(new URL(route, this.config.endpoint), {
					method,
					agent: false,
					headers: {
						Authorization: `Bearer ${credential.token}`,
						"Content-Type": "application/json",
						...body ? { "Content-Length": Buffer.byteLength(body) } : {}
					}
				}, (response) => {
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						finish();
						return;
					}
					let raw = Buffer.alloc(0);
					response.on("data", (chunk) => {
						raw = Buffer.concat([raw, chunk]);
						if (raw.length > 16384) finish();
					});
					response.on("error", () => finish());
					response.on("end", () => {
						try {
							const result = JSON.parse(raw.toString("utf8"));
							if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
							finish(result);
						} catch {
							finish();
						}
					});
				});
				const timer = setTimeout(() => finish(), 5e3);
				request.on("error", () => finish());
				request.end(body);
			});
		}
		async target(runId) {
			if (!hex$6(runId)) throw new Error("Invalid lifecycle identity");
			const value = await this.request("GET", `/v1/pi-lifecycle/runs/${runId}`);
			if (value.managed === false) return {
				managed: false,
				...value.reason === "source_evidence_unavailable" ? { reason: "source_evidence_unavailable" } : {}
			};
			if (value.managed !== true || value.run_id !== runId || !text$2(value.runtime_id) || !text$2(value.session_id) || value.leaf_id !== null && !text$2(value.leaf_id) || !text$2(value.version) || typeof value.idle !== "boolean" || typeof value.pending !== "boolean" || typeof value.busy !== "boolean" || ![
				"auto",
				"manual",
				"disabled"
			].includes(value.mode)) throw new Error("Invalid lifecycle target");
			return {
				managed: true,
				run_id: runId,
				runtime_id: value.runtime_id,
				session_id: value.session_id,
				leaf_id: value.leaf_id,
				version: value.version,
				idle: value.idle,
				pending: value.pending,
				busy: value.busy,
				mode: value.mode
			};
		}
		job(value) {
			if (!hex$6(value.id) || !hex$6(value.run_id) || typeof value.status !== "string" || ![
				"pending",
				"queued",
				"running",
				"succeeded",
				"failed",
				"recovery_required",
				"rejected",
				"stale"
			].includes(value.status) || typeof value.stage !== "string" || !/^[a-z_]{1,64}$/.test(value.stage)) throw new Error("Invalid lifecycle result");
			const result = {
				id: value.id,
				run_id: value.run_id,
				status: value.status,
				stage: value.stage
			};
			if (value.started_at !== void 0) {
				if (!Number.isSafeInteger(value.started_at) || Number(value.started_at) <= 0 || Number(value.started_at) > Date.now() + 5e3) throw new Error("Invalid lifecycle start time");
				result.started_at = Number(value.started_at);
			} else if (value.status === "running" || value.status === "succeeded") throw new Error("Missing lifecycle start time");
			for (const key of [
				"runtime_id",
				"session_id",
				"old_runtime_id",
				"new_runtime_id",
				"old_version",
				"expected_version",
				"new_version"
			]) if (value[key] !== void 0) {
				if (!text$2(value[key])) throw new Error("Invalid lifecycle result");
				result[key] = value[key];
			}
			if (value.leaf_id !== void 0) {
				if (value.leaf_id !== null && !text$2(value.leaf_id)) throw new Error("Invalid lifecycle result");
				result.leaf_id = value.leaf_id;
			}
			return result;
		}
		async restart(value) {
			if (Object.keys(value).sort().join(",") !== "idempotency_key,leaf_id,run_id,runtime_id,session_id" || !hex$6(value.run_id) || !hex$6(value.idempotency_key) || !text$2(value.runtime_id) || !text$2(value.session_id) || value.leaf_id !== null && !text$2(value.leaf_id)) throw new Error("Invalid lifecycle request");
			const result = this.job(await this.request("POST", "/v1/pi-lifecycle/restarts", value));
			if (result.run_id !== value.run_id) throw new Error("Lifecycle target changed");
			return result;
		}
		async operation(id) {
			if (!hex$6(id)) throw new Error("Invalid lifecycle identity");
			const job = this.job(await this.request("GET", `/v1/pi-lifecycle/restarts/${id}`));
			if (job.id !== id) throw new Error("Lifecycle operation changed");
			return job;
		}
	};
}));
//#endregion
//#region hub/config.ts
var config_exports = /* @__PURE__ */ __exportAll({
	initializeHub: () => initializeHub,
	issueSession: () => issueSession,
	managementConfig: () => managementConfig,
	managerLinksConfig: () => managerLinksConfig,
	privateDirectory: () => privateDirectory,
	provisionGrant: () => provisionGrant,
	readGrant: () => readGrant,
	readHubConfig: () => readHubConfig,
	readPrivateJson: () => readPrivateJson,
	revokeSession: () => revokeSession
});
function privateDirectory(directory) {
	privateStateDirectory(directory);
}
function readPrivateJson(file) {
	return readStateJson(file);
}
function initializeHub(file, options = {}) {
	mkdirSync(path.dirname(path.resolve(file)), {
		recursive: true,
		mode: 448
	});
	writeFileSync(file, `${JSON.stringify({
		port: 16180,
		...options
	}, null, 2)}\n`, {
		flag: "wx",
		mode: 384
	});
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
var validProvisionKey;
var init_config = __esmMin((() => {
	init_connection_config();
	init_interaction_signing();
	init_lifecycle();
	init_state_budget();
	validProvisionKey = (key) => typeof key === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key);
}));
//#endregion
//#region hub/gateway-auth.ts
init_config();
/** Gateway proof is server-to-server only; never accept a browser identity header by itself. */
function gatewayIdentity(config, request) {
	const gateway = config.management?.gateway;
	if (!gateway) return void 0;
	try {
		const value = readPrivateJson(gateway.credentialFile);
		const proof = request.headers["x-pi-hub-gateway"];
		const user = request.headers["x-pi-hub-user"];
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "token" || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) || typeof user !== "string" || !/^[\p{L}\p{N}_.@+-]{1,128}$/u.test(user) || !timingSafeEqual(Buffer.from(proof), Buffer.from(value.token))) return void 0;
		return createHash("sha256").update(`${proof}\0${user}`).digest("hex");
	} catch {
		return;
	}
}
//#endregion
//#region hub/management.ts
init_config();
init_state_budget();
var digest = (value) => createHash("sha256").update(value).digest("hex");
var hex$5 = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var equal$1 = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
var stateFile = (config) => path.join(config.stateDir, "management.json");
function readState(config) {
	const file = stateFile(config);
	if (!existsSync(file)) return void 0;
	const value = readPrivateJson(file);
	if (!hex$5(value.epoch, 64) || value.pairHash !== null && !hex$5(value.pairHash, 64) || !Number.isSafeInteger(value.expires) || !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 10) throw new Error("Management state unavailable");
	return value;
}
function saveState(writer, value, security = false) {
	writer.write("management.json", value, { security });
}
/** Trusted CLI only: return a short-lived code to its administrator's terminal. */
function issueManagementCode(config, now = Date.now()) {
	if (config.management?.gateway) throw new Error("Management uses the configured gateway login, not pairing codes");
	return withStateWriter(config, (writer) => {
		const code = randomBytes(16).toString("hex");
		const epoch = readState(config)?.epoch ?? randomBytes(32).toString("hex");
		const expires = now + 6e5;
		saveState(writer, {
			epoch,
			pairHash: digest(code),
			expires,
			failures: 0
		});
		return {
			code,
			expiresAt: expires
		};
	});
}
function revokeManagement(config) {
	withStateWriter(config, (writer) => saveState(writer, {
		epoch: randomBytes(32).toString("hex"),
		pairHash: null,
		expires: 0,
		failures: 0
	}, true));
}
/** Additional management privilege, deliberately separate from gateway/list access. */
var HubManagement = class {
	sessions = /* @__PURE__ */ new Map();
	config;
	now;
	secure;
	cookieName;
	constructor(config, now = Date.now) {
		this.config = config;
		this.now = now;
		this.secure = config.management?.publicUrl?.startsWith("https:") ?? false;
		this.cookieName = this.secure ? "__Host-pi-hub-management" : "pi_hub_management_local";
	}
	session(request) {
		const values = (request.headers.cookie ?? "").split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${this.cookieName}=`));
		if (values.length !== 1) return void 0;
		const token = values[0].slice(this.cookieName.length + 1);
		if (!hex$5(token, 64)) return void 0;
		const key = digest(token);
		const session = this.sessions.get(key);
		let state;
		try {
			state = readState(this.config);
		} catch {
			return;
		}
		if (!session || session.expires <= this.now() || !state || session.epoch !== state.epoch || this.config.management?.gateway && session.gateway !== gatewayIdentity(this.config, request)) {
			this.sessions.delete(key);
			return;
		}
		return {
			key,
			...session
		};
	}
	status(request) {
		const session = this.session(request);
		return session ? {
			authorized: true,
			csrf: session.csrf,
			expiresAt: session.expires
		} : { authorized: false };
	}
	authorize(request, write = false) {
		const session = this.session(request);
		const csrf = request.headers["x-pi-hub-csrf"];
		if (!session || write && (typeof csrf !== "string" || !hex$5(csrf, 64) || !equal$1(csrf, session.csrf))) throw new Error("Management authorization required");
		return session;
	}
	revalidate(request, expected, write = false) {
		const current = this.authorize(request, write);
		if (current.key !== expected.key || current.epoch !== expected.epoch || current.csrf !== expected.csrf || current.expires !== expected.expires) throw new Error("Management authorization changed");
	}
	unlock(code) {
		if (this.config.management?.gateway) throw new Error("Gateway login required");
		return withStateWriter(this.config, (writer) => {
			const state = readState(this.config);
			if (!state || !state.pairHash || state.expires <= this.now() || state.failures >= 10) throw new Error("Management unlock rejected");
			if (!hex$5(code, 32) || !equal$1(digest(code), state.pairHash)) {
				saveState(writer, {
					...state,
					failures: state.failures + 1
				}, true);
				throw new Error("Management unlock rejected");
			}
			saveState(writer, {
				...state,
				pairHash: null,
				expires: 0
			}, true);
			return this.createSession(state);
		});
	}
	unlockGateway(request) {
		const identity = gatewayIdentity(this.config, request);
		if (!identity) throw new Error("Verified gateway login required");
		return withStateWriter(this.config, (writer) => {
			let state = readState(this.config);
			if (!state) {
				state = {
					epoch: randomBytes(32).toString("hex"),
					pairHash: null,
					expires: 0,
					failures: 0
				};
				saveState(writer, state);
			}
			return this.createSession(state, identity);
		});
	}
	createSession(state, gateway) {
		for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
		if (this.sessions.size >= 64) throw new Error("Management unlock rejected");
		const token = randomBytes(32).toString("hex");
		const csrf = randomBytes(32).toString("hex");
		const expires = this.now() + 18e5;
		this.sessions.set(digest(token), {
			epoch: state.epoch,
			expires,
			csrf,
			...gateway ? { gateway } : {}
		});
		return {
			csrf,
			expiresAt: expires,
			cookie: this.cookie(token, 1800)
		};
	}
	logout(request) {
		const session = this.authorize(request, true);
		this.sessions.delete(session.key);
		return this.cookie("", 0);
	}
	cookie(token, maxAge) {
		return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
	}
};
//#endregion
//#region protocol/runtime-metadata.ts
/** Display/identity metadata, never proof that a container is authorized for control. */
function readRuntimeMetadata(value) {
	if (value === void 0) return void 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime metadata");
	const v = value;
	const valid = (item) => typeof item === "string" && item.length > 0 && item.length <= 256 && !/\p{Cc}/u.test(item);
	if (Object.keys(v).sort().join(",") !== "leafId,managed,runtimeId,sessionId,version" || v.managed !== true || !valid(v.runtimeId) || !valid(v.sessionId) || v.leafId !== null && !valid(v.leafId) || !valid(v.version)) throw new Error("Invalid runtime metadata");
	return {
		runtimeId: v.runtimeId,
		sessionId: v.sessionId,
		leafId: v.leafId,
		version: v.version,
		managed: true
	};
}
//#endregion
//#region protocol/software-metadata.ts
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
var SHA256$1 = /^[a-f0-9]{64}$/;
function validSemver(value, stableOnly) {
	if (typeof value !== "string" || value.length > 64) return false;
	const match = (stableOnly ? STABLE_SEMVER : SEMVER).exec(value);
	if (!match) return false;
	if ([
		match[1],
		match[2],
		match[3]
	].some((part) => !Number.isSafeInteger(Number(part)))) return false;
	return !match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}
function isStableSemver(value) {
	return validSemver(value, true);
}
function isDisplayVersion(value) {
	return validSemver(value, false);
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
/** Validate only bounded display metadata; this is never an authorization identity. */
function readSoftwareMetadata(value) {
	if (value === void 0) return void 0;
	if (!isRecord$1(value) || !hasExactKeys(value, value.webUi === void 0 ? ["piVersion"] : ["piVersion", "webUi"]) || !isDisplayVersion(value.piVersion)) throw new Error("Invalid software metadata");
	const webUi = value.webUi;
	if (webUi === void 0) return Object.freeze({ piVersion: value.piVersion });
	if (!isRecord$1(webUi) || !hasExactKeys(webUi, webUi.build === void 0 ? ["version"] : ["version", "build"])) throw new Error("Invalid software metadata");
	if (!isStableSemver(webUi.version) || webUi.build !== void 0 && (typeof webUi.build !== "string" || !SHA256$1.test(webUi.build))) throw new Error("Invalid software metadata");
	return Object.freeze({
		piVersion: value.piVersion,
		webUi: Object.freeze({
			version: webUi.version,
			...webUi.build === void 0 ? {} : { build: webUi.build }
		})
	});
}
//#endregion
//#region hub/limits.ts
var HUB_LIMITS = Object.freeze({
	browserPairs: 8,
	connections: 128,
	registrationPeers: 64,
	registrationOperations: 32,
	backendProbes: 4,
	websocketCompression: 2,
	httpCompression: 2,
	inFlightBytes: 16 * 1024 * 1024,
	waitingBytes: 512 * 1024,
	waitingMessages: 512
});
//#endregion
//#region hub/asset-transfer.ts
var activeCompressors = 0;
function encoding(accept) {
	if (!accept) return;
	const qualities = /* @__PURE__ */ new Map();
	for (const part of accept.split(",")) {
		const [name, ...parameters] = part.trim().toLowerCase().split(";");
		const weight = parameters.find((value) => value.trim().startsWith("q="));
		const quality = weight === void 0 ? 1 : Number(weight.trim().slice(2));
		qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
	}
	const quality = (name) => qualities.get(name) ?? qualities.get("*") ?? 0;
	if (quality("br") > 0 && quality("br") >= quality("gzip")) return "br";
	if (quality("gzip") > 0) return "gzip";
}
/** Compress only public build assets, never reflected session/API/download data. */
function proxySessionResponse(request, response, upstream, resource) {
	const headers = { ...upstream.headers };
	delete headers["set-cookie"];
	delete headers.connection;
	for (const key of Object.keys(headers)) if (key.startsWith("x-pi-hub-")) delete headers[key];
	headers["cache-control"] = "no-store";
	const asset = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.exec(resource);
	const mime = upstream.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
	const staticAsset = asset && (request.method === "GET" || request.method === "HEAD") && upstream.statusCode === 200 && !request.headers.range && !upstream.headers["cache-control"] && !upstream.headers["content-range"] && !upstream.headers["content-disposition"] && !upstream.headers["content-encoding"] && !upstream.headers["set-cookie"] && (asset[1] === "css" ? mime === "text/css" : mime === "application/javascript" || mime === "text/javascript");
	let coding;
	if (staticAsset) {
		headers["cache-control"] = "private, max-age=86400, immutable";
		const vary = (headers.vary ?? "").split(",").map((value) => value.trim()).filter(Boolean);
		if (!vary.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
		headers.vary = vary.join(", ");
		coding = encoding(request.headers["accept-encoding"]);
		if (request.method !== "HEAD" && activeCompressors >= HUB_LIMITS.httpCompression) coding = void 0;
		if (coding) {
			headers["content-encoding"] = coding;
			for (const name of [
				"content-length",
				"etag",
				"content-md5",
				"digest"
			]) delete headers[name];
		}
	}
	upstream.once("error", () => response.destroy());
	response.writeHead(upstream.statusCode ?? 502, headers);
	if (request.method === "HEAD") {
		upstream.resume();
		response.end();
	} else if (coding) {
		activeCompressors++;
		pipeline(upstream, coding === "br" ? createBrotliCompress({ params: { [constants$1.BROTLI_PARAM_QUALITY]: 4 } }) : createGzip({ level: 6 }), response, (error) => {
			activeCompressors--;
			if (error) response.destroy();
		});
	} else upstream.pipe(response);
}
//#endregion
//#region hub/bounded-registry.ts
init_hub_generation();
init_config();
var ZERO = "0000000000000000";
var hex$4 = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var RegistryError = class extends Error {
	code;
	constructor(code = "ENDED_GENERATION") {
		super(code === "ENDED_GENERATION" ? "ended generation" : "Registration rejected");
		this.code = code;
	}
};
var relative = (runId) => {
	if (!hex$4(runId, 32)) throw new RegistryError("AUTH_FAILED");
	return `bounded/${runId}.json`;
};
var hasBoundedRecord = (config, runId) => existsSync(path.join(config.stateDir, relative(runId)));
function boundedRecord(config, runId, boot) {
	const file = path.join(config.stateDir, relative(runId));
	if (!existsSync(file)) return {
		schema: 2,
		run_id: runId,
		boot,
		slot: ZERO,
		revision: 0
	};
	const value = readPrivateJson(file);
	if (value.schema !== 2 || value.run_id !== runId || !hex$4(value.boot, 32) || !hex$4(value.slot, 16) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new RegistryError("STATE_UNAVAILABLE");
	for (const tuple of [value.current, value.pending]) {
		if (tuple === void 0) continue;
		if (!isBoundedGeneration(tuple.generation) || !tuple.generation.startsWith(`b2-${value.boot}-`) || tuple.generation.split("-")[2] > value.slot || !hex$4(tuple.request_id, 32) || !Number.isInteger(tuple.port) || tuple.port < 1 || tuple.port > 65535 || !Number.isSafeInteger(tuple.expires)) throw new RegistryError("STATE_UNAVAILABLE");
	}
	return value.boot === boot ? value : {
		schema: 2,
		run_id: runId,
		boot,
		slot: ZERO,
		revision: 0
	};
}
function saveBounded(writer, record, security = false) {
	if (!Number.isSafeInteger(record.revision + 1)) throw new RegistryError("STATE_UNAVAILABLE");
	record.revision++;
	writer.write(relative(record.run_id), record, { security });
}
function issueBounded(writer, record, value, live) {
	if (value.boot !== record.boot || !hex$4(value.slot, 16) || !hex$4(value.request_id, 32) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new RegistryError("ISSUANCE_STALE");
	const now = Date.now();
	const result = (tuple) => ({
		generation: tuple.generation,
		boot: record.boot,
		slot: tuple.generation.split("-")[2],
		expires: tuple.expires
	});
	const pending = record.pending;
	if (pending?.request_id === value.request_id && pending.port === value.port && pending.expires > now && BigInt(`0x${value.slot}`) + 1n === BigInt(`0x${record.slot}`)) return result(pending);
	if (value.slot !== record.slot) throw new RegistryError("ISSUANCE_STALE");
	if (pending && pending.expires > now) throw new RegistryError("REGISTRY_BUSY");
	if (record.slot === "ffffffffffffffff") throw new RegistryError("STATE_UNAVAILABLE");
	record.slot = (BigInt(`0x${record.slot}`) + 1n).toString(16).padStart(16, "0");
	record.pending = {
		generation: `b2-${record.boot}-${record.slot}-${randomBytes(16).toString("hex")}`,
		port: Number(value.port),
		request_id: value.request_id,
		expires: now + 5e3
	};
	if (record.current && !live(record.current.generation)) delete record.current;
	saveBounded(writer, record);
	return result(record.pending);
}
function boundedTuple(record, generation, port, live) {
	if (record.pending?.generation === generation && record.pending.port === port && record.pending.expires > Date.now()) return "pending";
	if (record.current?.generation === generation && record.current.port === port && live) return "current";
	throw new RegistryError();
}
//#endregion
//#region hub/forward-queue.ts
var size = (data) => typeof data === "string" ? Buffer.byteLength(data) : Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
/** One accounted send, plus a bounded unsent FIFO. No pending-send promises. */
var ForwardQueue = class {
	waiting = [];
	waitingBytes = 0;
	inFlight;
	closed = false;
	poll;
	deadline;
	socket;
	onSlow;
	constructor(socket, onSlow = () => {}) {
		this.socket = socket;
		this.onSlow = onSlow;
		socket.once("close", () => this.dispose());
		socket.once("error", () => this.dispose());
	}
	enqueue(data, binary = false) {
		if (this.closed || this.socket.readyState !== 1) return false;
		const bytes = size(data);
		if (bytes > HUB_LIMITS.inFlightBytes) return this.slow();
		if (!this.inFlight && !this.waiting.length && this.socket.bufferedAmount === 0) {
			this.send({
				data,
				binary,
				bytes
			});
			return !this.closed;
		}
		if (this.waitingBytes + bytes > HUB_LIMITS.waitingBytes || this.waiting.length >= HUB_LIMITS.waitingMessages) return this.slow();
		this.waitingBytes += bytes;
		this.waiting.push({
			data,
			binary,
			bytes
		});
		this.watch();
		return true;
	}
	snapshot() {
		return {
			inFlightBytes: this.inFlight?.bytes ?? 0,
			waitingBytes: this.waitingBytes,
			waitingMessages: this.waiting.length
		};
	}
	send(frame) {
		const flight = {
			bytes: frame.bytes,
			complete: false
		};
		this.inFlight = flight;
		this.watch();
		try {
			this.socket.send(frame.data, { binary: frame.binary }, (error) => {
				if (this.closed || this.inFlight !== flight) return;
				if (error) {
					this.slow();
					return;
				}
				flight.complete = true;
				this.drain();
			});
		} catch {
			this.slow();
		}
	}
	watch() {
		if (!this.poll) {
			this.poll = setInterval(() => this.drain(), 10);
			this.poll.unref();
		}
		if (!this.deadline) {
			this.deadline = setTimeout(() => this.slow(), 5e3);
			this.deadline.unref();
		}
	}
	drain() {
		if (this.closed || this.socket.bufferedAmount !== 0 || this.inFlight && !this.inFlight.complete) return;
		this.inFlight = void 0;
		clearTimeout(this.deadline);
		this.deadline = void 0;
		const frame = this.waiting.shift();
		if (frame) {
			this.waitingBytes -= frame.bytes;
			this.send(frame);
		} else {
			clearInterval(this.poll);
			this.poll = void 0;
		}
	}
	slow() {
		if (!this.closed) {
			this.dispose();
			this.socket.close(1013, "Slow consumer; reconnect");
			this.onSlow();
			const timer = setTimeout(() => this.socket.terminate(), 250);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
		}
		return false;
	}
	dispose() {
		this.closed = true;
		this.waiting = [];
		this.waitingBytes = 0;
		this.inFlight = void 0;
		clearInterval(this.poll);
		clearTimeout(this.deadline);
		this.poll = void 0;
		this.deadline = void 0;
	}
};
//#endregion
//#region hub/pi-launches.ts
var hex$3 = (v, n) => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
var object$2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var text$1 = (v, limit) => typeof v === "string" && v.length > 0 && v.length <= limit && !/[\p{Cc}\p{Cs}]/u.test(v);
var workspacePath = (v) => typeof v === "string" && v.length <= 1024 && !/[\\\p{Cc}\p{Cs}]/u.test(v) && (v === "" || v.split("/").every((part) => !!part && part !== "." && part !== ".."));
var basename = (v) => text$1(v, 255) && v !== "." && v !== ".." && !/[\\/]/u.test(v);
function workspaceQuery(query) {
	if ([...query.keys()].some((key) => !["path", "cursor"].includes(key)) || query.getAll("path").length > 1 || query.getAll("cursor").length > 1) throw new Error("Invalid workspace query");
	const path = query.get("path") ?? "";
	const cursor = query.get("cursor");
	if (!workspacePath(path) || cursor !== null && !basename(cursor)) throw new Error("Invalid workspace path");
	const safe = new URLSearchParams({ path });
	if (cursor !== null) safe.set("cursor", cursor);
	return `?${safe}`;
}
function launchRequest(value) {
	if (Object.keys(value).sort().join(",") !== "id,label,path,policy_revision,workspace_revision" || !hex$3(value.id, 32) || !hex$3(value.policy_revision, 64) || !hex$3(value.workspace_revision, 64) || !workspacePath(value.path) || !text$1(value.label, 80) || value.label.trim() !== value.label) throw new Error("Invalid exact launch request");
}
function job$1(value) {
	if (!object$2(value) || !hex$3(value.id, 32) || !workspacePath(value.path) || !text$1(value.label, 80) || ![
		"queued",
		"starting",
		"running",
		"exited",
		"failed",
		"recovery_required"
	].includes(String(value.status)) || typeof value.stage !== "string" || !/^[a-z][a-z0-9_]{0,95}$/.test(value.stage) || !Number.isSafeInteger(value.created_at) || Number(value.created_at) < 0 || !Number.isSafeInteger(value.updated_at) || Number(value.updated_at) < 0 || value.run_id !== void 0 && !hex$3(value.run_id, 32)) throw new Error("Invalid launch response");
	return {
		id: value.id,
		path: value.path,
		label: value.label,
		status: String(value.status),
		stage: value.stage,
		created_at: Number(value.created_at),
		updated_at: Number(value.updated_at),
		...value.run_id === void 0 ? {} : { run_id: value.run_id }
	};
}
function compareNames(a, b) {
	const left = Array.from(a, (char) => char.codePointAt(0));
	const right = Array.from(b, (char) => char.codePointAt(0));
	for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
	return left.length - right.length;
}
function launchResponse(suffix, value, method = "GET") {
	if (suffix === "/launch-config") {
		if (!object$2(value) || typeof value.enabled !== "boolean" || !text$1(value.rootLabel, 80) || !workspacePath(value.defaultPath) || !hex$3(value.revision, 64) || !Number.isSafeInteger(value.maxActive) || Number(value.maxActive) < 1 || Number(value.maxActive) > 16) throw new Error("Invalid launch configuration");
		return {
			enabled: value.enabled,
			rootLabel: value.rootLabel,
			defaultPath: value.defaultPath,
			revision: value.revision,
			maxActive: value.maxActive
		};
	}
	if (suffix.startsWith("/workspaces?")) {
		const query = new URLSearchParams(suffix.split("?")[1]);
		const selected = query.get("path") ?? "";
		const cursor = query.get("cursor");
		const expectedParent = selected === "" ? null : selected.split("/").slice(0, -1).join("/");
		if (!object$2(value) || value.path !== selected || value.parent !== expectedParent || !hex$3(value.revision, 64) || !Array.isArray(value.entries) || value.entries.length > 200 || typeof value.truncated !== "boolean" || value.nextCursor !== void 0 && !basename(value.nextCursor)) throw new Error("Invalid workspace listing");
		const entries = value.entries.map((entry) => {
			if (!object$2(entry) || !basename(entry.name) || entry.path !== `${selected ? `${selected}/` : ""}${entry.name}`) throw new Error("Invalid directory child");
			return {
				name: entry.name,
				path: entry.path
			};
		});
		if (entries.some((entry, index) => cursor !== null && compareNames(entry.name, cursor) <= 0 || index > 0 && compareNames(entry.name, entries[index - 1].name) <= 0) || value.truncated && (!entries.length || value.nextCursor !== entries.at(-1)?.name) || !value.truncated && value.nextCursor !== void 0) throw new Error("Invalid directory pagination");
		return {
			path: selected,
			parent: expectedParent,
			revision: value.revision,
			entries,
			truncated: value.truncated,
			...value.nextCursor === void 0 ? {} : { nextCursor: value.nextCursor }
		};
	}
	if (suffix === "/launches" && method === "GET") {
		if (!object$2(value) || !Array.isArray(value.jobs)) throw new Error("Invalid launch list");
		if (value.jobs.length > 256) throw new Error("Too many launch records");
		const jobs = value.jobs.map(job$1);
		if (new Set(jobs.map((row) => row.id)).size !== jobs.length) throw new Error("Duplicate launch record");
		return { jobs };
	}
	const result = job$1(value);
	if (suffix.startsWith("/launches/") && suffix !== `/launches/${result.id}`) throw new Error("Wrong launch identity");
	return result;
}
function attachLaunchSessions(value, resolve) {
	if (!object$2(value)) return value;
	if (Array.isArray(value.jobs)) return { jobs: value.jobs.map((row) => attachLaunchSessions(row, resolve)) };
	if (!hex$3(value.run_id, 32) || value.status !== "running") return value;
	const sessionUrl = resolve(value.run_id);
	return {
		...value,
		...sessionUrl ? { sessionUrl } : {}
	};
}
//#endregion
//#region hub/gate-management.ts
init_config();
init_lifecycle();
var kinds = [
	"deployment",
	"runtime",
	"restart",
	"intent"
];
var policyKinds = [
	"service",
	"runtime",
	"restart"
];
var actions = [
	"approve",
	"reject",
	"rollback"
];
var modes = [
	"manual",
	"auto",
	"disabled"
];
var hex$2 = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var object$1 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var label = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
var service = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
var exact = (value, fields) => Object.keys(value).sort().join(",") === [...fields].sort().join(",");
var GateManagementError = class extends Error {
	status;
	constructor(status = 503) {
		super("Gate management unavailable or outcome unknown");
		this.status = status;
	}
};
function details(value, depth = 0) {
	if (depth > 4) throw new GateManagementError();
	if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= 2e3 && !/[\p{Cc}\p{Cs}]/u.test(value)) return value;
	if (Array.isArray(value) && value.length <= 128) return value.map((item) => details(item, depth + 1));
	if (object$1(value) && Object.keys(value).length <= 64) {
		const safe = Object.create(null);
		for (const [key, item] of Object.entries(value)) {
			if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || /token|password|secret|authorization|credential|environment|mount|template|private/i.test(key)) throw new GateManagementError();
			safe[key] = details(item, depth + 1);
		}
		return safe;
	}
	throw new GateManagementError();
}
function task(value) {
	if (!object$1(value) || !kinds.includes(String(value.kind)) || !hex$2(value.id, 32) || !hex$2(value.revision, 64) || !label(value.status, 64) || !label(value.stage, 128) || !label(value.title) || !label(value.target) || !Array.isArray(value.actions) || value.actions.length > 3 || value.actions.some((v) => !actions.includes(String(v)))) throw new GateManagementError();
	const result = {
		kind: String(value.kind),
		id: value.id,
		revision: value.revision,
		status: value.status,
		stage: value.stage,
		title: value.title,
		target: value.target,
		actions: value.actions
	};
	for (const key of [
		"version",
		"commit",
		"image",
		"plan_hash"
	]) if (value[key] !== void 0) {
		if (!label(value[key], key === "image" ? 512 : 256)) throw new GateManagementError();
		result[key] = value[key];
	}
	if (value.created_at !== void 0) {
		if (!Number.isSafeInteger(value.created_at) || Number(value.created_at) < 0) throw new GateManagementError();
		result.created_at = Number(value.created_at);
	}
	if (value.details !== void 0) {
		if (!object$1(value.details) || JSON.stringify(value.details).length > 16384) throw new GateManagementError();
		result.details = details(value.details);
	}
	return result;
}
function policy(value) {
	if (!object$1(value) || !policyKinds.includes(String(value.kind)) || !service(value.id) || !hex$2(value.revision, 64) || !modes.includes(String(value.mode))) throw new GateManagementError();
	const result = {
		kind: String(value.kind),
		id: value.id,
		revision: value.revision,
		mode: String(value.mode)
	};
	if (value.paused !== void 0) {
		if (typeof value.paused !== "boolean") throw new GateManagementError();
		result.paused = value.paused;
	}
	if (value.images !== void 0) {
		if (!Array.isArray(value.images) || value.images.length > 64 || value.images.some((v) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v))) throw new GateManagementError();
		result.images = value.images;
	}
	return result;
}
function receipt(value) {
	if (!object$1(value) || !hex$2(value.decision_id, 32) || !["recorded", "delivery_unknown"].includes(String(value.status))) throw new GateManagementError();
	return {
		decision_id: value.decision_id,
		status: value.status,
		...value.task !== void 0 ? { task: task(value.task) } : {},
		...value.policy !== void 0 ? { policy: policy(value.policy) } : {}
	};
}
/** The only forwarding capability is the fixed restricted management protocol. */
var GateManagementProvider = class {
	config;
	constructor(config) {
		this.config = lifecycleConfig(config);
	}
	async request(method, suffix, value) {
		let credential;
		try {
			credential = readPrivateJson(this.config.credentialFile);
		} catch {
			throw new GateManagementError();
		}
		if (!object$1(credential) || !exact(credential, ["token"]) || !hex$2(credential.token, 64)) throw new GateManagementError();
		const payload = value === void 0 ? void 0 : JSON.stringify(value);
		const data = await new Promise((resolve, reject) => {
			let done = false;
			const finish = (error, result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				request.destroy();
				if (error) reject(error);
				else resolve(result);
			};
			const request = http.request(new URL(`/v1/hub-management${suffix}`, this.config.endpoint), {
				method,
				agent: false,
				headers: {
					Authorization: `Bearer ${credential.token}`,
					"Content-Type": "application/json",
					...payload ? { "Content-Length": Buffer.byteLength(payload) } : {}
				}
			}, (response) => {
				const code = response.statusCode ?? 503;
				if (code < 200 || code >= 300) {
					finish(new GateManagementError([
						400,
						404,
						409
					].includes(code) ? code : 503));
					return;
				}
				const chunks = [];
				let size = 0;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > 1024 * 1024) {
						finish(new GateManagementError());
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (done) return;
					try {
						finish(void 0, JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						finish(new GateManagementError());
					}
				});
				response.on("error", () => finish(new GateManagementError()));
				response.on("aborted", () => finish(new GateManagementError()));
			});
			const timer = setTimeout(() => finish(new GateManagementError()), 5e3);
			request.on("error", () => finish(new GateManagementError()));
			request.end(payload);
		});
		if (suffix === "/launch-config" || suffix.startsWith("/workspaces?") || suffix === "/launches" || suffix.startsWith("/launches/")) try {
			const safe = launchResponse(suffix, data, method);
			if (value && safe.id !== value.id) throw new Error();
			return safe;
		} catch {
			throw new GateManagementError();
		}
		if (suffix === "") {
			if (!object$1(data) || !Array.isArray(data.tasks) || data.tasks.length > 512 || !Array.isArray(data.policies) || data.policies.length > 128) throw new GateManagementError();
			return {
				tasks: data.tasks.map(task),
				policies: data.policies.map(policy)
			};
		}
		if (suffix.startsWith("/tasks/")) {
			const safe = task(data);
			if (suffix !== `/tasks/${safe.kind}/${safe.id}`) throw new GateManagementError();
			return safe;
		}
		const safe = receipt(data);
		const expected = value?.decision_id ?? suffix.split("/").at(-1);
		if (safe.decision_id !== expected) throw new GateManagementError();
		return safe;
	}
};
async function body$1(request) {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json" || request.headers["transfer-encoding"]) throw new Error("Invalid JSON body");
	const raw = await new Promise((resolve, reject) => {
		const parts = [];
		let size = 0;
		let done = false;
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			request.off("data", data);
			request.off("end", end);
			request.off("error", failed);
			request.off("aborted", failed);
			if (error) {
				request.resume();
				reject(error);
			} else resolve(Buffer.concat(parts));
		};
		const data = (part) => {
			size += part.length;
			if (size > 4096) finish(/* @__PURE__ */ new Error());
			else parts.push(part);
		};
		const end = () => finish();
		const failed = () => finish(/* @__PURE__ */ new Error());
		const timer = setTimeout(failed, 5e3);
		request.on("data", data);
		request.once("end", end);
		request.once("error", failed);
		request.once("aborted", failed);
	});
	const value = JSON.parse(raw.toString("utf8"));
	if (!object$1(value)) throw new Error();
	return value;
}
function createGateManagementApi(config, management, resolveSession = () => void 0) {
	const provider = config.gateManagement ? new GateManagementProvider(config.gateManagement) : void 0;
	const prefix = "/api/management/gate";
	return { async handle(request, response, sameOrigin) {
		const url = new URL(request.url ?? "/", "http://hub.invalid");
		if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
		const reply = (status, value) => response.writeHead(status, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
		}).end(JSON.stringify(value));
		let suffix = url.pathname.slice(20);
		const launchRead = suffix === "/launch-config" || suffix === "/workspaces" || suffix === "/launches" || /^\/launches\/[a-f0-9]{32}$/.test(suffix);
		const read = launchRead || suffix === "" || /^\/tasks\/(deployment|runtime|restart|intent)\/[a-f0-9]{32}$/.test(suffix) || /^\/decisions\/[a-f0-9]{32}$/.test(suffix);
		const write = [
			"/decisions",
			"/policies",
			"/resume",
			"/launches"
		].includes(suffix);
		if (url.search && suffix !== "/workspaces" || !read && !write) {
			reply(404, { error: "Management route not found" });
			return true;
		}
		if ((request.method !== "GET" || !read) && (request.method !== "POST" || !write)) {
			reply(405, { error: "Method not allowed" });
			return true;
		}
		if (request.method === "POST" && !sameOrigin) {
			reply(403, { error: "Same-origin management request required" });
			return true;
		}
		let phase = "authorization";
		try {
			const auth = management.authorize(request, request.method === "POST");
			const revalidate = () => {
				phase = "authorization";
				management.revalidate(request, auth, request.method === "POST");
				phase = "provider";
			};
			if (!provider) {
				reply(503, { error: "Hub approvals are not configured" });
				return true;
			}
			if (suffix === "/workspaces") {
				phase = "body";
				suffix += workspaceQuery(url.searchParams);
			}
			let value;
			if (request.method === "POST") {
				phase = "body";
				value = await body$1(request);
				revalidate();
				phase = "body";
				if (suffix === "/launches") launchRequest(value);
				else {
					if (!hex$2(value.decision_id, 32) || !hex$2(value.revision, 64)) throw new Error();
					if (suffix === "/decisions") {
						if (!exact(value, [
							"kind",
							"id",
							"revision",
							"action",
							"decision_id"
						]) || !kinds.includes(String(value.kind)) || !hex$2(value.id, 32) || !actions.includes(String(value.action))) throw new Error();
					} else if (suffix === "/policies") {
						if (!exact(value, [
							"kind",
							"id",
							"revision",
							"mode",
							"decision_id"
						]) || !policyKinds.includes(String(value.kind)) || !service(value.id) || !modes.includes(String(value.mode))) throw new Error();
					} else if (!exact(value, [
						"id",
						"revision",
						"decision_id"
					]) || !service(value.id)) throw new Error();
				}
			}
			revalidate();
			let result;
			try {
				result = await provider.request(request.method, suffix, value);
			} catch (error) {
				revalidate();
				throw error;
			}
			revalidate();
			reply(200, launchRead ? attachLaunchSessions(result, resolveSession) : result);
		} catch (error) {
			const status = phase === "authorization" ? 401 : phase === "body" ? 400 : error instanceof GateManagementError ? error.status : 503;
			reply(status, { error: status === 401 ? "Management login expired" : status === 400 ? "Exact bounded management request required" : status === 409 ? "Task or policy changed; review current state" : status === 404 ? "Original task or receipt not found" : "Gate unavailable or outcome unknown; query the original decision before retrying" });
		}
		return true;
	} };
}
//#endregion
//#region hub/interaction-page.ts
init_hub_generation();
/** Static trusted shell. Serve only on the management listener, never through Pi. */
function renderInteractionPageHtml() {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Pi · 可信交互审核</title>
<link rel="stylesheet" href="/interaction-page.css"><script src="/interaction-page.js" defer><\/script></head>
<body><main><header><span class="brand">π · Pi Web</span><span class="badge">可信管理页面</span></header>
<h1>审核原始操作</h1><p>请核对来源、范围和全部预览后明确决定。登录不等于批准；授权送达也不代表操作已经执行成功。</p>
<p id="review-status" role="status" aria-live="polite">正在读取管理状态…</p>
<p id="review-outcome" role="status" aria-live="polite"></p>
<section aria-labelledby="management-title"><h2 id="management-title">管理身份</h2>
<p id="management-help">复用现有管理登录，不创建新密码。</p>
<button id="management-gateway" type="button" hidden disabled>使用网页登录解锁</button>
<form id="management-unlock" hidden autocomplete="off"><label for="management-code">既有一次性管理码</label>
<input id="management-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" required disabled>
<button id="management-submit" type="submit" disabled>解锁管理</button></form></section>
<p id="review-notice" role="status" aria-live="polite"></p>
<section aria-labelledby="preview-title"><h2 id="preview-title">完整操作预览</h2>
<pre id="review-preview" tabindex="0"></pre>
<h3>完整请求（含来源、范围、期限和绑定摘要）</h3><pre id="review-request" tabindex="0"></pre>
<h3>允许的回答格式</h3><pre id="review-schema" tabindex="0"></pre></section>
<section id="review-oauth" hidden aria-labelledby="oauth-title"><h2 id="oauth-title">提供方登录</h2>
<p>请检查下面的真实 HTTPS 地址。只有点击按钮才会打开提供方；本页不会代替你同意提供方授权。若手机流程不受支持，请使用原终端流程。</p>
<p id="review-oauth-url" class="identity"></p><button id="review-oauth-open" type="button" disabled>打开提供方登录 ↗</button></section>
<section aria-labelledby="decision-title"><h2 id="decision-title">你的决定</h2>
<div id="review-confirm" class="actions" hidden><button id="review-reject" type="button" disabled>拒绝此操作</button><button id="review-allow" type="button" disabled>允许此操作</button></div>
<form id="review-answer-form" hidden autocomplete="off"><label id="review-answer-label" for="review-text">回答</label>
<select id="review-options" aria-label="明确选择一个源操作选项" hidden disabled></select>
<textarea id="review-text" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" hidden disabled></textarea>
<button id="review-answer-submit" type="submit" disabled>提交此回答</button></form>
<p id="review-decision" class="identity"></p><div class="actions"><button id="review-refresh" type="button" disabled>查询当前状态（不重新提交）</button>
<button id="review-cancel" type="button">结束本页审核（不提交）</button></div></section>
<footer>内容与输入仅保留在本页内存中。网络结果不明时只查询原请求，不创建新决定；请先核对源操作，勿通过重开页面重复批准。</footer>
</main></body></html>`;
}
/** No backend text enters markup, navigation, storage, logs, or an opener. */
var interactionPageJs = String.raw`(() => {
  'use strict';
  const get = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const route = new RegExp('^/interactions/(${HUB_GENERATION_SOURCE})/([a-f0-9]{32})/$').exec(window.location.pathname);
  const labels = {
    pending: '等待你的明确决定；尚未授权。', delivering: '正在核对并送达决定，尚无执行结果。',
    allowed: '授权已送达；不代表源操作执行成功，请查看源操作的独立结果。',
    rejected: '决定已拒绝；本页不声称源操作已执行。', cancelled: '请求已取消；不能从本页继续授权。',
    expired: '请求已过期；不能再批准。', stale: '请求或身份已变化，旧审核已失效；请回到源操作检查。',
    delivery_unknown: '决定送达结果不明；仅查询原请求，不会重新提交。请核对源操作后再发起新操作。',
  };
  const terminal = (value) => ['allowed', 'rejected', 'cancelled', 'expired', 'stale'].includes(value);
  const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const label = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
  const exact = (value, required, optional = []) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const stable = (value) => JSON.stringify(value, function(_key, item) {
    if (!record(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
  const fail = (status = 0) => Object.assign(new Error('Review unavailable'), { status });
  let auth = { authorized: false };
  let request, fingerprint, oauthUrl, decision;
  let state = 'loading', deadline = 0, working = false, closed = false, epoch = 0, fatal = false, readOnly = false;
  let pollTimer, expiryTimer;
  const api = route ? '/api/management/interactions/' + route[1] + '/' + route[2] : '';
  const notice = (text) => { get('review-notice').textContent = text; };
  function clearTimers() { clearTimeout(pollTimer); clearTimeout(expiryTimer); pollTimer = expiryTimer = undefined; }
  function clearPrivate() {
    request = undefined; oauthUrl = undefined;
    for (const id of ['review-preview', 'review-request', 'review-schema', 'review-oauth-url', 'review-outcome']) get(id).textContent = '';
    get('review-options').replaceChildren(); get('review-options').value = '';
    get('review-text').value = ''; get('management-code').value = '';
  }
  function eligible() {
    return !closed && !fatal && !readOnly && !working && !decision && auth.authorized && state === 'pending' && request && deadline > Date.now();
  }
  function paint() {
    const enabled = !!eligible();
    for (const id of ['review-allow', 'review-reject', 'review-options', 'review-text', 'review-answer-submit']) get(id).disabled = !enabled;
    get('review-oauth-open').disabled = !enabled || !oauthUrl;
    get('review-refresh').disabled = working;
    get('review-cancel').disabled = working || closed;
    const locked = !auth.authorized && !closed && !fatal;
    get('management-gateway').hidden = !locked || auth.authMode !== 'gateway';
    get('management-unlock').hidden = !locked || auth.authMode === 'gateway';
    for (const id of ['management-gateway', 'management-code', 'management-submit']) get(id).disabled = !locked || working;
    get('management-help').textContent = auth.authorized ? '管理已解锁；登录没有批准此操作。' :
      auth.authMode === 'gateway' ? '请使用已验证的网页登录身份解锁；若登录已失效，请重新登录管理入口。' : '复用既有一次性管理码；请向管理员获取，不创建新密码。';
    get('review-confirm').hidden = request?.schema.kind !== 'confirm';
    get('review-answer-form').hidden = !request || request.schema.kind === 'confirm';
    get('review-options').hidden = request?.schema.kind !== 'select';
    get('review-text').hidden = request?.schema.kind !== 'text';
    get('review-oauth').hidden = request?.purpose !== 'oauth';
    get('review-status').textContent = labels[state] || (state === 'closed' ? '本页审核已结束；未提交新决定。原操作是否仍待处理，请在源端核对。' :
      state === 'locked' ? '管理未解锁；尚未读取或批准操作。' : '正在读取管理状态…');
    get('review-decision').textContent = decision ? '原决定编号：' + decision.id + '（本页不会另建或重发决定）' : '';
  }
  function settle(next) {
    state = next;
    if (terminal(next)) { readOnly = true; clearTimers(); clearPrivate(); }
    paint();
  }
  function receipt(value) {
    if (!exact(value, ['state'], ['outcome']) || !Object.hasOwn(labels, value.state) ||
        (value.outcome !== undefined && (value.state !== 'allowed' || !['succeeded', 'failed', 'cancelled'].includes(value.outcome)))) throw fail();
    // Hub has already discarded sensitive bodies. A completion is a read-only
    // observation of this fixed request, never another actionable preview.
    readOnly = true;
    clearPrivate();
    settle(value.state);
    const outcomes = { succeeded: '源操作报告：已执行成功。', failed: '源操作报告：执行失败。', cancelled: '源操作报告：执行已取消。' };
    get('review-outcome').textContent = value.outcome ? outcomes[value.outcome] : value.state === 'allowed' ? '源操作尚未报告执行结果。' : '';
  }
  function schedule() {
    clearTimers();
    if (closed || fatal || terminal(state) || !auth.authorized || !deadline) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      clearPrivate(); state = decision ? 'delivery_unknown' : 'expired'; paint(); return;
    }
    expiryTimer = setTimeout(() => {
      clearTimers(); clearPrivate(); state = decision ? 'delivery_unknown' : 'expired'; paint();
    }, remaining);
    if (!document.hidden && !working) pollTimer = setTimeout(() => { void refresh(); }, Math.min(2000, remaining));
  }
  async function call(path, body) {
    const before = epoch;
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', mode: 'same-origin', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(7000),
      headers: { 'Content-Type': 'application/json', ...(auth.authorized ? { 'X-Pi-Hub-Csrf': auth.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (closed || before !== epoch) { await response.body?.cancel(); throw fail(); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) { auth = { ...auth, authorized: false }; clearPrivate(); }
      throw fail(response.status);
    }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') { await response.body?.cancel(); throw fail(); }
    // Do not turn a truncated preview into an actionable review.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536 || closed || before !== epoch) throw fail();
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (closed || before !== epoch) throw fail();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  async function checkAuth() {
    const value = await call('/api/management/status');
    if (!record(value) || typeof value.authorized !== 'boolean') throw fail();
    auth = { authorized: value.authorized, authMode: value.authMode === 'gateway' ? 'gateway' : 'code' };
    if (value.authorized) {
      if (!hex(value.csrf, 64) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) { auth.authorized = false; clearPrivate(); throw fail(401); }
      auth.csrf = value.csrf;
    } else { clearPrivate(); if (!decision) state = 'locked'; }
    return auth.authorized;
  }
  function checked(value) {
    const keys = ['protocol', 'schemaVersion', 'requestId', 'operationId', 'identity', 'adapter', 'createdAt', 'digest', 'action', 'revision', 'classification', 'method', 'schema', 'content', 'deadline'];
    if (!exact(value, keys, ['purpose', 'state']) || value.protocol !== 'pi-web-interactions-v1' || value.schemaVersion !== 1 ||
        value.requestId !== route[2] || !hex(value.operationId, 32) || !hex(value.digest, 64) ||
        !exact(value.identity, ['runId', 'generation', 'runtimeId', 'sessionId']) || value.identity.generation !== route[1] || !hex(value.identity.runId, 32) ||
        !label(value.identity.runtimeId) || !label(value.identity.sessionId) || !exact(value.adapter, ['id', 'version', 'packageName']) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(value.adapter.id) || !label(value.adapter.version, 64) || !label(value.adapter.packageName, 128) ||
        value.classification !== 'sensitive' || !label(value.action, 64) || !/^[a-z][a-z0-9_.-]*$/.test(value.action) || !label(value.revision) ||
        !record(value.content) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.deadline) || value.deadline <= value.createdAt ||
        value.deadline - value.createdAt > (value.purpose === 'oauth' ? 600000 : 120000) || (value.purpose !== undefined && value.purpose !== 'oauth') ||
        (value.state !== undefined && !Object.hasOwn(labels, value.state))) throw fail();
    const schema = value.schema;
    if (!record(schema)) throw fail();
    if (schema.kind === 'confirm') { if (value.method !== 'confirm' || !exact(schema, ['kind'])) throw fail(); }
    else if (schema.kind === 'select') {
      if (value.method !== 'select' || !exact(schema, ['kind', 'options']) || !Array.isArray(schema.options) || schema.options.length < 1 || schema.options.length > 100 ||
          schema.options.some((option) => !label(option, 512)) || new Set(schema.options).size !== schema.options.length) throw fail();
    } else if (schema.kind === 'text') {
      if (!['input', 'editor'].includes(value.method) || !exact(schema, ['kind', 'maxBytes']) || !Number.isSafeInteger(schema.maxBytes) || schema.maxBytes < 1 || schema.maxBytes > 32768) throw fail();
    } else throw fail();
    return value;
  }
  function providerUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\p{Cc}]/u.test(value)) return;
    try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch {}
  }
  function accept(value) {
    if (record(value) && !Object.hasOwn(value, 'protocol')) { receipt(value); return; }
    const live = checked(value);
    const { state: observed = 'pending', ...body } = live;
    if (terminal(observed)) { settle(observed); return; }
    if (readOnly) { settle('stale'); return; }
    if (deadline && live.deadline !== deadline || fingerprint && stable(body) !== fingerprint) { settle('stale'); return; }
    if (live.deadline <= Date.now()) { settle(decision ? 'delivery_unknown' : 'expired'); return; }
    deadline = live.deadline;
    if (decision) { state = 'delivery_unknown'; return; } // A live GET never proves a prior POST failed.
    state = observed;
    if (fingerprint && request) return; // Preserve drafts, but restore the view after reauthentication.
    fingerprint = stable(body); request = body;
    get('review-preview').textContent = typeof body.content.preview === 'string' ? body.content.preview : JSON.stringify(body.content, null, 2);
    get('review-request').textContent = JSON.stringify(body, null, 2);
    get('review-schema').textContent = JSON.stringify(body.schema, null, 2);
    if (body.schema.kind === 'select') {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择，不默认批准';
      get('review-options').replaceChildren(placeholder);
      for (const choice of body.schema.options) { const option = document.createElement('option'); option.value = choice; option.textContent = choice; get('review-options').append(option); }
      get('review-options').value = '';
    }
    get('review-answer-label').textContent = body.purpose === 'oauth' ? '粘贴此提供方流程的回调（仅本页内存，不自动打开回调）' : body.schema.kind === 'select' ? '选择源操作提供的选项' : '输入回答';
    if (body.purpose === 'oauth') {
      oauthUrl = providerUrl(body.content.authorizationUrl);
      get('review-oauth-url').textContent = typeof body.content.authorizationUrl === 'string' ? body.content.authorizationUrl : '未提供支持的 HTTPS 登录地址';
      if (!oauthUrl) notice('提供方登录链接不可用或不安全；请保留原终端流程，不会自动打开任何地址。');
    }
    get('review-preview').focus();
  }
  async function refresh(explicit = false) {
    if (closed || fatal || working || (!explicit && terminal(state))) return;
    working = true; clearTimers(); paint();
    try { if (await checkAuth()) accept(await call(api)); }
    catch (error) {
      if (!closed) {
        clearPrivate();
        state = decision ? 'delivery_unknown' : error.status === 401 ? 'locked' : 'stale';
        notice('无法读取完整且当前有效的请求；未重新提交决定。请检查管理登录与源操作。');
      }
    } finally { working = false; paint(); schedule(); }
  }
  async function unlock(gateway) {
    if (closed || fatal || working || auth.authorized || (auth.authMode === 'gateway') !== gateway) return;
    const code = get('management-code').value.trim(); get('management-code').value = '';
    if (!gateway && !hex(code, 32)) { notice('请输入既有的 32 位一次性管理码。'); return; }
    working = true; paint();
    try {
      await call('/api/management/' + (gateway ? 'gateway' : 'unlock'), gateway ? {} : { code });
      if (await checkAuth()) { notice('管理已解锁；尚未批准任何操作。'); accept(await call(api)); }
    } catch { if (!closed) { auth.authorized = false; clearPrivate(); state = decision ? 'delivery_unknown' : 'locked'; notice('管理登录或请求读取未完成，请核对既有登录入口；不会自动批准。'); } }
    finally { working = false; paint(); schedule(); }
  }
  async function decide(answer) {
    if (!eligible()) { if (deadline && deadline <= Date.now() && !decision) settle('expired'); return; }
    const original = request;
    const schema = original.schema;
    if (!(schema.kind === 'confirm' && typeof answer === 'boolean' || schema.kind === 'select' && schema.options.includes(answer) ||
          schema.kind === 'text' && typeof answer === 'string' && encoder.encode(answer).byteLength <= schema.maxBytes)) {
      notice('回答必须符合上方完整格式与 UTF-8 字节上限；请明确选择。'); return;
    }
    working = true; clearTimers();
    decision = { id: [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    state = 'delivering'; get('review-text').value = ''; paint();
    try {
      if (!await checkAuth()) throw fail(401);
      const observation = await call(api);
      if (record(observation) && !Object.hasOwn(observation, 'protocol')) { receipt(observation); return; }
      const live = checked(observation);
      const { state: observed = 'pending', ...body } = live;
      if (observed !== 'pending') { settle(observed); return; }
      if (stable(body) !== fingerprint) { settle('stale'); return; }
      if (live.deadline <= Date.now()) { settle('expired'); return; }
      const response = await call(api, { decisionId: decision.id, digest: original.digest, revision: original.revision, answer });
      receipt(response);
    } catch { if (!closed) settle('delivery_unknown'); }
    finally { answer = undefined; working = false; get('review-text').value = ''; paint(); schedule(); }
  }
  get('management-gateway').addEventListener('click', () => unlock(true));
  get('management-unlock').addEventListener('submit', (event) => { event.preventDefault(); return unlock(false); });
  get('review-refresh').addEventListener('click', () => refresh(true));
  get('review-allow').addEventListener('click', () => decide(true));
  get('review-reject').addEventListener('click', () => decide(false));
  get('review-answer-form').addEventListener('submit', (event) => {
    event.preventDefault(); return decide(request?.schema.kind === 'select' ? get('review-options').value : get('review-text').value);
  });
  get('review-oauth-open').addEventListener('click', () => {
    if (!eligible() || !oauthUrl) return;
    window.open(oauthUrl, '_blank', 'noopener,noreferrer');
    notice('已请求打开提供方页面；如弹窗被阻止，请允许本管理页弹出后再次点击，或使用终端流程。此动作不是批准。');
  });
  get('review-cancel').addEventListener('click', () => {
    if (working) return;
    closed = true; epoch++; state = 'closed'; clearTimers(); clearPrivate(); paint();
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (!document.hidden) return refresh();
  });
  window.addEventListener('pagehide', () => { closed = true; epoch++; auth = { authorized: false }; clearTimers(); clearPrivate(); paint(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { fatal = true; settle('stale'); notice('旧页面已失效，请从源操作重新打开；不要重复批准结果不明的操作。'); } });
  if (!route || window.location.search || window.location.hash || window.top !== window.self) {
    fatal = true; state = 'stale'; notice('只允许顶层管理页与完整固定请求路径；不接受查询参数、回调片段或跳转地址。'); paint();
  } else { void refresh(); }
})();`;
var interactionPageCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#21382e;background:#f4f7f2}*{box-sizing:border-box}body{margin:0}main{max-width:880px;margin:auto;padding:32px 24px 48px}header,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}.brand{font-size:22px;font-weight:650}.badge{font-size:12px;padding:6px 10px;border:1px solid #adc5b1;border-radius:20px}h1{font-size:30px;line-height:1.3;margin-top:32px}h2{font-size:18px}h3{font-size:14px}p,footer{line-height:1.8;overflow-wrap:anywhere}section{padding:20px;margin:18px 0;background:#fff;border:1px solid #dce5d8;border-radius:12px;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-width:100%;margin:12px 0 22px;padding:14px;background:#f5f7f4;border:1px solid #e0e7dc;border-radius:8px;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;unicode-bidi:plaintext}label{display:block;margin:12px 0 8px}input,select,textarea,button{font:inherit;border:1px solid #bbcdbb;border-radius:8px;padding:11px 13px;max-width:100%;min-height:44px}input,select,textarea{display:block;width:100%;margin:8px 0 12px;background:#fff;color:inherit}textarea{resize:vertical}button{background:#edf4e9;color:#244a32;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,pre:focus-visible{outline:3px solid #6c926a;outline-offset:3px}#review-allow,#review-answer-submit{background:#28553b;color:#fff}#review-status{padding:14px;border-left:4px solid #7a9a70;background:#e9f0e5}#review-notice{color:#855122}.identity{font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;unicode-bidi:plaintext}footer{font-size:12px;color:#607360;margin-top:28px}[hidden]{display:none!important}@media(max-width:600px){main{padding:22px 14px 36px}h1{font-size:26px}section{padding:15px}.actions{align-items:stretch;flex-direction:column}.actions button{width:100%}pre{padding:10px;font-size:12px}header{align-items:flex-start}}`;
//#endregion
//#region protocol/interactions/control.ts
init_protocol();
var INTERACTION_CONTROL_PATH = "/.pi-web-interactions";
var INTERACTION_FRAME_BYTES = 72 * 1024;
//#endregion
//#region hub/interaction-control.ts
init_protocol();
var unavailable = () => /* @__PURE__ */ new Error("Private interaction channel unavailable or changed");
function openInteractionControl(target, signing, isCurrent, onPending) {
	validateIdentity(target.identity);
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://${isIP(target.backendHost) === 6 ? `[${target.backendHost}]` : target.backendHost}:${target.port}${INTERACTION_CONTROL_PATH}`, {
			headers: {
				"x-pi-web-generation": target.identity.generation,
				"x-pi-web-proof": createHmac("sha256", target.token).update(target.identity.generation).digest("hex")
			},
			maxPayload: INTERACTION_FRAME_BYTES,
			perMessageDeflate: false,
			handshakeTimeout: 5e3
		});
		let challenge;
		let ready = false;
		let closed = false;
		const pending = /* @__PURE__ */ new Map();
		const fail = () => {
			if (closed) return;
			closed = true;
			clearTimeout(handshake);
			socket.terminate();
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(unavailable());
			}
			pending.clear();
			reject(unavailable());
		};
		const handshake = setTimeout(fail, 5e3);
		const send = (frame) => {
			if (!isCurrent() || closed || socket.readyState !== WebSocket.OPEN) {
				fail();
				throw unavailable();
			}
			const bytes = JSON.stringify(frame);
			if (Buffer.byteLength(bytes) > 73728 || socket.bufferedAmount > 256 * 1024) {
				fail();
				throw unavailable();
			}
			socket.send(bytes);
		};
		const rpc = (type, args = {}) => new Promise((done, failed) => {
			if (!ready || pending.size >= 8) {
				failed(unavailable());
				return;
			}
			const id = randomBytes(16).toString("hex");
			const timer = setTimeout(() => {
				pending.delete(id);
				failed(unavailable());
			}, 5e3);
			pending.set(id, {
				resolve: done,
				reject: failed,
				timer
			});
			try {
				send({
					type,
					id,
					...args
				});
			} catch {
				pending.delete(id);
				clearTimeout(timer);
				failed(unavailable());
			}
		});
		const evidence = (kind, payload, deadline = Date.now() + 1e4) => {
			if (!challenge || !isCurrent() || closed) throw unavailable();
			const now = Date.now();
			return signing.sign({
				kind,
				identity: target.identity,
				challenge,
				issuedAt: now,
				expiresAt: Math.min(now + 1e4, deadline),
				payload
			});
		};
		socket.on("error", fail);
		socket.on("close", fail);
		socket.on("message", (raw, binary) => {
			try {
				if (binary || !isCurrent() || closed) throw unavailable();
				const frame = JSON.parse(raw.toString());
				if (!plainRecord(frame)) throw unavailable();
				if (!ready) {
					if (frame.type === "challenge" && !challenge) {
						if (!opaqueId(frame.challenge, 64) || canonicalJson(frame.identity) !== canonicalJson(target.identity)) throw unavailable();
						challenge = frame.challenge;
						send({
							type: "authenticate",
							evidence: evidence("control", {})
						});
						return;
					}
					if (frame.type !== "ready" || !challenge) throw unavailable();
					ready = true;
					clearTimeout(handshake);
					resolve({
						active: () => !closed && isCurrent(),
						read: async (requestId) => {
							if (!opaqueId(requestId)) throw unavailable();
							const request = validateInteractionRequest(await rpc("read", {
								requestId,
								evidence: evidence("read", { requestId })
							}));
							if (!isCurrent() || request.requestId !== requestId || canonicalJson(request.identity) !== canonicalJson(target.identity) || request.deadline <= Date.now()) throw unavailable();
							return request;
						},
						decide: async (request, answer, decisionId) => {
							if (!opaqueId(decisionId) || canonicalJson(request.identity) !== canonicalJson(target.identity)) throw unavailable();
							const valid = validateInteractionRequest(request);
							const value = validateAnswer(valid.schema, answer);
							const result = await rpc("decision", { evidence: evidence("decision", {
								requestId: valid.requestId,
								operationId: valid.operationId,
								adapterId: valid.adapter.id,
								adapterVersion: valid.adapter.version,
								revision: valid.revision,
								digest: valid.digest,
								decisionId,
								answer: value
							}, valid.deadline) });
							if (!isCurrent() || ![
								"allowed",
								"rejected",
								"cancelled",
								"expired",
								"stale",
								"delivery_unknown"
							].includes(String(result))) throw unavailable();
							return result;
						},
						status: (requestId) => rpc("status", requestId === void 0 ? {} : { requestId }),
						close: fail
					});
					return;
				}
				if (frame.type === "pending") {
					if (!Array.isArray(frame.items) || frame.items.length > INTERACTION_LIMITS.pendingPerPi || !onPending?.(frame.items) && onPending !== void 0) throw unavailable();
					return;
				}
				if (frame.type !== "result" || !opaqueId(frame.id)) throw unavailable();
				const request = pending.get(frame.id);
				if (!request) return;
				clearTimeout(request.timer);
				pending.delete(frame.id);
				if (frame.ok === true) request.resolve(frame.result);
				else request.reject(unavailable());
			} catch {
				fail();
			}
		});
	});
}
//#endregion
//#region hub/interactions.ts
init_hub_generation();
init_protocol();
init_interaction_signing();
var sameTarget = (a, b) => canonicalJson(a.identity) === canonicalJson(b.identity) && a.backendHost === b.backendHost && a.port === b.port && a.token === b.token;
async function readBody(request) {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
	const bytes = await new Promise((resolve, reject) => {
		const chunks = [];
		let length = 0;
		let done = false;
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			request.off("data", data);
			request.off("end", end);
			request.off("error", errorHandler);
			request.off("aborted", errorHandler);
			if (error) {
				request.resume();
				reject(error);
			} else resolve(Buffer.concat(chunks));
		};
		const data = (chunk) => {
			length += chunk.length;
			if (length > INTERACTION_LIMITS.requestBytes) finish(/* @__PURE__ */ new Error());
			else chunks.push(chunk);
		};
		const end = () => finish();
		const errorHandler = () => finish(/* @__PURE__ */ new Error());
		const timer = setTimeout(errorHandler, 5e3);
		request.on("data", data);
		request.once("end", end);
		request.once("error", errorHandler);
		request.once("aborted", errorHandler);
	});
	const value = JSON.parse(bytes.toString("utf8"));
	canonicalJson(value);
	if (!plainRecord(value)) throw new Error();
	return value;
}
/** Transient only: private bodies are never written to Hub state or session history. */
function createInteractionApi(config, management, hooks) {
	const signing = config.management ? interactionSigning(config) : void 0;
	const channels = /* @__PURE__ */ new Map();
	let closed = false;
	let enumerating = false;
	const retire = (generation) => {
		const record = channels.get(generation);
		if (!record) return;
		channels.delete(generation);
		record.channel?.close();
		record.promise.then((channel) => channel.close()).catch(() => {});
	};
	const timer = setInterval(() => {
		for (const [generation, record] of channels) if (!hooks.current(record.target) || record.channel && !record.channel.active()) retire(generation);
	}, 1e3);
	timer.unref();
	const channelFor = async (generation, revalidate) => {
		if (!signing || closed) throw new Error();
		const target = await hooks.lookup(generation);
		revalidate();
		if (!target || !hooks.current(target)) throw new Error();
		let record = channels.get(generation);
		if (record && (!sameTarget(record.target, target) || record.channel && !record.channel.active())) {
			retire(generation);
			record = void 0;
		}
		if (!record) {
			if (channels.size >= 64) throw new Error();
			const created = {
				target,
				count: 0
			};
			channels.set(generation, created);
			created.promise = openInteractionControl(target, signing, () => !closed && channels.get(generation) === created && hooks.current(target), (items) => {
				for (const item of items) {
					if (!plainRecord(item)) return false;
					exactKeys(item, [
						"requestId",
						"adapterId",
						"action",
						"classification",
						"state",
						"deadline"
					]);
					if (!opaqueId(item.requestId) || !safeLabel(item.adapterId, 64) || !safeLabel(item.action, 64) || !["session", "sensitive"].includes(String(item.classification)) || item.state !== "pending" || !Number.isSafeInteger(item.deadline)) return false;
				}
				if ([...channels.values()].reduce((sum, peer) => sum + (peer === created ? 0 : peer.count), items.length) > INTERACTION_LIMITS.pendingPerHub) return false;
				created.count = items.length;
				return true;
			}).then((channel) => {
				if (closed || channels.get(generation) !== created || !hooks.current(target)) {
					channel.close();
					throw new Error();
				}
				created.channel = channel;
				return channel;
			}).catch(() => {
				if (channels.get(generation) === created) channels.delete(generation);
				throw new Error("Interaction channel unavailable");
			});
			record = created;
		}
		const channel = await record.promise;
		revalidate();
		if (!hooks.current(target)) throw new Error();
		return channel;
	};
	const pattern = new RegExp(`^/api/management/interactions/(${HUB_GENERATION_SOURCE})/([a-f0-9]{32})$`);
	return {
		retire,
		close() {
			closed = true;
			clearInterval(timer);
			for (const generation of [...channels.keys()]) retire(generation);
		},
		async handle(request, response, sameOrigin) {
			const url = new URL(request.url ?? "/", "http://hub.invalid");
			const inbox = url.pathname === "/api/management/interactions";
			if (!inbox && !url.pathname.startsWith("/api/management/interactions/")) return false;
			const reply = (status, body) => response.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
			}).end(JSON.stringify(body));
			const match = pattern.exec(url.pathname);
			if (!match && !inbox || url.search || !signing) {
				reply(404, { error: "Interaction route unavailable" });
				return true;
			}
			if (request.method !== "GET" && request.method !== "POST" || inbox && request.method !== "GET") {
				reply(405, { error: "Method not allowed" });
				return true;
			}
			if (!sameOrigin) {
				reply(403, { error: "Trusted management origin required" });
				return true;
			}
			let authorized = false;
			try {
				const write = request.method === "POST";
				const auth = management.authorize(request, write);
				const revalidate = () => {
					authorized = false;
					management.revalidate(request, auth, write);
					authorized = true;
				};
				authorized = true;
				if (inbox) {
					if (enumerating) {
						reply(503, { error: "Interaction inbox already being checked" });
						return true;
					}
					enumerating = true;
					try {
						const deadline = Date.now() + 4500;
						const withinDeadline = (operation) => new Promise((resolve, reject) => {
							const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Inbox deadline reached")), Math.max(1, deadline - Date.now()));
							operation.then(resolve, reject).finally(() => clearTimeout(timer));
						});
						const all = [...new Set(hooks.generations?.() ?? [])];
						const queue = all.slice(0, 64);
						const batches = [];
						let collected = 0;
						let unavailable = 0;
						let truncated = all.length > queue.length;
						let cursor = 0;
						await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
							while (cursor < queue.length && Date.now() < deadline && !request.destroyed) {
								const generation = queue[cursor++];
								try {
									const channel = await withinDeadline(channelFor(generation, revalidate));
									const record = channels.get(generation);
									if (!record || record.channel !== channel) throw new Error();
									const status = await withinDeadline(channel.status());
									revalidate();
									if (!channel.active()) throw new Error();
									if (!plainRecord(status) || !Array.isArray(status.pending) || status.pending.length > INTERACTION_LIMITS.pendingPerHub) throw new Error();
									const items = [];
									for (const item of status.pending) {
										if (!plainRecord(item) || !opaqueId(item.requestId) || !safeLabel(item.adapterId, 64) || !safeLabel(item.action, 64) || !Number.isSafeInteger(item.deadline)) throw new Error();
										if (Number(item.deadline) <= Date.now()) continue;
										if (collected + items.length >= INTERACTION_LIMITS.pendingPerHub) {
											truncated = true;
											break;
										}
										items.push({
											generation,
											requestId: item.requestId,
											adapterId: item.adapterId,
											action: item.action,
											deadline: item.deadline,
											path: `/interactions/${generation}/${item.requestId}/`
										});
									}
									collected += items.length;
									batches.push({
										generation,
										record,
										channel,
										items
									});
								} catch {
									revalidate();
									unavailable++;
								}
							}
						}));
						unavailable += queue.length - cursor;
						revalidate();
						const items = [];
						const now = Date.now();
						for (const batch of batches) {
							if (channels.get(batch.generation) !== batch.record || batch.record.channel !== batch.channel || !hooks.current(batch.record.target) || !batch.channel.active()) {
								unavailable++;
								continue;
							}
							for (const item of batch.items) if (Number(item.deadline) > now) items.push(item);
						}
						reply(200, {
							items,
							unavailable,
							truncated
						});
						return true;
					} finally {
						enumerating = false;
					}
				}
				if (!match) throw new Error();
				const channel = await channelFor(match[1], revalidate);
				if (!write) {
					const status = await channel.status(match[2]);
					revalidate();
					const receipt = status.completed?.[0];
					if (receipt) {
						reply(200, {
							state: receipt.state,
							...receipt.outcome ? { outcome: receipt.outcome } : {}
						});
						return true;
					}
					const live = await channel.read(match[2]);
					revalidate();
					reply(200, live);
					return true;
				}
				const value = await readBody(request);
				revalidate();
				exactKeys(value, [
					"decisionId",
					"digest",
					"revision",
					"answer"
				]);
				if (!opaqueId(value.decisionId) || !opaqueId(value.digest, 64) || !safeLabel(value.revision)) throw new Error();
				const status = await channel.status(match[2]);
				revalidate();
				const receipt = status.completed?.[0];
				if (receipt) {
					if (receipt.decisionId !== value.decisionId || receipt.digest !== value.digest || receipt.revision !== value.revision || receipt.responseDigest !== contentDigest(value.answer)) throw new Error();
					reply(200, {
						state: receipt.state,
						...receipt.outcome ? { outcome: receipt.outcome } : {}
					});
					return true;
				}
				const live = await channel.read(match[2]);
				revalidate();
				if (live.digest !== value.digest || live.revision !== value.revision) throw new Error();
				const state = await channel.decide(live, value.answer, value.decisionId);
				revalidate();
				reply(200, { state });
			} catch {
				reply(authorized ? 409 : 401, { error: authorized ? "Interaction changed or delivery unknown; check the original operation before retrying" : "Management authorization required" });
			}
			return true;
		}
	};
}
//#endregion
//#region hub/approvals-portal.ts
var approvalsPortalHtml = `<section id="approvals" class="approvals" aria-labelledby="approvals-title"><div class="runtime-update-heading"><h3 id="approvals-title">统一授权中心</h3><button id="approvals-refresh" type="button">刷新任务与回执</button></div><p id="approvals-status" role="status">解锁管理后可查看任务</p><p>批准仅代表允许 Gate 执行，不代表更新已经完成。请核对目标、版本和任务详情。自动模式仅适用于已登记的可信服务与镜像。</p><p id="approvals-result" role="status" aria-live="polite"></p><div id="approvals-receipts"></div><h4>Gate 任务</h4><div id="approvals-tasks"></div><h4>审批策略</h4><div id="approvals-policies"></div><h4>扩展授权</h4><p id="approvals-inbox-status" role="status"></p><div id="approvals-inbox"></div></section>`;
var approvalsPortalCss = `.approvals{border-top:1px solid #dce5d7;margin-top:20px;padding-top:18px}.approvals h4{font-size:13px;margin:20px 0 10px}.approval-card{border:1px solid #dce5d7;border-radius:12px;background:#fbfcfa;padding:14px;margin:10px 0;overflow-wrap:anywhere;min-width:0}.approval-card h5{font-size:14px;margin:0 0 8px}.approval-identity{font:11px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.approval-card pre{white-space:pre-wrap;font-size:11px;overflow-wrap:anywhere;max-height:240px;overflow:auto}.approval-card summary{font-size:12px}.approval-card .controls{margin-top:12px;flex-wrap:wrap}.approval-card select{font:inherit;padding:10px;max-width:100%;border:1px solid #dce5d7;border-radius:8px;background:white}.approval-card .danger{color:#99412f;border-color:#e8c4b9}.approval-inbox-link{margin:8px 0;text-align:left}#approvals-result{color:#815725}.approval-receipt{font-size:11px;overflow-wrap:anywhere}@media(max-width:600px){.approval-card{padding:12px}.approval-card .controls{flex-direction:column}.approval-card button,.approval-card select{width:100%}}`;
/** Embedded only in the trusted management script; uses its shared auth lifecycle. */
var approvalsPortalJs = `
  const approvals = (() => {
    let tasks = [], policies = [], inbox = [], unavailable = 0, truncated = false;
    let loading, sending = false, result = '', failed = false;
    const pending = new Map();
    const taskCards = new Map(), policyCards = new Map();
    const storageKey = 'pi-hub-gate-decisions';
    const keyFor = (item, policy = false) => (policy ? 'policy:' : 'task:') + item.kind + ':' + item.id;
    const node = (tag, text, cls = '') => { const item = document.createElement(tag); item.textContent = text; item.className = cls; return item; };
    const actionLabel = (action) => ({ approve: '批准', reject: '拒绝', rollback: '回滚' })[action];
    const modeLabel = (mode) => ({ manual: 'manual · 手动审批', auto: 'auto · 自动执行', disabled: 'disabled · 禁用' })[mode];
    const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify([...pending.values()])); return true; } catch { return false; } };
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(0,64)) {
        if (item && /^[a-f0-9]{32}$/.test(item.decision_id) && /^(task|policy):[a-z]+:[a-z0-9._-]{1,64}$/.test(item.key)) pending.set(item.decision_id, { decision_id: item.decision_id, key: item.key });
      }
    } catch {}
    const blocked = (key) => sending || authTransition || [...pending.values()].some((item) => item.key === key);
    function button(label, callback, disabled, danger = false) {
      const item = node('button', label, danger ? 'danger' : ''); item.type = 'button'; item.disabled = disabled; item.addEventListener('click', callback); return item;
    }
    function renderCards(id, items, cache, policy, create) {
      const container = get(id), keys = new Set(), rows = [];
      for (const item of items) {
        const key = keyFor(item, policy), model = JSON.stringify([authGeneration, item]);
        let card = cache.get(key);
        if (!card || card.model !== model) { card = { ...create(item), model }; cache.set(key, card); }
        keys.add(key); rows.push(card.row);
        for (const control of card.controls) control.disabled = blocked(key);
      }
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
      // Leave unchanged nodes attached: polling must not reset details, drafts
      // or focus. Changed identities/content receive new closures and controls.
      const retained = new Set(rows);
      for (const child of [...container.children]) if (!retained.has(child)) container.removeChild(child);
      for (let index = 0; index < rows.length; index++) {
        if (container.children[index] !== rows[index]) container.insertBefore(rows[index], container.children[index] || null);
      }
    }
    function render() {
      for (const id of ['approvals-inbox','approvals-receipts']) get(id).replaceChildren();
      get('approvals-result').textContent = auth.authorized ? result : '';
      get('approvals-refresh').disabled = !auth.authorized || authTransition || loading === authGeneration;
      get('approvals-inbox-status').textContent = '';
      get('approvals-status').textContent = !auth.authorized ? '解锁管理后可查看任务' : !auth.gateManagementAvailable ? 'Gate 审批尚未接入：需管理员一次性配置专用凭据；扩展审核独立可用。' : failed ? 'Gate 暂不可用；已清除旧任务显示，未执行任何操作。' : loading === authGeneration ? '正在核对任务…' : tasks.length + ' 个任务 · Gate 独立执行';
      if (!auth.authorized) {
        tasks = []; policies = []; inbox = []; unavailable = 0; truncated = false; result = ''; failed = false;
        taskCards.clear(); policyCards.clear();
        get('approvals-tasks').replaceChildren(); get('approvals-policies').replaceChildren();
        return;
      }
      for (const item of pending.values()) get('approvals-receipts').append(node('p', '未确认回执：' + item.decision_id + '。仅查询原编号，不会重复发送；未确认前该对象不能再次操作。', 'approval-receipt'));
      renderCards('approvals-tasks', tasks, taskCards, false, (item) => {
        const row = node('article', '', 'approval-card');
        row.append(node('h5', item.title), node('p', item.target + ' · ' + item.status + ' / ' + item.stage));
        row.append(node('p', '任务编号：' + item.id + (item.version ? ' · 版本：' + item.version : ''), 'approval-identity'));
        const details = node('details', ''); details.append(node('summary', '查看精确任务详情'));
        details.append(node('pre', JSON.stringify({ kind:item.kind, target:item.target, revision:item.revision, version:item.version, commit:item.commit, image:item.image, plan_hash:item.plan_hash, details:item.details }, null, 2)));
        row.append(details);
        const controls = node('div', '', 'controls');
        for (const action of item.actions || []) {
          if (!actionLabel(action)) continue;
          controls.append(button(actionLabel(action), () => decide(item, action), blocked(keyFor(item)), action !== 'approve'));
        }
        row.append(controls); return { row, controls: [...controls.children] };
      });
      renderCards('approvals-policies', policies, policyCards, true, (item) => {
        const row = node('article', '', 'approval-card'); row.append(node('h5', item.kind + ' / ' + item.id));
        row.append(node('p', '当前策略：' + modeLabel(item.mode) + (item.paused ? ' · 已暂停' : '')));
        row.append(node('p', '可信镜像：' + (item.images?.join(', ') || '由已登记的服务定义管理'), 'approval-identity'));
        const controls = node('div', '', 'controls');
        const select = node('select', ''); select.id = 'approvals-policy-' + item.kind + '-' + item.id; select.setAttribute?.('aria-label', item.id + ' 审批模式');
        for (const mode of ['manual','auto','disabled']) { const option = node('option', modeLabel(mode)); option.value = mode; select.append(option); }
        select.value = item.mode; select.disabled = blocked(keyFor(item, true)); controls.append(select);
        controls.append(button('保存策略', () => changePolicy(item, select.value), blocked(keyFor(item, true))));
        if (item.kind === 'service' && item.paused) controls.append(button('恢复服务审批', () => resume(item), blocked(keyFor(item, true))));
        row.append(controls); return { row, controls: [...controls.children] };
      });
      get('approvals-inbox-status').textContent = !auth.interactionsAvailable ? '扩展授权收件箱未配置' : inbox.length + ' 个待审核请求' + (unavailable ? ' · ' + unavailable + ' 个来源暂不可用，不能视为空' : '') + (truncated ? ' · 已达显示上限' : '');
      for (const item of inbox) {
        if (!/^\\/interactions\\/[a-f0-9-]{32,64}\\/[a-f0-9]{32}\\/$/.test(item.path) || item.deadline <= Date.now()) continue;
        const link = node('a', item.adapterId + ' · ' + item.action + ' · 查看并授权 ↗', 'open approval-inbox-link'); link.href = item.path; get('approvals-inbox').append(link);
      }
    }
    async function reconcile() {
      const generation = authGeneration;
      for (const item of [...pending.values()]) {
        try {
          const receipt = await api('gate/decisions/' + item.decision_id);
          if (generation !== authGeneration || !auth.authorized) return;
          if (receipt.decision_id === item.decision_id && receipt.status === 'recorded') {
            pending.delete(item.decision_id); persist(); result = '审批决定已记录：' + item.decision_id + '。请刷新任务核对执行状态，不代表执行已完成。';
          } else result = '原决定投递结果未确认；不会自动重试。请保留编号由管理员核对。';
        } catch (error) {
          if (generation !== authGeneration || error.stale) return;
          result = '原决定回执未确认；不会重新提交。请刷新查询或由管理员核对。';
        }
      }
    }
    async function submit(route, body, key, confirmation) {
      if (!auth.authorized || !auth.gateManagementAvailable || blocked(key)) return;
      const generation = authGeneration;
      if (!window.confirm(confirmation)) return;
      if (generation !== authGeneration || !auth.authorized || authTransition) return;
      if (pending.size >= 64) { result = '未确认回执已满，请先核对旧决定。'; render(); return; }
      const decision_id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2,'0')).join('');
      pending.set(decision_id, { decision_id, key });
      if (!persist()) { pending.delete(decision_id); result = '未提交：无法保存原决定编号，请恢复浏览器会话存储。'; render(); return; }
      sending = true; render();
      try {
        const receipt = await api('gate/' + route, { ...body, decision_id });
        if (generation !== authGeneration) return;
        if (receipt.decision_id === decision_id && receipt.status === 'recorded') {
          pending.delete(decision_id); persist(); result = '审批决定已记录：' + decision_id + '。执行状态请刷新核对。';
        } else result = '投递未确认；仅按原决定编号查询，不会重新提交。';
      } catch (error) {
        if (generation !== authGeneration || error.stale) return;
        if ([400,409].includes(error.status)) { pending.delete(decision_id); persist(); result = '任务或策略已变化 / 请求被拒绝；请刷新并重新审阅，不会自动批准新内容。'; }
        else result = '投递未确认；保留原决定编号，仅查询不重发。';
      } finally { sending = false; if (generation === authGeneration) render(); }
    }
    function decide(item, action) {
      return submit('decisions', { kind:item.kind, id:item.id, revision:item.revision, action }, keyFor(item),
        '确认' + actionLabel(action) + '此任务？\\n目标：' + item.target + '\\n任务：' + item.title + '\\n编号：' + item.id + '\\n版本：' + (item.version || '—') + '\\n提交：' + (item.commit || '—') + '\\n镜像：' + (item.image || '—') + '\\n计划：' + (item.plan_hash || '—') + '\\n审阅版本：' + item.revision + '\\n详情：' + JSON.stringify(item.details || {}) + '\\n批准只授予 Gate 执行权限；回滚也可能短暂断连。');
    }
    function changePolicy(item, mode) {
      if (!['manual','auto','disabled'].includes(mode) || mode === item.mode) return;
      return submit('policies', { kind:item.kind, id:item.id, revision:item.revision, mode }, keyFor(item,true),
        '确认修改 ' + item.kind + '/' + item.id + ' 为 ' + mode + '？\\nauto 会自动处理该范围内后续的合规任务；不会扩充可信镜像列表。\\n审阅版本：' + item.revision);
    }
    function resume(item) { return submit('resume', { id:item.id, revision:item.revision }, keyFor(item,true), '确认恢复 ' + item.id + ' 的审批处理？\\n现有策略：' + item.mode + '\\n审阅版本：' + item.revision); }
    async function poll() {
      const generation = authGeneration;
      if (loading === generation || !auth.authorized || authTransition) return;
      loading = generation; render();
      try {
        if (auth.gateManagementAvailable) {
          try {
            await reconcile();
            if (generation !== authGeneration || !auth.authorized) return;
            const data = await api('gate');
            if (generation !== authGeneration) return;
            tasks = Array.isArray(data.tasks) ? data.tasks.slice(0,512) : []; policies = Array.isArray(data.policies) ? data.policies.slice(0,128) : []; failed = false;
          } catch (error) { if (generation !== authGeneration || error.stale) return; tasks = []; policies = []; failed = true; }
        }
        if (auth.interactionsAvailable) {
          try {
            const data = await api('interactions'); if (generation !== authGeneration) return;
            inbox = Array.isArray(data.items) ? data.items.slice(0,64) : []; unavailable = data.unavailable || 0; truncated = !!data.truncated;
          } catch (error) { if (generation !== authGeneration || error.stale) return; inbox = []; unavailable = 1; }
        }
      } finally { if (loading === generation) loading = undefined; if (generation === authGeneration) render(); }
    }
    function clearProtected() { tasks = []; policies = []; inbox = []; unavailable = 0; truncated = false; result = ''; failed = false; taskCards.clear(); policyCards.clear(); render(); }
    get('approvals-refresh').addEventListener('click', poll);
    return { poll, updateAuth: render, clearProtected };
  })();
`;
//#endregion
//#region hub/launch-portal.ts
init_hub_generation();
var launchPortalHtml = `<section id="new-pi" class="launch-section" aria-labelledby="launch-title"><div class="runtime-update-heading"><h3 id="launch-title">新建 Pi</h3><button id="launch-refresh" type="button">刷新启动状态</button></div><p>在允许的项目目录中新建独立 Pi。关闭网页不结束会话；不会创建或删除宿主文件夹。</p><p id="launch-status" role="status">解锁管理后可新建 Pi</p><div id="launch-picker" hidden><div class="controls"><button id="launch-root" type="button">gitproject 根目录</button><button id="launch-parent" type="button">上一级</button><button id="launch-more" type="button" hidden>更多文件夹</button></div><p id="launch-current" class="launch-path"></p><div id="launch-directories" class="launch-directories" aria-label="可选项目文件夹"></div><form id="launch-form"><label for="launch-name">会话名称</label><div class="controls"><input id="launch-name" type="text" autocomplete="off" maxlength="80" required><button id="launch-start" type="submit" disabled>在此目录启动 Pi</button></div></form></div><p id="launch-result" role="status" aria-live="polite"></p><button id="launch-again" type="button" hidden>再新建一个 Pi</button><div id="launch-jobs" aria-live="polite"></div></section>`;
var launchPortalCss = `.launch-section{border-top:1px solid #dce5d7;margin-top:20px;padding-top:18px}.launch-path,.launch-job p{overflow-wrap:anywhere}.launch-path{padding:10px 12px;border:1px solid #dce5d7;border-radius:9px;background:#f7faf5;font-family:ui-monospace,monospace;font-size:12px}.launch-directories{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;max-height:260px;overflow:auto;margin:12px 0}.launch-directories button{text-align:left;overflow-wrap:anywhere}.launch-job{padding:12px;margin-top:12px;border:1px solid #dce5d7;border-radius:12px;background:#fbfcfa}.launch-job h4{margin:0}.launch-job p{margin:6px 0}.launch-job .open{display:inline-block;margin-top:6px}#launch-result{color:#815725}@media(max-width:600px){.launch-directories{grid-template-columns:1fr}.launch-section .controls{flex-direction:column;align-items:stretch}.launch-section .controls>*{width:100%;max-width:none}}`;
var launchPortalJs = `
  const launchPi = (() => {
    let config, directory, jobs = [], loading, browsing = false, sequence = 0, sending = false, result = '', pending, known = false;
    const requestStorageKey = 'pi-hub-launch';
    const receiptStorageKey = 'pi-hub-launch-id';
    const node = (tag, text, cls = '') => { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; };
    const recovery = (value) => value && /^[a-f0-9]{32}$/.test(value.id) ? { id:value.id } : undefined;
    const readStored = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return undefined; } };
    const writeStored = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
    const removeStored = (key) => { try { sessionStorage.removeItem(key); return true; } catch { return false; } };
    pending = recovery(readStored(receiptStorageKey));
    let receiptDurable = !!pending;
    if (!pending) pending = recovery(readStored(requestStorageKey));
    const current = (generation) => generation === authGeneration && auth.authorized && !authTransition;
    const saveReceipt = () => { const receipt = recovery(pending); return !!receipt && writeStored(receiptStorageKey, receipt); };
    const clearStoredRecovery = () => removeStored(requestStorageKey) && removeStored(receiptStorageKey);
    const retainRecovery = () => { pending = recovery(pending); if (!pending) return; if (saveReceipt()) receiptDurable = true; if (receiptDurable) removeStored(requestStorageKey); };
    retainRecovery();
    function render() {
      get('launch-picker').hidden = !auth.authorized || !config?.enabled;
      get('launch-refresh').disabled = !auth.authorized || authTransition || loading === authGeneration;
      get('launch-start').disabled = !auth.authorized || authTransition || !config?.enabled || !directory || browsing || sending || !!pending;
      get('launch-parent').disabled = !current(authGeneration) || browsing || !directory || directory.parent === null;
      get('launch-root').disabled = !current(authGeneration) || browsing;
      get('launch-more').hidden = !directory?.truncated;
      get('launch-more').disabled = browsing || authTransition;
      get('launch-again').hidden = !auth.authorized || !pending || !known;
      get('launch-again').disabled = sending || authTransition;
      get('launch-status').textContent = !auth.authorized ? '解锁管理后可新建 Pi' : !auth.gateManagementAvailable ? '新建 Pi 尚未接入：需要配置 Gate 管理能力。' : config && !config.enabled ? '新建 Pi 尚未启用：需管理员一次性配置固定启动模板。' : !config ? '正在检查新建 Pi 能力…' : '仅允许在 ' + config.rootLabel + ' 下选择已有目录，当前上限 ' + config.maxActive + ' 个受管启动。';
      get('launch-result').textContent = auth.authorized ? result : '';
      get('launch-jobs').replaceChildren();
      if (!auth.authorized) return;
      const statuses = { queued:'已排队', starting:'正在启动', running:'Pi 已运行，等待会话登记', exited:'Pi 已退出', failed:'启动失败，请核对任务', recovery_required:'结果不确定，需管理员核对，不能盲目重试' };
      for (const job of jobs) {
        const row = node('article', '', 'launch-job'); row.append(node('h4', job.label), node('p', '目录：' + config?.rootLabel + '/' + job.path), node('p', statuses[job.status] || '结果未知'), node('p', '任务编号：' + job.id + ' · ' + job.stage));
        if (job.status === 'running' && typeof job.sessionUrl === 'string') {
          try {
            const chat = new URL(document.querySelector('meta[name="pi-chat-origin"]').content);
            const url = new URL(job.sessionUrl);
            if (url.origin === chat.origin && !url.username && !url.password && !url.search && !url.hash && new RegExp('^/s/${HUB_GENERATION_SOURCE}/$').test(url.pathname)) {
              row.children[2].textContent = '会话已登记，可以进入'; const link = node('a', '进入会话 ↗', 'open'); link.href = url.href; row.append(link);
            }
          } catch {}
        } else if (job.status === 'running' && Date.now() - job.updated_at > 60000) row.append(node('p', '登记等待较久：请检查 Web 扩展和 Hub 连接；不要重复创建来代替排查。'));
        get('launch-jobs').append(row);
      }
    }
    function renderDirectory() {
      get('launch-directories').replaceChildren();
      get('launch-current').textContent = directory ? config.rootLabel + (directory.path ? '/' + directory.path : '') : '';
      for (const entry of directory?.entries || []) {
        const button = node('button', '打开 ' + entry.name); button.type = 'button'; button.disabled = browsing || authTransition;
        button.addEventListener('click', () => browse(entry.path)); get('launch-directories').append(button);
      }
      render();
    }
    async function browse(path, cursor) {
      if (!auth.authorized || authTransition || !config?.enabled || browsing) return;
      const generation = authGeneration, ticket = ++sequence;
      browsing = true; renderDirectory();
      try {
        const query = new URLSearchParams({ path }); if (cursor) query.set('cursor', cursor);
        const next = await api('gate/workspaces?' + query);
        if (!current(generation) || ticket !== sequence) return;
        if (cursor && directory?.path === next.path && directory.revision === next.revision) next.entries = [...directory.entries, ...next.entries];
        directory = next;
        if (!get('launch-name').value) get('launch-name').value = path.split('/').pop() || config.rootLabel;
        result = '';
      } catch (error) {
        if (!current(generation) || error.stale || ticket !== sequence) return;
        directory = undefined; result = '文件夹不可用或已变化，请重新选择；不会自动创建或扩大目录范围。';
      } finally { if (ticket === sequence) { browsing = false; if (current(generation)) renderDirectory(); } }
    }
    async function poll() {
      if (!auth.authorized || authTransition || !auth.gateManagementAvailable || loading === authGeneration) { render(); return; }
      const generation = authGeneration; loading = generation; render();
      try {
        const next = await api('gate/launch-config'); if (!current(generation)) return;
        const previous = config; config = next;
        if (!config.enabled) { directory = undefined; jobs = []; renderDirectory(); return; }
        if (!previous) await browse(config.defaultPath);
        else if (previous.revision !== config.revision) { directory = undefined; result = '启动模板已变化，请重新选择目录并确认。'; renderDirectory(); }
        if (!current(generation)) return;
        const data = await api('gate/launches'); if (!current(generation)) return; jobs = data.jobs;
        if (pending) {
          try {
            const original = await api('gate/launches/' + pending.id); if (!current(generation)) return;
            known = true; if (!jobs.some((job) => job.id === original.id)) jobs.unshift(original);
          } catch (error) { if (!current(generation) || error.stale) return; known = false; result = '原启动任务尚未确认：' + pending.id + '。仅查询原编号，不会重复提交。'; }
        }
      } catch (error) { if (!current(generation) || error.stale) return; config = undefined; jobs = []; directory = undefined; renderDirectory(); result = '新建 Pi 服务暂不可用；没有重新提交任何启动。'; }
      finally { if (loading === generation) loading = undefined; if (current(generation)) render(); }
    }
    get('launch-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!current(authGeneration) || !config?.enabled || !directory || browsing || sending || pending) return;
      const label = get('launch-name').value.trim(); if (!label || label.length > 80 || /[\\p{Cc}\\p{Cs}]/u.test(label)) { result = '请输入不超过 80 字的有效会话名称。'; render(); return; }
      const generation = authGeneration;
      const selected = directory, profile = config;
      if (!window.confirm('在 ' + profile.rootLabel + '/' + selected.path + ' 新建 Pi？\\n名称：' + label + '\\n将使用固定容器配置。关闭网页不会停止 Pi。')) return;
      if (!current(generation) || directory !== selected || config !== profile) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2,'0')).join('');
      const request = { id, path:selected.path, label, policy_revision:profile.revision, workspace_revision:selected.revision };
      pending = recovery(request); known = false; receiptDurable = saveReceipt();
      if (!receiptDurable || !writeStored(requestStorageKey, request)) { clearStoredRecovery(); pending = undefined; receiptDurable = false; result = '未启动：无法保存原任务编号，请恢复浏览器会话存储。'; render(); return; }
      sending = true; render();
      try {
        const job = await api('gate/launches', request); if (!current(generation)) return;
        known = true; jobs = [job, ...jobs.filter((row) => row.id !== job.id)]; result = '启动申请已记录：' + id + '。等待 Pi 运行并登记，不代表已可以聊天。';
      } catch (error) {
        if (!current(generation) || error.stale) return;
        if ([400,409].includes(error.status)) { pending = undefined; clearStoredRecovery(); receiptDurable = false; result = '目录或启动配置已变化，请刷新后重新选择并确认。'; }
        else result = '启动结果尚未确认：' + id + '。只查询原编号，不会自动重试。';
      } finally { sending = false; if (current(generation)) render(); }
    });
    get('launch-root').addEventListener('click', () => browse(''));
    get('launch-parent').addEventListener('click', () => directory?.parent !== null && directory && browse(directory.parent));
    get('launch-more').addEventListener('click', () => directory?.nextCursor && browse(directory.path, directory.nextCursor));
    get('launch-refresh').addEventListener('click', poll);
    get('launch-again').addEventListener('click', () => { if (!current(authGeneration) || sending || !known) return; const old = pending; if (!clearStoredRecovery()) { pending = old; result = '无法保存新的操作状态，未允许重复创建。'; } else { pending = undefined; receiptDurable = false; known = false; result = '请核对目录和名称，再确认启动另一个独立 Pi。'; } render(); });
    function clearProtected() { sequence++; browsing = false; retainRecovery(); config = undefined; directory = undefined; jobs = []; result = ''; known = false; get('launch-name').value = ''; renderDirectory(); }
    return { poll, updateAuth: render, clearProtected };
  })();
`;
//#endregion
//#region hub/runtime-portal.ts
/** Browser source injected into the trusted management portal script. */
var runtimePortalJs = String.raw`
  const runtimeUpdates = (() => {
    const storageKey = 'pi-hub-runtime-update';
    const terminalStatuses = new Set(['succeeded', 'failed', 'recovery_required', 'rejected', 'stale']);
    const activeStatuses = new Set(['pending', 'queued', 'running']);
    const jobs = new Map();
    let policy;
    let pending;
    let uncertain = false;
    let polling;
    let submitting = false;
    let catalogState;
    let catalogVersions = [];
    let nextCursor;
    let selectedVersion;
    let readinessState;
    let catalogLoading = false;
    let readinessLoading = false;
    let catalogSequence = 0;
    let readinessSequence = 0;
    const stableVersion = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
    const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
    function directionLabel(version) {
      const installed = readinessState?.status !== 'unavailable' && readinessState?.installed_version;
      if (!stableVersion(installed) || !stableVersion(version)) return '更新方向未知（共享已安装版本不可用）';
      const current = installed.split('.').map(BigInt);
      const target = version.split('.').map(BigInt);
      let direction = '同版本更新';
      for (let i = 0; i < 3; i++) {
        if (target[i] === current[i]) continue;
        direction = target[i] > current[i] ? '升级' : '降级';
        break;
      }
      return direction + '：共享 Pi ' + installed + ' → ' + version +
        (direction === '降级' ? '。停止原进程前必须通过会话兼容性验证；不兼容时保留原进程与历史。' : '。');
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && validId(saved.id) && stableVersion(saved.version)) pending = { id: saved.id, version: saved.version };
    } catch {}
    function configured() { return auth.runtimeUpdatesAvailable === true; }
    function savePending() {
      try {
        if (pending) {
          const value = JSON.stringify({ id: pending.id, version: pending.version });
          sessionStorage.setItem(storageKey, value);
          return sessionStorage.getItem(storageKey) === value;
        }
        sessionStorage.removeItem(storageKey);
        return sessionStorage.getItem(storageKey) === null;
      } catch { return false; }
    }
    function clearPending() { pending = undefined; uncertain = false; savePending(); }
    function isJob(value) {
      return value && validId(value.id) && stableVersion(value.version) && typeof value.status === 'string' && typeof value.stage === 'string' && Array.isArray(value.targets);
    }
    function remember(value) {
      if (!isJob(value)) return;
      jobs.set(value.id, value);
      if (pending?.id === value.id && terminalStatuses.has(value.status)) clearPending();
    }
    const stageLabel = (stage) => ({
      awaiting_approval: '等待宿主机审批', queued_by_policy: '按策略排队', approved_by_host: '宿主机已批准', policy_changed: '策略已变更',
      resolving: '正在解析已发布候选版本', validating: '正在隔离验证；在线进程尚未改变',
      preparing: '准备安装', prepared: '安装准备完成', activating: '正在激活新版本', refreshing: '正在刷新受管 Pi 进程',
      waiting_for_idle: '等待忙碌目标空闲', waiting_for_consumer_readiness: '等待共享运行时使用者就绪',
      unmanaged_or_unavailable_consumer: '存在未受管或不可用的共享运行时使用者，需要迁移或检查',
      install_failed: '安装失败', installation_outcome_unknown: '安装结果不确定，需要管理员检查',
      refresh_requires_inspection: '刷新结果需要管理员检查', incompatible_candidate: '候选版本不兼容',
      restore_pre_stop_failed: '会话恢复验证未通过；原进程未停止',
      incompatible_session: '当前会话不兼容', candidate_changed: '候选包内容已变化，需要重新解析并审批',
      protocol_unavailable: '运行时刷新协议不可用', complete: '任务已完成',
    })[stage] || String(stage || 'unknown').replaceAll('_', ' ');
    const statusLabel = (status) => ({
      pending: '等待处理', queued: '已排队', running: '任务进行中', succeeded: '安装成功；所有受管 Pi 进程已刷新或退出', failed: '安装失败',
      recovery_required: '结果不确定，需要管理员检查', rejected: '任务已拒绝', stale: '任务已过期',
    })[status] || '结果未知';
    const targetLabel = (status) => ({
      waiting_for_idle: '等待目标空闲', refreshing: '正在刷新 Pi 进程', succeeded: '已加载新版本', exited: '已退出',
      validating_source: '正在核验新进程', blocked: '已阻止刷新',
    })[status] || String(status || 'unknown').replaceAll('_', ' ');
    const reasonLabel = (reason) => ({
      consumer_not_ready: '共享运行时使用者尚未就绪', awaiting_state_change: '等待运行状态变化', busy_race: '空闲确认期间再次忙碌',
      busy_waits_for_idle: '正在生成；允许提交，执行时等待空闲',
      target_source_validation: '正在完成实际运行内容的兼容性验证',
      restore_pre_stop_failed: '会话恢复验证未通过；原进程未停止',
      protocol_unavailable: '运行时刷新协议不可用', legacy_supervisor: '旧版监管协议，需要迁移后才能受管',
      incompatible_candidate: '候选版本不兼容', incompatible_session: '当前会话不兼容', candidate_changed: '候选包内容已变化',
    })[reason] || String(reason || '').replaceAll('_', ' ');
    function renderJob(value) {
      const row = document.createElement('div'); row.className = 'runtime-update-result';
      const heading = document.createElement('p'); heading.className = 'runtime-update-heading';
      heading.textContent = 'Pi ' + value.version + ' · ' + statusLabel(value.status);
      const identity = document.createElement('p'); identity.className = 'runtime-update-identity'; identity.textContent = '任务编号：' + value.id;
      const stage = document.createElement('p'); stage.textContent = '阶段：' + stageLabel(value.stage);
      row.append(heading, identity, stage);
      if (value.status === 'pending' && policy?.mode === 'manual') {
        const approval = document.createElement('p'); approval.textContent = auth.gateManagementAvailable ? '手动策略：请在上方「统一授权中心」核对并批准此任务。' : '手动策略：请在主机使用 runtime-approve ' + value.id + ' 批准；统一授权中心尚未配置。'; row.append(approval);
      }
      if (value.status === 'recovery_required' && value.resolved !== true) {
        const unresolved = document.createElement('p'); unresolved.textContent = '此结果尚未解决，将阻止新的运行时更新任务；需要管理员检查并在 Gate 侧解决，本页面不会自动解决。'; row.append(unresolved);
      }
      const visibleTargets = [];
      for (const target of value.targets) if (target?.status !== 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      for (const target of value.targets) if (target?.status === 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      if (value.targets.length > 128) {
        const limit = document.createElement('p'); limit.textContent = '共' + value.targets.length + '个目标记录，仅显示前128条'; row.append(limit);
      }
      for (const target of visibleTargets) {
        if (!target || !validId(target.run_id) || typeof target.status !== 'string') continue;
        const line = document.createElement('p'); line.className = 'runtime-update-target';
        let text = '目标 ' + target.run_id + ' · ' + targetLabel(target.status);
        if (typeof target.old_version === 'string') text += ' · 原版本 ' + target.old_version;
        if (typeof target.version === 'string') text += ' · 当前版本 ' + target.version;
        if (['waiting_for_idle', 'validating_source', 'blocked'].includes(target.status) && typeof target.wait_reason === 'string') text += ' · ' + reasonLabel(target.wait_reason);
        line.textContent = text; row.append(line);
      }
      return row;
    }
    function validCatalog(value) {
      return value && ['fresh', 'stale', 'unavailable'].includes(value.status) && Array.isArray(value.versions) && value.versions.length <= 50 && value.versions.every((entry) => entry && stableVersion(entry.version)) && (value.next_cursor === undefined || (typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length <= 256));
    }
    function validReadiness(value) {
      return value && ['ready', 'blocked', 'unavailable'].includes(value.status) && Array.isArray(value.consumers) && value.consumers.length <= 128 && value.consumers.every((consumer) => consumer && validId(consumer.run_id) && typeof consumer.ready === 'boolean' && (consumer.version === undefined || stableVersion(consumer.version)) && (consumer.reason === undefined || /^[a-z_]{1,64}$/.test(consumer.reason))) && (value.installed_version === undefined || stableVersion(value.installed_version));
    }
    function renderCatalog() {
      const status = get('runtime-version-catalog-status');
      const list = get('runtime-version-list');
      const selected = get('runtime-version-selected');
      const more = get('runtime-version-more');
      list.replaceChildren(); more.hidden = true;
      if (!configured()) status.textContent = '发布版本目录未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可查看官方发布版本目录';
      else if (catalogLoading) status.textContent = '正在查询官方发布版本目录…';
      else if (!catalogState) status.textContent = '尚未查询官方发布版本目录';
      else if (catalogState.status === 'unavailable') status.textContent = '官方发布版本目录暂时不可用；这与 Gate 更新策略禁用不同。';
      else if (catalogState.status === 'stale') status.textContent = '正在显示陈旧缓存目录；可浏览，但提交时 Gate 仍会重新检查精确版本与完整性。';
      else status.textContent = '官方发布版本目录已刷新；发布不代表已经验证兼容。';
      if (auth.authorized && catalogState?.checked_at) status.textContent += ' 检查时间：' + new Date(catalogState.checked_at).toLocaleString();
      if (!auth.authorized || !configured()) {
        selected.textContent = '';
        return;
      }
      for (const version of catalogVersions) {
        const option = document.createElement('button'); option.type = 'button';
        option.className = 'runtime-version-option' + (selectedVersion === version ? ' selected' : '');
        option.textContent = 'Pi ' + version + ' · 已发布 / 未验证';
        option.addEventListener('click', () => { selectedVersion = version; get('runtime-update-version').value = version; render(); });
        list.append(option);
      }
      more.hidden = !nextCursor || catalogLoading;
      if (selectedVersion) selected.textContent = '已选择 Pi ' + selectedVersion + ' · 已发布 / 未验证。' + directionLabel(selectedVersion) + '兼容性仍未知；Gate 会在提交后隔离验证，当前在线进程不会因选择而改变。';
      else selected.textContent = catalogState?.status === 'unavailable' ? '目录不可用，当前没有可提交的发布版本。' : '请选择一个已发布的精确稳定版本。';
    }
    function renderReadiness() {
      const node = get('runtime-readiness'); node.replaceChildren();
      if (!configured() || !auth.authorized) return;
      const summary = document.createElement('p');
      if (readinessLoading) summary.textContent = '正在查询当前共享运行时与受管进程就绪状态…';
      else if (!readinessState || readinessState.status === 'unavailable') summary.textContent = '当前运行时就绪状态不可用；这不表示兼容或已获授权。';
      else {
        const installed = readinessState.installed_version ? 'Pi ' + readinessState.installed_version : '未知';
        summary.textContent = '当前共享已安装版本：' + installed + ' · ' + (readinessState.status === 'ready' ? '所有已报告使用者当前就绪' : '存在阻止项；Gate 会在执行时重新清点');
      }
      node.append(summary);
      for (const consumer of readinessState?.consumers || []) {
        const line = document.createElement('p'); line.className = 'runtime-readiness-consumer';
        line.textContent = '使用者 ' + consumer.run_id + ' · Pi ' + (consumer.version || '未知') + ' · ' + (consumer.ready ? '当前就绪' : '阻止 / 未就绪') + (consumer.reason ? ' · ' + reasonLabel(consumer.reason) : '');
        node.append(line);
      }
    }
    function render() {
      const status = get('runtime-update-status');
      const policyNode = get('runtime-update-policy');
      const results = get('runtime-update-results');
      const query = get('runtime-update-query');
      results.replaceChildren(); query.hidden = true;
      if (!configured()) status.textContent = '运行时更新未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可提交运行时更新';
      else if (!policy) status.textContent = '正在查询运行时更新策略';
      else if (policy.mode === 'disabled') status.textContent = '运行时更新策略已禁用';
      else status.textContent = '运行时更新已就绪';
      policyNode.textContent = !policy ? '' : policy.mode === 'manual' ? '策略：手动审批（manual）' : policy.mode === 'auto' ? '策略：自动执行（auto）' : '策略：已禁用（disabled）';
      renderCatalog(); renderReadiness();
      if (!auth.authorized) {
        policyNode.textContent = '';
        get('runtime-update-submit').disabled = true;
        return;
      }
      for (const value of jobs.values()) results.append(renderJob(value));
      if (pending && !jobs.has(pending.id)) {
        const unknown = document.createElement('div'); unknown.className = 'runtime-update-result';
        const summary = document.createElement('p'); summary.textContent = 'Pi ' + pending.version + ' · 结果不确定，尚未找到任务；不会重新提交。';
        const identity = document.createElement('p'); identity.textContent = '任务编号：' + pending.id; unknown.append(summary, identity); results.append(unknown);
        query.hidden = !uncertain;
      }
      const active = [...jobs.values()].some((value) => activeStatuses.has(value.status) || (value.status === 'recovery_required' && value.resolved !== true));
      const exactSelection = stableVersion(selectedVersion) && get('runtime-update-version').value.trim() === selectedVersion;
      get('runtime-update-submit').disabled = authTransition || !configured() || !policy || policy.mode === 'disabled' || catalogState?.status === 'unavailable' || readinessState?.status !== 'ready' || !exactSelection || active || !!pending || submitting;
    }
    async function lookupPending() {
      if (!pending || !auth.authorized || !configured()) return;
      const generation = authGeneration;
      const identity = pending;
      try {
        const result = await api('runtime-updates/' + identity.id);
        if (generation !== authGeneration || pending !== identity) return;
        if (isJob(result) && result.id === identity.id && result.version === identity.version) { uncertain = false; remember(result); }
        else { uncertain = true; notice('任务查询响应不完整；将保留原任务编号继续查询，不会重新提交。'); }
      } catch (error) {
        if (generation !== authGeneration || pending !== identity) return;
        uncertain = true;
        if (error.status !== 404) notice('暂时无法确认运行时更新任务；请保留任务编号并稍后按原编号查询。');
      }
      render();
    }
    async function refreshCatalog(reset) {
      if (!auth.authorized || !configured()) return;
      const query = get('runtime-version-search').value.trim();
      if (query.length > 64 || !/^[0-9.]*$/.test(query)) {
        notice('版本搜索只接受最多 64 个数字或点。');
        return;
      }
      const cursor = reset ? '' : nextCursor || '';
      if (!reset && !cursor) return;
      const generation = authGeneration;
      const sequence = ++catalogSequence;
      catalogLoading = true; render();
      try {
        const result = await api('runtime-versions?query=' + encodeURIComponent(query) + '&cursor=' + encodeURIComponent(cursor));
        if (generation !== authGeneration || sequence !== catalogSequence) return;
        if (!validCatalog(result)) throw new Error('invalid catalog');
        catalogState = result;
        const versions = result.versions.map((entry) => entry.version);
        catalogVersions = reset ? versions : [...new Set([...catalogVersions, ...versions])].slice(-100);
        nextCursor = result.next_cursor;
        if (result.status === 'unavailable') {
          catalogVersions = [];
          selectedVersion = undefined;
          get('runtime-update-version').value = '';
        } else if (!selectedVersion && catalogVersions.length) {
          selectedVersion = catalogVersions[0];
          get('runtime-update-version').value = selectedVersion;
        }
      } catch (error) {
        if (generation !== authGeneration || sequence !== catalogSequence || error.stale) return;
        catalogState = { status: 'unavailable', versions: [] };
        catalogVersions = []; nextCursor = undefined; selectedVersion = undefined; get('runtime-update-version').value = '';
      } finally {
        if (generation === authGeneration && sequence === catalogSequence) { catalogLoading = false; render(); }
      }
    }
    async function refreshReadiness() {
      if (!auth.authorized || !configured()) return;
      const generation = authGeneration;
      const sequence = ++readinessSequence;
      readinessLoading = true; render();
      try {
        const result = await api('runtime-readiness');
        if (generation !== authGeneration || sequence !== readinessSequence) return;
        readinessState = validReadiness(result) ? result : { status: 'unavailable', consumers: [] };
      } catch (error) {
        if (generation !== authGeneration || sequence !== readinessSequence || error.stale) return;
        readinessState = { status: 'unavailable', consumers: [] };
      } finally {
        if (generation === authGeneration && sequence === readinessSequence) { readinessLoading = false; render(); }
      }
    }
    async function poll() {
      const generation = authGeneration;
      if (polling === generation || !auth.authorized || !configured()) return;
      polling = generation;
      try {
        const result = await api('runtime-updates');
        if (generation !== authGeneration) return;
        policy = result?.policy && ['manual', 'auto', 'disabled'].includes(result.policy.mode) ? { mode: result.policy.mode } : undefined;
        jobs.clear();
        for (const value of [...(Array.isArray(result?.jobs) ? result.jobs : []), ...(Array.isArray(result?.active) ? result.active : [])].slice(0, 128)) remember(value);
        if (pending && !jobs.has(pending.id)) await lookupPending();
        if (!catalogState) await refreshCatalog(true);
        await refreshReadiness();
      } catch { if (generation === authGeneration) notice('暂时无法查询运行时更新状态。'); }
      finally { if (polling === generation) polling = undefined; if (generation === authGeneration) render(); }
    }
    get('runtime-update-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (get('runtime-update-submit').disabled) return;
      const version = get('runtime-update-version').value.trim();
      if (!stableVersion(version)) { notice('请输入精确稳定版本，例如 1.3.0；不接受 latest、范围、预发布版或构建标记。'); return; }
      if (version !== selectedVersion) { notice('请先从官方发布目录选择要提交的精确稳定版本。'); return; }
      const manual = policy?.mode === 'manual' ? (auth.gateManagementAvailable ? '\n当前是手动策略；提交后请在统一授权中心审阅并批准。' : '\n当前是手动策略；提交后仍需主机管理员使用 runtime-approve 批准。') : '';
      const blockers = (readinessState?.consumers || []).filter((consumer) => !consumer.ready).slice(0, 5);
      const blockerText = blockers.length ? '\n当前已知阻止项（执行时 Gate 会重新清点）：\n' + blockers.map((consumer) => consumer.run_id + ' · ' + reasonLabel(consumer.reason || 'consumer_not_ready')).join('\n') : '';
      if (!window.confirm('确认向 Gate 提交 Pi ' + version + ' 的全局运行时更新任务？\n' + directionLabel(version) + '\n该版本已发布，但兼容性尚未验证；Gate 将先进行隔离验证，选择本身不会改变在线进程。\n这会影响所有共享运行时使用者；忙碌目标会等待空闲，不会被强制中断。\n旧镜像中的使用者需要先迁移到受管运行环境。\n本页面只创建任务，不批准更新。' + blockerText + manual)) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
      pending = { id, version }; uncertain = true; submitting = true;
      if (!savePending()) {
        pending = undefined; uncertain = false; submitting = false;
        notice('未提交运行时更新：浏览器会话存储无法保存任务编号，请恢复存储后重试。'); render(); return;
      }
      render();
      const generation = authGeneration;
      try {
        const result = await api('runtime-updates', { version, idempotencyKey: id });
        if (generation !== authGeneration) return;
        if (isJob(result) && result.id === id && result.version === version) {
          uncertain = false; remember(result); notice('运行时更新任务已提交。请按任务编号监控安装与空闲等待。');
        } else {
          uncertain = true; notice('提交响应不完整，将按原任务编号查询；不会自动再次提交。');
        }
      } catch (error) {
        if (generation !== authGeneration) return;
        if (error.status === 400) { clearPending(); notice('精确稳定版本无效或请求参数被拒绝；请刷新官方发布目录后重新选择。'); }
        else if (error.status === 409) { clearPending(); notice('Gate 正在处理其他任务，或运行时更新策略已禁用。'); }
        else notice('未收到确定的提交结果，将按原任务编号查询；不会自动再次提交。');
      } finally {
        submitting = false; render();
        if (generation === authGeneration) {
          if (pending && uncertain) await lookupPending();
          else if (!pending) await poll();
        }
      }
    });
    get('runtime-update-query').addEventListener('click', async () => { await lookupPending(); });
    get('runtime-version-search').addEventListener('input', async () => { await refreshCatalog(true); });
    get('runtime-version-refresh').addEventListener('click', async () => { await refreshCatalog(true); await refreshReadiness(); });
    get('runtime-version-more').addEventListener('click', async () => { await refreshCatalog(false); });
    function updateAuth() { render(); }
    function clearProtected() {
      jobs.clear(); policy = undefined; catalogState = undefined; catalogVersions = []; nextCursor = undefined; selectedVersion = undefined; readinessState = undefined; catalogLoading = false; readinessLoading = false; catalogSequence++; readinessSequence++; get('runtime-update-version').value = ''; render();
    }
    return { updateAuth, clearProtected, poll };
  })();
`;
//#endregion
//#region hub/portal.ts
init_hub_generation();
var portalHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · 会话总览</title><link rel="stylesheet" href="/hub.css"><script src="/hub-management.js" defer><\/script><script src="/hub.js" defer><\/script></head>
<body><main><header><a class="brand" href="/sessions/" aria-label="Pi 会话首页"><span class="logo">π</span> Pi Web <span class="tag">HUB</span></a><span id="health" role="status">正在连接</span></header>
<section class="intro"><span class="eyebrow">你的工作，随时接续</span><h1>所有会话，一个入口。</h1><p>选择正在运行的 Pi，在手机与电脑之间继续工作。</p></section>
<section class="version-overview" aria-labelledby="versions-title"><div class="version-heading"><div><span class="eyebrow">SOFTWARE STATUS</span><h2 id="versions-title">版本与更新</h2></div><span id="version-summary" role="status">正在检查发布版本</span></div><div id="version-details" class="version-details"></div><p class="version-help">仅检查 Pi 与本 Web 扩展的公开发布版本，不自动安装或重启。会话版本为进程上报值，不等于磁盘已安装版本。构建不同不一定代表落后；其他扩展不在本次检查范围。</p></section>
<details class="management"><summary>运行管理 <span id="management-status" role="status">正在检查能力</span></summary><p>管理操作需要身份验证。重启只刷新选中的空闲 Pi；全局运行时更新由 Gate 评估精确稳定版本，两项操作彼此独立。</p><p id="management-help">正在检查管理登录方式…</p><form id="management-unlock" hidden><label for="management-code">一次性管理码</label><div class="controls"><input id="management-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" placeholder="输入 32 位管理码" required><button type="submit">解锁管理</button></div></form><button id="management-gateway" type="button" hidden>使用网页登录解锁</button><button id="management-logout" type="button" hidden>锁定管理</button><p id="management-notice" role="status" aria-live="polite"></p>${launchPortalHtml}${approvalsPortalHtml}<section class="runtime-updates" aria-labelledby="runtime-update-title"><div class="runtime-update-heading"><h3 id="runtime-update-title">全局 Pi 运行时更新</h3><span id="runtime-update-status" role="status">正在检查能力</span></div><p>从官方发布目录选择精确稳定版本。目录只证明版本已发布，不代表兼容；Gate 会在提交后重新解析并隔离验证。此处创建更新任务；审批请使用上方统一授权中心。网页不会重建 Docker 镜像。</p><p id="runtime-update-policy"></p><div class="runtime-version-tools"><label for="runtime-version-search">搜索发布版本前缀</label><div class="controls"><input id="runtime-version-search" type="search" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="64" pattern="[0-9.]*" placeholder="例如 1.4"><button id="runtime-version-refresh" type="button">刷新目录与就绪状态</button></div></div><p id="runtime-version-catalog-status" role="status"></p><div id="runtime-version-list" class="runtime-version-list" role="listbox" aria-label="官方发布的稳定 Pi 版本"></div><button id="runtime-version-more" type="button" hidden>加载更早版本</button><p id="runtime-version-selected" class="runtime-version-selected"></p><div id="runtime-readiness" class="runtime-readiness" aria-live="polite"></div><form id="runtime-update-form"><label for="runtime-update-version">已选择的精确稳定版本</label><div class="controls"><input id="runtime-update-version" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="64" readonly required><button id="runtime-update-submit" type="submit" disabled>提交给 Gate</button></div></form><button id="runtime-update-query" type="button" hidden>按原任务编号查询</button><div id="runtime-update-results" aria-live="polite"></div></section><section class="restart-results" aria-label="进程重启结果"><div id="management-results" aria-live="polite"></div></section></details>
<section class="toolbar" aria-label="会话操作"><div><h2>在线会话 <span id="count">0</span></h2><p id="updated">等待登记</p></div><div class="controls"><label><span class="sr-only">搜索会话</span><input id="search" type="search" placeholder="搜索项目或会话…"></label><a id="new-pi-entry" class="open" href="#new-pi">新建 Pi</a><button id="refresh" type="button">刷新</button></div></section>
<div id="notice" role="status"></div><section id="sessions" class="grid" aria-label="在线 Pi 会话"></section>
<section id="empty" class="empty" hidden><span class="empty-icon">π</span><h3>还没有在线会话</h3><p>为 Pi 配置本总管的登记 socket 和独立凭据。<br>已启动的会话会自动出现在这里。</p></section>
<footer><span>每个会话独立连接 · 退出一个不影响其他会话</span><span>Pi Web Hub</span></footer></main></body></html>`;
function renderPortalHtml(admin, chatUrl, managementUrl, managerLinks) {
	const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[c] ?? c);
	const loopback = (value) => {
		try {
			return [
				"localhost",
				"127.0.0.1",
				"[::1]"
			].includes(new URL(value).hostname);
		} catch {
			return false;
		}
	};
	const administratorLabel = managerLinks?.administrator && loopback(managerLinks.administrator) && !loopback(managerLinks.requester) ? "打开管理员入口（仅本机可用） ↗" : "打开管理员入口 ↗";
	if (admin) return portalHtml.replace("<head>", `<head><meta name="pi-chat-origin" content="${escapeHtml(chatUrl)}">`);
	return portalHtml.replace("<a id=\"new-pi-entry\" class=\"open\" href=\"#new-pi\">新建 Pi</a>", managerLinks ? `<a id="new-pi-entry" class="open" href="${escapeHtml(managerLinks.requester)}" rel="noopener noreferrer">新建 Pi ↗</a>` : managementUrl ? `<a class="open" href="${escapeHtml(managementUrl)}sessions/#new-pi" rel="noopener noreferrer">新建 Pi ↗</a>` : "").replace("<script src=\"/hub-management.js\" defer><\/script>", "").replace(/<details class="management">[\s\S]*?<\/details>/, managerLinks?.administrator ? `<p class="management"><a id="manager-admin-entry" href="${escapeHtml(managerLinks.administrator)}" rel="noopener noreferrer">${administratorLabel}</a></p>` : managerLinks ? "" : managementUrl ? `<p class="management"><a href="${escapeHtml(managementUrl)}sessions/" rel="noopener noreferrer">打开运行管理 ↗</a></p>` : "");
}
var portalJs = `(() => {
  const get = (id) => document.getElementById(id);
  let items = [];
  let versions = { status: 'checking' };
  let loading = false;
  let refreshAgain = false;
  let lastRender = '';
  let navigationTimer;
  const resetNavigation = () => {
    clearTimeout(navigationTimer);
    for (const link of document.querySelectorAll('.open[aria-busy]')) {
      link.removeAttribute('aria-busy'); link.textContent = '打开会话 ↗';
    }
  };
  // Legacy launchers append a short run ID to the grant's project label.
  // Display-only: keep the original API label and capability route untouched.
  const projectLabel = (label) => label.replace(/ · [a-f0-9]{8}$/i, '').trim() || label;
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const semver = (version) => {
    if (typeof version !== 'string' || version.length > 64 || !/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/.test(version)) return null;
    const parts = version.split('+')[0].split('.').map(Number); return parts.every(Number.isSafeInteger) ? parts : null;
  };
  function comparison(current, target, build) {
    if (!current) return { tone: 'unknown', text: '版本未上报' };
    if (!target) return { tone: 'unknown', text: '更新状态未知' };
    const a = semver(current.version); const b = semver(target.version);
    if (!a || !b) return { tone: 'unknown', text: '版本无法比较' };
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) return { tone: 'update', text: '可更新至 ' + target.version };
      if (a[i] > b[i]) return { tone: 'different', text: '高于发布版本' };
    }
    if (build) {
      if (!current.build || !target.build) return { tone: 'unknown', text: '构建未上报 · 无法确认一致' };
      if (current.build !== target.build) return { tone: 'different', text: '与发布构建不同' };
    }
    return { tone: 'current', text: '与发布版本一致' };
  }
  function versionLine(label, current, target, build) {
    const line = element('span', 'version-line', '');
    line.append(element('span', 'version-label', label));
    const value = element('span', 'version-value', current?.version || '未上报');
    if (current?.build) { value.textContent += ' · ' + current.build.slice(0, 8); value.title = '构建 SHA-256：' + current.build; }
    const result = label === 'Manager' && current && !target
      ? { tone: 'unknown', text: '发布源未配置' }
      : comparison(current, target, build);
    const badge = element('span', 'version-badge ' + result.tone, result.text);
    if (result.tone === 'different') badge.title = '构建或版本不同不证明落后，可能来自本地修改、其他分支或较新开发版本。';
    else if (result.tone === 'update') badge.title = label === 'Pi' ? '检测到较新的公开稳定版本；安装和进程刷新仍需独立的更新流程。' : '检测到较新的包版本；更新安装不代表运行中的扩展或 Hub 已重新加载。';
    line.append(value, badge);
    return line;
  }
  function renderVersions() {
    const known = versions.status === 'ok' || versions.status === 'partial';
    const targetPi = known ? versions.pi : undefined;
    const targetWeb = known ? versions.webUi : undefined;
    let updates = 0; let differences = 0;
    for (const session of items) {
      const pi = session.software?.piVersion || session.runtime?.version;
      const states = [comparison(pi ? { version: pi } : undefined, targetPi, false), comparison(session.software?.webUi, targetWeb, true)];
      if (states.some((s) => s.tone === 'update')) updates++;
      if (states.some((s) => s.tone === 'different')) differences++;
    }
    let status = versions.status === 'checking' ? '正在检查发布版本' : !known ? '发布检查不可用 · 更新状态未知' : versions.status === 'partial' ? '部分发布信息不可用' : '已检查公开发布版本';
    if (updates) status += ' · ' + updates + ' 个会话可更新';
    if (differences) status += ' · ' + differences + ' 个会话存在版本差异';
    const summary = get('version-summary'); summary.textContent = status;
    summary.className = 'version-summary' + (updates ? ' has-update' : '');
    const details = get('version-details'); details.replaceChildren();
    details.append(versionLine('Manager', versions.hub, undefined, true));
    details.append(element('span', 'release-target', '公开发布：Pi ' + (targetPi?.version || '未知') + ' / Web 扩展 ' + (targetWeb?.version || '未知') + (targetWeb?.build ? ' · ' + targetWeb.build.slice(0, 8) : '')));
    if (versions.checkedAt) details.append(element('span', 'release-target', '检查时间：' + new Date(versions.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · 发布检查最多每 5 分钟一次'));
  }
  function render() {
    const query = get('search').value.toLocaleLowerCase();
    const visible = items.filter((s) => projectLabel(s.label).toLocaleLowerCase().includes(query) || (s.sessionName || '未命名会话').toLocaleLowerCase().includes(query));
    get('notice').textContent = items.length && !visible.length ? '没有匹配的会话，请尝试其他关键词。' : '';
    const renderKey = JSON.stringify([items, query, versions]);
    if (renderKey === lastRender) return;
    lastRender = renderKey;
    renderVersions();
    get('sessions').replaceChildren();
    get('count').textContent = String(items.length);
    get('empty').hidden = items.length !== 0;
    for (const session of visible) {
      const card = document.createElement('article'); card.className = 'card';
      const top = document.createElement('div'); top.className = 'card-top';
      const icon = document.createElement('span'); icon.className = 'project-icon'; icon.textContent = '↗';
      const status = document.createElement('span'); status.className = 'online'; status.textContent = '在线';
      top.append(icon, status);
      const title = document.createElement('h3'); title.textContent = projectLabel(session.label); title.title = title.textContent;
      const meta = document.createElement('p'); meta.className = 'meta';
      const name = document.createElement('span'); name.className = 'session-name'; name.textContent = session.sessionName || '未命名会话'; name.title = name.textContent;
      const since = document.createElement('span'); since.textContent = ' · ' + new Date(session.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.append(name, since);
      const known = versions.status === 'ok' || versions.status === 'partial';
      const software = element('span', 'version-lines', '');
      const piVersion = session.software?.piVersion || session.runtime?.version;
      software.append(versionLine('Pi', piVersion ? { version: piVersion } : undefined, known ? versions.pi : undefined, false));
      software.append(versionLine('Web 扩展', session.software?.webUi, known ? versions.webUi : undefined, true));
      if (session.runtime?.managed) software.append(element('span', 'runtime-note', '受管运行 · 重启资格需另行检查'));
      meta.append(software);
      const link = document.createElement('a'); link.className = 'open'; link.href = session.path; link.textContent = '打开会话 ↗';
      link.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        resetNavigation(); link.textContent = '正在打开…'; link.setAttribute('aria-busy', 'true');
        navigationTimer = setTimeout(resetNavigation, 10000);
      });
      card.append(top, title, meta, link); window.piHubManagement?.attach(card, session); get('sessions').append(card);
    }
  }
  async function refresh(afterCurrent = false) {
    if (loading) { if (afterCurrent) refreshAgain = true; return; } loading = true; get('refresh').disabled = true;
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); items = data.sessions; versions = data.versions || { status: 'unavailable' }; render();
      get('health').textContent = '● 总管已连接'; get('health').className = 'connected';
      get('updated').textContent = '刚刚更新 · 每 5 秒自动刷新';
    } catch {
      // Do not leave stale sessions looking online when the hub is unavailable.
      items = []; versions = { status: 'unavailable' }; render(); get('health').textContent = '连接中断'; get('health').className = 'disconnected';
      get('notice').textContent = '暂时无法连接总管。请检查服务，或点击刷新重试。';
    } finally {
      loading = false; get('refresh').disabled = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }
  window.addEventListener('pagehide', () => clearTimeout(navigationTimer));
  window.addEventListener('pageshow', (event) => {
    resetNavigation();
    if (event.persisted) refresh(true);
  });
  get('search').addEventListener('input', render); get('refresh').addEventListener('click', () => refresh(true));
  window.addEventListener('pi-hub-management', () => { lastRender = ''; render(); });
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
})();`;
var portalManagementCss = `${launchPortalCss}${approvalsPortalCss}.management{border:1px solid #dce5d7;background:#ffffffa8;border-radius:14px;padding:16px 20px;margin:0 0 28px;font-size:13px;line-height:1.7}.management summary{cursor:pointer;font-weight:600}.management summary span{font-weight:400;color:#718076;margin-left:10px}.management p{color:#657768;margin:12px 0}.management form label,.runtime-version-tools label{display:block;margin-bottom:7px}.management .controls{flex-wrap:wrap}.management input{flex:1;max-width:360px;width:auto;min-width:0}.management button{min-height:42px}.management code{overflow-wrap:anywhere}.runtime-updates{border-top:1px solid #e1e7dd;margin-top:18px;padding-top:18px}.runtime-update-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.runtime-update-heading h3{font-size:14px;margin:0}.runtime-update-heading span,#runtime-update-policy,#runtime-version-catalog-status{color:#718076;font-size:12px}.runtime-version-tools{margin-top:16px}.runtime-version-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:10px 0}.runtime-version-option{min-height:48px;text-align:left;background:#f7faf5;color:#415447}.runtime-version-option.selected{border-color:#668363;background:#eaf2e5;color:#294b36}.runtime-version-selected,.runtime-readiness{border:1px solid #e1e7dd;border-radius:10px;padding:10px 12px;background:#fbfcfa}.runtime-readiness{margin:12px 0}.runtime-readiness p{margin:5px 0}.runtime-readiness-consumer{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}.runtime-update-result,.restart-result{border-top:1px solid #e1e7dd;padding:10px 0}.runtime-update-result p,.restart-result p{overflow-wrap:anywhere}.runtime-update-result .runtime-update-heading{color:#334c3d;font-weight:600}.runtime-update-identity,.runtime-update-target{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.runtime-update-target{padding-left:12px;border-left:3px solid #e4ebe0}.restart{display:block;width:100%;margin-top:10px;background:transparent;color:#64795e;font-size:12px}.restart-result .open{width:fit-content}#management-notice{color:#97613c}@media(max-width:600px){.management{padding:14px 16px}.management input{width:100%;flex-basis:100%;max-width:none}.management summary span{display:block;margin-left:0}.management .controls button{width:100%}.runtime-version-list{grid-template-columns:1fr}.runtime-version-option{width:100%}}`;
/** Separate trusted Hub script: never served by an individual Pi backend. */
var portalManagementJs = `(() => {
  const get = (id) => document.getElementById(id);
  get('new-pi-entry')?.addEventListener('click', () => { document.querySelector('details.management').open = true; });
  if (typeof location !== 'undefined' && location.hash === '#new-pi') document.querySelector('details.management').open = true;
  let auth = { available: false, authorized: false };
  let authGeneration = 0;
  let authTransition = false;
  const operations = new Map();
  let polling;
  const notice = (text) => { get('management-notice').textContent = text; };
  const changed = () => window.dispatchEvent(new Event('pi-hub-management'));
  async function api(route, value) {
    const generation = authGeneration;
    const current = () => { if (generation !== authGeneration) { const error = new Error('旧管理请求已失效'); error.stale = true; throw error; } };
    const response = await fetch('/api/management/' + route, { method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(7000),
      headers: { 'Content-Type': 'application/json', ...(auth.csrf ? { 'X-Pi-Hub-Csrf': auth.csrf } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
    current();
    if (!response.ok) {
      if (response.status === 401) { authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); }
      const error = new Error('管理请求未完成'); error.status = response.status; throw error;
    }
    const result = await response.json(); current(); return result;
  }
${runtimePortalJs}
${approvalsPortalJs}
${launchPortalJs}
  const restartAvailable = () => auth.restartAvailable ?? auth.available;
  function updateAuth() {
    get('management-status').textContent = authTransition ? '正在处理管理登录或锁定…' : !auth.available ? '未配置' : auth.authorized ? '已解锁 · 30 分钟有效' : '已锁定';
    const gateway = auth.authMode === 'gateway';
    get('management-unlock').hidden = gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').hidden = !gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').disabled = authTransition;
    get('management-code').disabled = authTransition;
    get('management-logout').hidden = !auth.authorized;
    get('management-logout').disabled = authTransition;
    get('management-help').textContent = !auth.available ? '本 Hub 尚未接入 Gate 管理能力。旧容器需使用新镜像重新启动一次，不能通过 /reload 获得受管能力。' : gateway ? '使用已验证的网页登录身份，无需管理码。管理会话 30 分钟有效；过期或锁定后可点击使用网页登录解锁。申请更新仍遵循 Gate 审批策略。' : '管理员在 Hub 的可信终端运行 pi-web-hub pair --config 配置文件，生成一次性管理码。管理授权与网页登录分开，过期后需重新解锁。';
    renderResults(); runtimeUpdates.updateAuth(); approvals.updateAuth(); launchPi.updateAuth();
    changed();
  }
  function save() {
    try { sessionStorage.setItem('pi-hub-restarts', JSON.stringify([...operations.values()].filter((o) => !o.done).map(({ id, generation, label }) => ({ id, generation, label })))); } catch {}
  }
  function renderResults() {
    get('management-results').replaceChildren();
    if (!auth.authorized) return;
    for (const op of operations.values()) {
      const row = document.createElement('div'); row.className = 'restart-result';
      const text = document.createElement('p');
      const labels = { pending: '等待管理员审批', queued: '已排队', running: '正在重启并核对原会话', succeeded: '已恢复原会话', failed: '失败，请检查后手动处理', recovery_required: '结果不确定，需要管理员检查', rejected: '已拒绝', stale: '身份或授权已变化' };
      text.textContent = op.label + ' · ' + (labels[op.status] || '结果未知，正在查询；不会重复执行') + (op.new_version ? ' · Pi ' + op.new_version : '');
      row.append(text);
      if (op.status === 'succeeded' && typeof op.path === 'string' && /^\\/s\\/${HUB_GENERATION_SOURCE}\\/$/.test(op.path)) {
        const link = document.createElement('a'); link.href = new URL(op.path, document.querySelector('meta[name="pi-chat-origin"]').content).href; link.className = 'open'; link.textContent = '打开恢复后的会话 ↗'; row.append(link);
      } else if (op.status === 'succeeded') {
        const unavailable = document.createElement('p'); unavailable.textContent = '重启已成功完成；当前恢复链接不可用（会话可能已继续、切换或退出）。请从在线会话列表选择当前会话。'; row.append(unavailable);
      }
      get('management-results').append(row);
    }
  }
  async function poll() {
    const generation = authGeneration;
    if (polling === generation || !auth.authorized || !restartAvailable()) return;
    polling = generation;
    try {
      for (const op of operations.values()) {
        if (op.done) continue;
        try {
          const result = await api('restarts/' + op.id);
          delete op.path;
          Object.assign(op, result);
          op.done = ['succeeded', 'failed', 'recovery_required', 'rejected', 'stale'].includes(op.status);
        } catch { if (generation !== authGeneration) return; op.status = 'unknown'; }
      }
      if (generation === authGeneration) { save(); renderResults(); }
    } finally { if (polling === generation) polling = undefined; }
  }
  window.piHubManagement = { attach(card, session) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'restart'; button.textContent = '重启 Pi · 应用已安装更新';
    button.disabled = !restartAvailable() || !auth.authorized || [...operations.values()].some((o) => o.generation === session.generation && !o.done);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      let submitted = false;
      try {
        const target = await api('targets/' + session.generation);
        if (!target.managed) {
          notice(target.reason === 'source_evidence_unavailable'
            ? '缺少与当前运行内容和执行环境匹配的 Gate 兼容性验证证据；请先通过全局运行时更新完成验证。原进程未停止。'
            : '此容器不支持进程重启，请先用新镜像重新启动一次。');
          return;
        }
        if (target.mode === 'disabled') { notice('门禁尚未启用该能力，需要管理员配置独立生命周期策略。'); return; }
        if (!target.idle || target.pending || target.busy) { notice('此会话正在工作，或终端/未知命令使本进程无法证明可安全重启。工作完成后仍不可用时，需要在本地启动新的 Pi 进程；等待、取消和 /reload 不会清除输入不确定性。'); return; }
        if (!window.confirm('确认重启选中的 Pi？\\n项目：' + session.label + '\\n会话：' + (session.sessionName || '未命名') + '\\n当前 Pi：' + target.version + '\\n将加载已安装版本并恢复原会话及分支。网页会短暂断开；不会更新其他会话。' + (target.mode === 'manual' ? '\\n门禁仍需管理员审批。' : ''))) return;
        if (operations.size >= 64) { notice('本页操作记录已满，请重新打开管理页。'); return; }
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');
        const op = { id, generation: session.generation, label: session.label, status: 'unknown', done: false };
        operations.set(id, op); save(); renderResults(); submitted = true;
        try { Object.assign(op, await api('restarts', { generation: session.generation, runtimeId: target.runtime_id, sessionId: target.session_id, leafId: target.leaf_id, idempotencyKey: id })); }
        catch { notice('未收到提交结果，将按原操作编号查询。不要重新点击重启。'); }
        renderResults();
      } catch { notice('无法确认目标或授权已过期，请刷新管理状态后重试。'); }
      finally { if (!submitted) button.disabled = !restartAvailable() || !auth.authorized; }
    });
    card.append(button);
  } };
  async function loginWithGateway() {
    if (authTransition || auth.authMode !== 'gateway' || !auth.available || auth.authorized) return;
    authTransition = true; updateAuth();
    try { const result = await api('gateway', {}); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('已使用网页登录身份解锁管理，无需管理码。'); void poll(); void runtimeUpdates.poll(); void approvals.poll(); void launchPi.poll(); }
    catch (error) { if (!error.stale) notice('无法验证网页登录身份，请重新登录管理入口后重试；不会自动提交更新。'); }
    finally { authTransition = false; updateAuth(); }
  }
  get('management-gateway').addEventListener('click', loginWithGateway);
  get('management-unlock').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (authTransition || auth.authMode === 'gateway') return;
    const input = get('management-code'); const code = input.value.trim(); input.value = '';
    authTransition = true; updateAuth();
    try { const result = await api('unlock', { code }); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('管理已解锁。可独立选择进程重启或全局运行时更新。'); void poll(); void runtimeUpdates.poll(); void approvals.poll(); void launchPi.poll(); }
    catch (error) { if (!error.stale) notice('管理码无效、已使用或过期，请从可信终端重新获取。'); }
    finally { authTransition = false; updateAuth(); }
  });
  get('management-logout').addEventListener('click', async () => {
    if (authTransition) return;
    authTransition = true; updateAuth();
    try { await api('logout', {}); authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('管理已锁定。已提交操作仍由门禁处理。'); }
    catch (error) { if (!error.stale) notice('锁定请求未完成，请关闭此页并让管理员撤销管理授权。'); }
    finally { authTransition = false; updateAuth(); }
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('pi-hub-restarts') || '[]');
    if (Array.isArray(saved)) for (const o of saved.slice(0, 64)) if (/^[a-f0-9]{32}$/.test(o.id) && /^${HUB_GENERATION_SOURCE}$/.test(o.generation) && typeof o.label === 'string' && o.label.length <= 256) operations.set(o.id, { id: o.id, generation: o.generation, label: o.label, done: false, status: 'unknown' });
  } catch {}
  void (async () => { try { auth = await api('status'); updateAuth(); if (auth.authMode === 'gateway') await loginWithGateway(); await poll(); await runtimeUpdates.poll(); await approvals.poll(); await launchPi.poll(); } catch { notice('无法查询运行管理能力。'); } })();
  setInterval(async () => { await poll(); await runtimeUpdates.poll(); await approvals.poll(); await launchPi.poll(); }, 2000);
})();`;
var portalCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#21312c;background:#f6f8f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e6efdf,transparent 55%)}main{max-width:1080px;margin:auto;padding:32px 40px 24px;min-height:100dvh}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:650;color:inherit;text-decoration:none}.logo{display:grid;place-items:center;border-radius:12px;background:#234c3c;color:#e8f3dd;width:42px;height:42px;font:32px Georgia,serif}.tag{font-size:10px;letter-spacing:2px;color:#758478;border:1px solid #d7dfd5;border-radius:5px;padding:4px 6px}#health{font-size:12px;color:#697c70}.connected{color:#347652!important}.disconnected{color:#a35437!important}.intro{padding:48px 0 34px}.eyebrow{font-size:12px;letter-spacing:2px;color:#718478}h1{margin:14px 0 16px;font-size:clamp(30px,4vw,46px);font-weight:600;letter-spacing:-1.5px}.intro p{margin:0;color:#718076;font-size:15px;line-height:1.8}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}h2{font-size:17px;font-weight:600;margin:0}#count{display:inline-grid;place-items:center;min-width:25px;height:23px;margin-left:8px;background:#e2ebe0;border-radius:7px;color:#476347;font-size:12px}#updated{font-size:12px;color:#879287;margin:8px 0 0}.controls{display:flex;gap:10px}input,button{font:inherit;border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:11px 14px;font-size:13px;color:#415447}input{width:230px}button{cursor:pointer}button:hover{background:#eef3eb}button:disabled{opacity:.55}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #93ad91;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card{display:flex;flex-direction:column;background:#ffffffdc;border:1px solid #e0e7dc;border-radius:16px;padding:24px;box-shadow:0 6px 24px #29412c04;min-width:0}.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.project-icon{display:grid;place-items:center;width:40px;height:40px;background:#edf3e8;color:#587452;border-radius:11px;font-size:23px}.online{font-size:11px;color:#39734e;background:#eff5eb;border-radius:20px;padding:5px 10px}.online:before{content:'●';font-size:8px;margin-right:5px}.card h3{font-size:18px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:#899587;margin:10px 0 20px;display:flex;flex-wrap:wrap;min-width:0;align-items:baseline}.session-name{max-width:calc(100% - 52px);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card>.open{margin-top:auto}.meta>span:nth-child(2){flex-shrink:0}.version-lines{display:flex;flex-direction:column;gap:9px;flex-basis:100%;min-width:0;margin-top:18px;padding-top:16px;border-top:1px solid #edf0e9}.version-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0;line-height:1.65}.version-label{font-weight:600;color:#64765f;min-width:48px}.version-value{color:#415447;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}.version-badge{border-radius:6px;padding:2px 7px;font-size:10px;line-height:1.6;overflow-wrap:anywhere}.version-badge.current{color:#356044;background:#edf4e9}.version-badge.update{color:#8a531d;background:#fff1d7}.version-badge.different{color:#805d2f;background:#f6efe0}.version-badge.unknown{color:#778174;background:#f1f3ef}.runtime-note{font-size:10px;color:#879180}.version-overview{border:1px solid #dce5d7;border-radius:16px;padding:22px 24px;background:#ffffffa8;margin-bottom:20px}.version-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.version-heading .eyebrow{font-size:9px;letter-spacing:1.5px}.version-heading h2{margin-top:6px}.version-summary{font-size:12px;color:#72816e;line-height:1.8}.version-summary.has-update{color:#8a531d}.version-details{display:flex;flex-direction:column;gap:10px;margin-top:18px;font-size:12px}.release-target{color:#7c8975;font-size:11px;line-height:1.8;overflow-wrap:anywhere}.version-help{font-size:11px;color:#7c8975;line-height:1.8;margin:14px 0 0;padding-top:12px;border-top:1px solid #e8eee3}.open{display:block;text-align:center;color:#365b42;background:#f2f6ee;border:1px solid #e4ebdf;text-decoration:none;border-radius:8px;padding:11px;font-size:13px}.open:hover{background:#e7efdf}.empty{text-align:center;border:1px dashed #d6dfd0;border-radius:16px;padding:55px 20px;background:#ffffff70}.empty-icon{font:44px Georgia,serif;color:#8a9e82}.empty h3{font-size:17px;font-weight:500;margin:18px 0 10px}.empty p{font-size:13px;color:#7a8978;line-height:1.9}#notice{font-size:13px;color:#a35c3d;line-height:1.6;margin-bottom:14px}#notice:empty{display:none}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid #e0e6db;margin-top:48px;padding-top:20px;font-size:11px;color:#96a18f}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:600px){main{padding:24px 20px}header{gap:8px}.brand{font-size:17px;gap:8px}.logo{width:36px;height:36px;font-size:27px}#health{font-size:11px}.intro{padding:48px 0 34px}h1{letter-spacing:-1px;line-height:1.35}.toolbar{flex-direction:column;align-items:stretch;gap:18px}.controls label{flex:1;min-width:0}input{width:100%;min-width:0}.grid{grid-template-columns:1fr}.card{padding:22px}.card-top{margin-bottom:18px}footer{flex-direction:column;margin-top:32px;line-height:1.6}}`;
//#endregion
//#region hub/runtime-updates.ts
init_config();
init_lifecycle();
var runtimeVersion = (value) => typeof value === "string" && value.length <= 64 && value.trim() === value && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
var hex$1 = (value) => typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
var word = (value) => typeof value === "string" && value.trim() === value && /^[a-z_]{1,64}$/.test(value);
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var catalogQuery = (value) => typeof value === "string" && value.length <= 64 && /^[0-9.]*$/.test(value);
var catalogCursor = (value) => typeof value === "string" && value.length <= 256 && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
var states = [
	"pending",
	"queued",
	"running",
	"succeeded",
	"failed",
	"recovery_required",
	"rejected",
	"stale"
];
/** A bounded error category, never the upstream response body or credential. */
var RuntimeUpdateError = class extends Error {
	status;
	constructor(status = 503) {
		super("Runtime update provider unavailable or outcome unknown");
		this.status = status;
	}
};
function job(value) {
	if (!object(value) || !hex$1(value.id) || !runtimeVersion(value.version) || !states.includes(value.status) || !word(value.stage) || !Array.isArray(value.targets)) throw new RuntimeUpdateError();
	const targets = value.targets.map((target) => {
		if (!object(target) || !hex$1(target.run_id) || !word(target.status)) throw new RuntimeUpdateError();
		const result = {
			run_id: target.run_id,
			status: target.status
		};
		for (const key of ["old_version", "version"]) if (target[key] !== void 0) {
			if (!runtimeVersion(target[key])) throw new RuntimeUpdateError();
			result[key] = target[key];
		}
		if (target.wait_reason !== void 0) {
			if (!word(target.wait_reason)) throw new RuntimeUpdateError();
			result.wait_reason = target.wait_reason;
		}
		return result;
	});
	const result = {
		id: value.id,
		version: value.version,
		status: value.status,
		stage: value.stage,
		targets
	};
	for (const key of ["created_at", "resolved_at"]) if (value[key] !== void 0) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) throw new RuntimeUpdateError();
		result[key] = Number(value[key]);
	}
	if (value.resolved !== void 0) {
		if (typeof value.resolved !== "boolean") throw new RuntimeUpdateError();
		result.resolved = value.resolved;
	}
	return result;
}
function catalog(value) {
	if (!object(value) || ![
		"fresh",
		"stale",
		"unavailable"
	].includes(value.status) || !Array.isArray(value.versions) || value.versions.length > 50) throw new RuntimeUpdateError();
	const result = {
		status: value.status,
		versions: value.versions.map((entry) => {
			if (!object(entry) || !runtimeVersion(entry.version)) throw new RuntimeUpdateError();
			return { version: entry.version };
		})
	};
	if (value.checked_at !== void 0) {
		if (!Number.isSafeInteger(value.checked_at) || Number(value.checked_at) <= 0) throw new RuntimeUpdateError();
		result.checked_at = Number(value.checked_at);
	}
	if (value.next_cursor !== void 0) {
		if (!catalogCursor(value.next_cursor) || value.next_cursor.length === 0) throw new RuntimeUpdateError();
		result.next_cursor = value.next_cursor;
	}
	return result;
}
function readiness(value) {
	if (!object(value) || ![
		"ready",
		"blocked",
		"unavailable"
	].includes(value.status) || !Array.isArray(value.consumers) || value.consumers.length > 128) throw new RuntimeUpdateError();
	const result = {
		status: value.status,
		consumers: value.consumers.map((consumer) => {
			if (!object(consumer) || !hex$1(consumer.run_id) || typeof consumer.ready !== "boolean") throw new RuntimeUpdateError();
			const projected = {
				run_id: consumer.run_id,
				ready: consumer.ready
			};
			if (consumer.version !== void 0) {
				if (!runtimeVersion(consumer.version)) throw new RuntimeUpdateError();
				projected.version = consumer.version;
			}
			if (consumer.reason !== void 0) {
				if (!word(consumer.reason)) throw new RuntimeUpdateError();
				projected.reason = consumer.reason;
			}
			return projected;
		})
	};
	if (value.installed_version !== void 0) {
		if (!runtimeVersion(value.installed_version)) throw new RuntimeUpdateError();
		result.installed_version = value.installed_version;
	}
	return result;
}
/** Request-only Gate capability; no policy, approval, Docker or shell operations. */
var GateRuntimeUpdates = class {
	config;
	constructor(config) {
		this.config = lifecycleConfig(config);
	}
	request(method, route, value, maxBytes = 16 * 1024 * 1024) {
		let credential;
		try {
			credential = readPrivateJson(this.config.credentialFile);
		} catch {
			throw new RuntimeUpdateError();
		}
		if (!object(credential) || Object.keys(credential).join(",") !== "token" || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new RuntimeUpdateError();
		const token = credential.token;
		const payload = value ? JSON.stringify(value) : void 0;
		return new Promise((resolve, reject) => {
			let done = false;
			const finish = (error, result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				request.destroy();
				if (error) reject(error);
				else resolve(result);
			};
			const request = http.request(new URL(route, this.config.endpoint), {
				method,
				agent: false,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...payload ? { "Content-Length": Buffer.byteLength(payload) } : {}
				}
			}, (response) => {
				const status = response.statusCode ?? 503;
				if (status < 200 || status >= 300) {
					finish(new RuntimeUpdateError([
						400,
						404,
						409
					].includes(status) ? status : 503));
					return;
				}
				const chunks = [];
				let bytes = 0;
				response.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > maxBytes) {
						finish(new RuntimeUpdateError());
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", () => finish(new RuntimeUpdateError()));
				response.on("aborted", () => finish(new RuntimeUpdateError()));
				response.on("end", () => {
					try {
						finish(void 0, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
					} catch {
						finish(new RuntimeUpdateError());
					}
				});
			});
			const timer = setTimeout(() => finish(new RuntimeUpdateError()), 5e3);
			request.on("error", () => finish(new RuntimeUpdateError()));
			request.end(payload);
		});
	}
	async status() {
		const value = await this.request("GET", "/v1/runtime-updates");
		if (!object(value) || !object(value.policy) || ![
			"manual",
			"auto",
			"disabled"
		].includes(value.policy.mode) || !Array.isArray(value.jobs) || value.jobs.length > 100 || !Array.isArray(value.active) || value.active.length > 100) throw new RuntimeUpdateError();
		return {
			policy: { mode: value.policy.mode },
			jobs: value.jobs.map(job),
			active: value.active.map(job)
		};
	}
	async catalog(options = {}) {
		if (!object(options) || Object.keys(options).some((key) => key !== "query" && key !== "cursor") || options.query !== void 0 && !catalogQuery(options.query) || options.cursor !== void 0 && !catalogCursor(options.cursor)) throw new RuntimeUpdateError(400);
		const search = new URLSearchParams({
			query: options.query ?? "",
			cursor: options.cursor ?? ""
		});
		return catalog(await this.request("GET", `/v1/runtime-versions?${search}`, void 0, 128 * 1024));
	}
	async readiness() {
		return readiness(await this.request("GET", "/v1/runtime-readiness", void 0, 128 * 1024));
	}
	async submit(version, id) {
		if (!runtimeVersion(version) || !hex$1(id)) throw new RuntimeUpdateError(400);
		const result = job(await this.request("POST", "/v1/runtime-updates", {
			version,
			idempotency_key: id
		}));
		if (result.id !== id || result.version !== version) throw new RuntimeUpdateError();
		return result;
	}
	async operation(id) {
		if (!hex$1(id)) throw new RuntimeUpdateError(400);
		const result = job(await this.request("GET", `/v1/runtime-updates/${id}`));
		if (result.id !== id) throw new RuntimeUpdateError();
		return result;
	}
};
//#endregion
//#region hub/restart-api.ts
init_hub_generation();
init_config();
init_lifecycle();
init_state_budget();
var hex = (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
var text = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
async function body(request) {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
	const data = await new Promise((resolve, reject) => {
		let data = Buffer.alloc(0);
		const finish = (error) => {
			clearTimeout(timer);
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onError);
			if (error) reject(error);
			else resolve(data);
		};
		const onData = (chunk) => {
			data = Buffer.concat([data, chunk]);
			if (data.length > 8192) {
				request.resume();
				finish(/* @__PURE__ */ new Error());
			}
		};
		const onEnd = () => finish();
		const onError = () => finish(/* @__PURE__ */ new Error());
		const timer = setTimeout(onError, 5e3);
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("error", onError);
		request.once("aborted", onError);
	});
	const value = JSON.parse(data.toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
	return value;
}
function createRestartApi(config, hooks, management = new HubManagement(config)) {
	const provider = config.lifecycle ? new GateLifecycle(config.lifecycle) : void 0;
	const runtimeProvider = config.runtimeUpdates ? new GateRuntimeUpdates(config.runtimeUpdates) : void 0;
	const receipts = path.join(config.stateDir, "restarts");
	if (provider) privateDirectory(receipts);
	const file = (id) => {
		if (!hex(id)) throw new Error();
		return path.join(receipts, `${id}.json`);
	};
	const read = (id) => {
		const value = readPrivateJson(file(id));
		if (value.id !== id || !hex(value.run_id) || !isHubGeneration(value.generation) || value.idempotency_key !== id || !text(value.runtime_id) || !text(value.session_id) || value.leaf_id !== null && !text(value.leaf_id)) throw new Error();
		return value;
	};
	const save = (value, publish) => withStateWriter(config, (writer) => {
		if (!hooks.granted(value.run_id)) throw new Error();
		if (readdirSync(receipts).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).length >= 1e3) throw new Error();
		writer.write(`restarts/${value.id}.json`, value, { exclusive: true });
		publish();
	});
	const resolve = async (id, submitted) => {
		if (!provider) throw new Error();
		const receipt = read(id);
		if (!hooks.granted(receipt.run_id)) throw new Error();
		const job = submitted ?? await provider.operation(id);
		if (job.run_id !== receipt.run_id || !hooks.granted(receipt.run_id)) throw new Error();
		const clockFile = path.join(receipts, `${id}.started.json`);
		if (job.started_at !== void 0) withStateWriter(config, (writer) => {
			if (!hooks.granted(receipt.run_id)) throw new Error();
			if (!existsSync(clockFile)) writer.write(`restarts/${id}.started.json`, { started_at: job.started_at }, { exclusive: true });
		});
		if (existsSync(clockFile) && readPrivateJson(clockFile).started_at !== job.started_at) throw new Error();
		const result = {
			id,
			status: job.status,
			stage: job.stage
		};
		const failed = (stage) => {
			hooks.clearHandoff(id);
			return {
				...result,
				status: "failed",
				stage
			};
		};
		if ([
			"failed",
			"recovery_required",
			"rejected",
			"stale"
		].includes(job.status)) hooks.clearHandoff(id);
		for (const key of [
			"old_version",
			"expected_version",
			"new_version"
		]) if (job[key]) result[key] = job[key];
		if (job.status === "succeeded") {
			if (job.old_runtime_id !== receipt.runtime_id || job.session_id !== receipt.session_id || job.leaf_id !== receipt.leaf_id || !job.new_runtime_id || job.new_runtime_id === receipt.runtime_id || !job.new_version || job.new_version !== job.expected_version) return failed("restored_identity_mismatch");
			if (job.started_at === void 0) throw new Error();
			const deadline = job.started_at + 21e4;
			const verifiedFile = path.join(receipts, `${id}.verified.json`);
			const completed = existsSync(verifiedFile) ? readPrivateJson(verifiedFile) : void 0;
			if (completed && (completed.id !== id || completed.run_id !== receipt.run_id || completed.generation !== receipt.generation || completed.old_runtime_id !== receipt.runtime_id || completed.session_id !== receipt.session_id || completed.leaf_id !== receipt.leaf_id || completed.started_at !== job.started_at || !Number.isSafeInteger(completed.at) || completed.at >= deadline || completed.at < job.started_at || completed.at > Date.now() || completed.runtimeId !== job.new_runtime_id || completed.version !== job.new_version || !isHubSessionPath(completed.path))) throw new Error();
			if (!completed && Date.now() >= deadline) return failed("registration_timeout");
			let route;
			try {
				route = await hooks.successor(receipt.run_id, job.new_runtime_id, receipt.session_id, receipt.leaf_id, job.new_version);
			} catch (error) {
				if (!completed) throw error;
			}
			if (!hooks.granted(receipt.run_id)) throw new Error();
			if (completed) {
				if (route === completed.path) result.path = route;
				return result;
			}
			if (Date.now() >= deadline) return failed("registration_timeout");
			if (route) {
				if (!isHubSessionPath(route)) throw new Error();
				withStateWriter(config, (writer) => {
					if (!hooks.granted(receipt.run_id) || Date.now() >= deadline) throw new Error();
					if (!existsSync(verifiedFile)) writer.write(`restarts/${id}.verified.json`, {
						id,
						run_id: receipt.run_id,
						generation: receipt.generation,
						old_runtime_id: receipt.runtime_id,
						session_id: receipt.session_id,
						leaf_id: receipt.leaf_id,
						started_at: job.started_at,
						at: Date.now(),
						path: route,
						runtimeId: job.new_runtime_id,
						version: job.new_version
					}, { exclusive: true });
				});
				result.path = route;
			} else {
				result.status = "running";
				result.stage = "waiting_for_registration";
			}
		}
		return result;
	};
	return {
		resolve,
		async handle(request, response, sameOrigin) {
			const requestUrl = new URL(request.url ?? "/", "http://hub.invalid");
			const pathname = requestUrl.pathname;
			if (!pathname.startsWith("/api/management/")) return false;
			const reply = (status, value, cookie) => {
				response.writeHead(status, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					...cookie ? { "Set-Cookie": cookie } : {}
				}).end(JSON.stringify(value));
			};
			let phase = "authorization";
			try {
				if (config.management?.gateway && !gatewayIdentity(config, request)) {
					reply(401, { error: "Verified gateway login required" });
					return true;
				}
				if (request.method === "GET" && pathname === "/api/management/status") {
					reply(200, {
						available: !!provider || !!runtimeProvider || !!config.gateManagement || !!config.management,
						...config.gateManagement ? { gateManagementAvailable: true } : {},
						...config.management ? { interactionsAvailable: true } : {},
						restartAvailable: !!provider,
						...config.management?.gateway ? { authMode: "gateway" } : {},
						...runtimeProvider ? { runtimeUpdatesAvailable: true } : {},
						...management.status(request)
					});
					return true;
				}
				if (request.method === "POST" && !sameOrigin) {
					reply(403, { error: "Same-origin management request required" });
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/unlock") {
					if (config.management?.gateway) {
						reply(404, { error: "Pairing is not enabled" });
						return true;
					}
					const value = await body(request);
					if (Object.keys(value).join(",") !== "code") throw new Error();
					const result = management.unlock(value.code);
					reply(200, {
						authorized: true,
						csrf: result.csrf,
						expiresAt: result.expiresAt
					}, result.cookie);
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/gateway") {
					if (!config.management?.gateway) {
						reply(404, { error: "Gateway login is not configured" });
						return true;
					}
					try {
						if (Object.keys(await body(request)).length !== 0) throw new Error();
					} catch {
						reply(400, { error: "Empty gateway session request required" });
						return true;
					}
					const result = management.unlockGateway(request);
					reply(200, {
						authorized: true,
						csrf: result.csrf,
						expiresAt: result.expiresAt
					}, result.cookie);
					return true;
				}
				const authorization = management.authorize(request, request.method !== "GET");
				const revalidate = () => {
					phase = "authorization";
					management.revalidate(request, authorization, request.method !== "GET");
					phase = "provider";
				};
				if (request.method === "POST" && pathname === "/api/management/logout") {
					reply(200, { authorized: false }, management.logout(request));
					return true;
				}
				if (request.method === "GET" && pathname === "/api/management/storage") {
					reply(200, storageDiagnostics(config));
					return true;
				}
				phase = "provider";
				if (pathname === "/api/management/runtime-versions" || pathname === "/api/management/runtime-readiness") {
					if (!runtimeProvider) {
						reply(503, { error: "Global Pi updates are not configured" });
						return true;
					}
					if (request.method !== "GET") {
						reply(405, { error: "Method not allowed" });
						return true;
					}
					if (pathname === "/api/management/runtime-readiness" && requestUrl.searchParams.size !== 0) {
						reply(404, { error: "Management route not found" });
						return true;
					}
					const keys = [...requestUrl.searchParams.keys()];
					if (pathname === "/api/management/runtime-versions" && (keys.some((key) => key !== "query" && key !== "cursor") || requestUrl.searchParams.getAll("query").length > 1 || requestUrl.searchParams.getAll("cursor").length > 1)) {
						reply(404, { error: "Management route not found" });
						return true;
					}
					try {
						const result = pathname === "/api/management/runtime-versions" ? await runtimeProvider.catalog({
							...requestUrl.searchParams.has("query") ? { query: requestUrl.searchParams.get("query") ?? "" } : {},
							...requestUrl.searchParams.has("cursor") ? { cursor: requestUrl.searchParams.get("cursor") ?? "" } : {}
						}) : await runtimeProvider.readiness();
						revalidate();
						reply(200, result);
					} catch (error) {
						if (!(error instanceof RuntimeUpdateError)) throw error;
						revalidate();
						reply(error.status, { error: error.status === 400 ? "Invalid bounded runtime catalog query" : "Runtime provider unavailable; catalog or readiness could not be verified" });
					}
					return true;
				}
				if (pathname.startsWith("/api/management/runtime-versions") || pathname.startsWith("/api/management/runtime-readiness")) {
					reply(404, { error: "Management route not found" });
					return true;
				}
				if (pathname === "/api/management/runtime-updates" || /^\/api\/management\/runtime-updates\/[a-f0-9]{32}$/.test(pathname)) {
					if (!runtimeProvider) {
						reply(503, { error: "Global Pi updates are not configured" });
						return true;
					}
					let result;
					let status = 200;
					try {
						if (request.method === "GET") result = pathname === "/api/management/runtime-updates" ? await runtimeProvider.status() : await runtimeProvider.operation(pathname.slice(32));
						else if (request.method === "POST" && pathname === "/api/management/runtime-updates") {
							let value;
							try {
								value = await body(request);
							} catch {
								revalidate();
								reply(400, { error: "Invalid runtime update request" });
								return true;
							}
							revalidate();
							if (Object.keys(value).sort().join(",") !== "idempotencyKey,version" || !runtimeVersion(value.version) || !hex(value.idempotencyKey)) {
								reply(400, { error: "Exact stable Pi version and idempotency identity required" });
								return true;
							}
							result = await runtimeProvider.submit(value.version, value.idempotencyKey);
							status = 202;
						} else {
							reply(405, { error: "Method not allowed" });
							return true;
						}
					} catch (error) {
						if (!(error instanceof RuntimeUpdateError)) throw error;
						revalidate();
						reply(error.status, { error: error.status === 400 ? "Pi version rejected; use an audited exact stable version" : error.status === 409 ? "Gate is busy or global updates are disabled" : error.status === 404 ? "Runtime update not found; verify the original task ID" : "Runtime provider unavailable or outcome unknown; query the original task ID before retrying" });
						return true;
					}
					revalidate();
					reply(status, result);
					return true;
				}
				if (pathname.startsWith("/api/management/runtime-updates")) {
					reply(404, { error: "Management route not found" });
					return true;
				}
				if (!provider) {
					reply(503, { error: "Managed restart is not configured" });
					return true;
				}
				const targetMatch = new RegExp(`^/api/management/targets/(${HUB_GENERATION_SOURCE})$`).exec(pathname);
				if (request.method === "GET" && targetMatch) {
					const selected = await hooks.lookup(targetMatch[1]);
					if (!selected) {
						reply(410, { error: "Session changed" });
						return true;
					}
					if (!selected.runtime?.managed) {
						reply(200, { managed: false });
						return true;
					}
					const target = await provider.target(selected.runId);
					if (!hooks.granted(selected.runId)) throw new Error();
					const { run_id: _runId, ...safe } = target;
					if (target.managed && (target.runtime_id !== selected.runtime.runtimeId || target.session_id !== selected.runtime.sessionId || target.leaf_id !== selected.runtime.leafId)) {
						reply(409, { error: "Session identity changed; refresh before restarting" });
						return true;
					}
					reply(200, safe);
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/restarts") {
					const value = await body(request);
					revalidate();
					if (Object.keys(value).sort().join(",") !== "generation,idempotencyKey,leafId,runtimeId,sessionId" || !isHubGeneration(value.generation) || !hex(value.idempotencyKey) || !text(value.runtimeId) || !text(value.sessionId) || value.leafId !== null && !text(value.leafId)) {
						reply(400, { error: "Invalid restart request" });
						return true;
					}
					const id = value.idempotencyKey;
					let receipt;
					if (existsSync(file(id))) {
						receipt = read(id);
						if (receipt.generation !== value.generation || receipt.runtime_id !== value.runtimeId || receipt.session_id !== value.sessionId || receipt.leaf_id !== value.leafId) throw new Error();
						reply(200, await resolve(id));
						return true;
					}
					const selected = await hooks.lookup(value.generation);
					revalidate();
					if (!selected?.runtime?.managed || selected.runtime.runtimeId !== value.runtimeId || selected.runtime.sessionId !== value.sessionId || selected.runtime.leafId !== value.leafId) {
						reply(409, { error: "Session changed or needs a managed image" });
						return true;
					}
					receipt = {
						id,
						generation: value.generation,
						requestedAt: Date.now(),
						run_id: selected.runId,
						runtime_id: value.runtimeId,
						session_id: value.sessionId,
						leaf_id: value.leafId,
						idempotency_key: id
					};
					revalidate();
					save(receipt, () => {
						revalidate();
						hooks.prepareHandoff(selected.runId, {
							id,
							generation: receipt.generation,
							runtimeId: receipt.runtime_id,
							sessionId: receipt.session_id,
							leafId: receipt.leaf_id
						});
					});
					revalidate();
					const job = await provider.restart({
						run_id: receipt.run_id,
						runtime_id: receipt.runtime_id,
						session_id: receipt.session_id,
						leaf_id: receipt.leaf_id,
						idempotency_key: id
					});
					if (job.id !== id || !hooks.granted(receipt.run_id)) throw new Error();
					reply(202, await resolve(id, job));
					return true;
				}
				const match = /^\/api\/management\/restarts\/([a-f0-9]{32})$/.exec(pathname);
				if (request.method === "GET" && match) {
					reply(200, await resolve(match[1]));
					return true;
				}
				reply(404, { error: "Management route not found" });
			} catch {
				reply(phase === "authorization" ? 401 : 409, { error: phase === "authorization" ? "Management authorization required" : "Restart unavailable or outcome unknown; refresh status before retrying" });
			}
			return true;
		}
	};
}
//#endregion
//#region hub/version-status.ts
var SHA256 = /^[a-f0-9]{64}$/;
var CACHE_MS = 300 * 1e3;
var REQUEST_TIMEOUT_MS = 8e3;
var MAX_BODY_BYTES = 256 * 1024;
var MANAGER_PACKAGE_NAME = "@swordfate/pi-manager";
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Capture the Hub's loaded build identity, even when deployed without the surrounding package. */
function captureHubMetadata(moduleUrl = import.meta.url) {
	{
		const embedded = {
			"version": "0.1.0",
			"build": "f9382f7707aa86d68154105d576d9ea840708f89a1f4d87d4b85e0f4c4cdc585"
		};
		if (embedded && isStableSemver(embedded.version) && SHA256.test(embedded.build)) return Object.freeze({
			version: embedded.version,
			build: embedded.build
		});
		return;
	}
	let directory = path.dirname(fileURLToPath(moduleUrl));
	let root;
	for (let depth = 0; depth < 8; depth++) {
		try {
			const packagePath = path.join(directory, "package.json");
			if (statSync(packagePath).size > 32 * 1024) throw new Error();
			const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
			if (isRecord(manifest) && manifest.name === MANAGER_PACKAGE_NAME && isStableSemver(manifest.version)) {
				root = directory;
				break;
			}
		} catch {}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	if (!root) return void 0;
	try {
		const packagePath = path.join(root, "package.json");
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		let build;
		try {
			const buildPath = path.join(root, "dist", "build-manifest.json");
			if (statSync(buildPath).size > MAX_BODY_BYTES) throw new Error();
			const buildManifest = JSON.parse(readFileSync(buildPath, "utf8"));
			const source = isRecord(buildManifest) ? buildManifest.source : void 0;
			if (isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) build = source.sha256;
		} catch {}
		return Object.freeze({
			version: manifest.version,
			...build ? { build } : {}
		});
	} catch {
		return;
	}
}
/** Background-only, single-flight version lookup with bounded requests and cooldown even after failures. */
function createVersionStatus(options = {}) {
	const now = options.now ?? Date.now;
	const cacheMs = Math.max(CACHE_MS, options.cacheMs ?? 0);
	const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const source = options.source ?? (async (_signal) => {
		throw new Error("Manager release source is not configured");
	});
	const localHub = options.hub ?? captureHubMetadata();
	const hub = localHub ? Object.freeze({ ...localHub }) : void 0;
	let status = Object.freeze({
		status: "checking",
		...hub ? { hub } : {}
	});
	let inFlight;
	let timer;
	let controller;
	let activeTimeout;
	let rejectActive;
	let nextCheckAt = 0;
	let closed = false;
	const check = () => {
		if (closed || inFlight) return inFlight ?? Promise.resolve();
		if (now() < nextCheckAt) return Promise.resolve();
		if (timer) clearTimeout(timer);
		timer = void 0;
		controller = new AbortController();
		const active = controller;
		let rejectTimeout;
		const expired = new Promise((_resolve, reject) => {
			rejectTimeout = reject;
		});
		rejectActive = rejectTimeout;
		activeTimeout = setTimeout(() => {
			active.abort();
			rejectTimeout(/* @__PURE__ */ new Error("Version check timed out"));
		}, timeoutMs);
		activeTimeout.unref?.();
		inFlight = (async () => {
			try {
				const result = await Promise.race([Promise.resolve().then(() => source(active.signal)), expired]);
				if (closed || active.signal.aborted) return;
				if (!isRecord(result) || Object.keys(result).some((key) => key !== "pi" && key !== "webUi")) throw new Error("Invalid version source result");
				const pi = result.pi;
				const webUi = result?.webUi;
				const validPi = isRecord(pi) && Object.keys(pi).join(",") === "version" && isStableSemver(pi.version);
				const validWeb = isRecord(webUi) && Object.keys(webUi).sort().join(",") === "build,version" && isStableSemver(webUi.version) && typeof webUi.build === "string" && SHA256.test(webUi.build);
				if (!validPi && !validWeb) throw new Error("Invalid version source result");
				status = Object.freeze({
					status: validPi && validWeb ? "ok" : "partial",
					checkedAt: now(),
					...validPi ? { pi: Object.freeze({ version: pi.version }) } : {},
					...validWeb ? { webUi: Object.freeze({
						version: webUi.version,
						build: webUi.build
					}) } : {},
					...hub ? { hub } : {}
				});
			} catch {
				if (closed) return;
				status = Object.freeze({
					status: "unavailable",
					checkedAt: now(),
					...hub ? { hub } : {}
				});
			} finally {
				if (activeTimeout) clearTimeout(activeTimeout);
				activeTimeout = void 0;
				rejectActive = void 0;
				if (controller === active) controller = void 0;
				inFlight = void 0;
				if (!closed) {
					nextCheckAt = now() + cacheMs;
					timer = setTimeout(() => {
						timer = void 0;
						check();
					}, Math.max(0, nextCheckAt - now()));
					timer.unref?.();
				}
			}
		})();
		return inFlight;
	};
	return {
		snapshot: () => status,
		ensureStarted: () => {
			check();
		},
		/** Test/maintenance seam. HTTP handlers use snapshot only and never await this. */
		refresh: check,
		close: () => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			timer = void 0;
			if (activeTimeout) clearTimeout(activeTimeout);
			activeTimeout = void 0;
			controller?.abort();
			rejectActive?.(/* @__PURE__ */ new Error("Version checker closed"));
			rejectActive = void 0;
		}
	};
}
//#endregion
//#region hub/server.ts
init_hub_generation();
init_protocol();
init_config();
init_state_budget();
var mac = (token, value) => createHmac("sha256", token).update(value).digest("hex");
function equal(value, expected) {
	if (typeof value !== "string") return false;
	const a = Buffer.from(value);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
async function proveBackend(grant, generation, port) {
	const challenge = randomBytes(24).toString("hex");
	return new Promise((resolve) => {
		let settled = false;
		const finish = (valid) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.destroy();
			resolve(valid);
		};
		const request = http.get({
			host: grant.backendHost,
			port,
			path: "/.pi-web-identity",
			agent: false,
			headers: {
				"x-pi-web-challenge": challenge,
				"x-pi-web-challenge-proof": mac(grant.token, challenge)
			}
		}, (response) => {
			if (response.statusCode !== 200) {
				finish(false);
				return;
			}
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
				if (body.length > 4096) finish(false);
			});
			response.on("error", () => finish(false));
			response.on("end", () => {
				try {
					const value = JSON.parse(body);
					finish(value.generation === generation && equal(value.proof, mac(grant.token, `${challenge}:${generation}`)));
				} catch {
					finish(false);
				}
			});
		});
		const timer = setTimeout(() => finish(false), 1500);
		request.on("error", () => finish(false));
	});
}
function backendHeaders(request, session) {
	const headers = {};
	const hop = new Set([
		"connection",
		"upgrade",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"authorization",
		"cookie",
		"host"
	]);
	for (const field of (request.headers.connection ?? "").split(",")) hop.add(field.trim().toLowerCase());
	for (const [key, value] of Object.entries(request.headers)) if (!hop.has(key) && !key.startsWith("x-pi-web-") && !key.startsWith("x-pi-hub-") && !key.startsWith("x-forwarded-") && key !== "forwarded") headers[key] = value;
	headers["x-pi-web-generation"] = session.generation;
	headers["x-pi-web-proof"] = mac(session.grant.token, session.generation);
	return headers;
}
function boundedDeflateOffer(header) {
	if (!header) return false;
	const [extension, ...parameters] = header.split(";").map((value) => value.trim());
	if (extension !== "permessage-deflate") return false;
	const seen = /* @__PURE__ */ new Set();
	for (const parameter of parameters) {
		const [name, value, ...extra] = parameter.split("=");
		if (seen.has(name) || extra.length) return false;
		seen.add(name);
		if (name === "client_no_context_takeover" || name === "server_no_context_takeover") {
			if (value !== void 0) return false;
		} else if (name === "client_max_window_bits") {
			if (value !== void 0 && !/^1[2-5]$/.test(value)) return false;
		} else if (name === "server_max_window_bits") {
			if (value === void 0 || !/^1[2-5]$/.test(value)) return false;
		} else return false;
	}
	return seen.has("client_max_window_bits");
}
/** Explicitly launched independent process; never imported as a Pi extension entry. */
async function startHub(config, options = {}) {
	if (config.management) managementConfig(config.management, config.port, config.publicUrl);
	const serving = acquireStateLock(config, ".serving.lock");
	config = {
		...config,
		stateDir: serving.root
	};
	try {
		privateDirectory(config.runtimeDir);
		const lock = path.join(config.runtimeDir, "hub.lock");
		mkdirSync(lock, { mode: 448 });
		const owner = path.join(lock, "owner.json");
		const release = () => {
			if (!existsSync(lock)) return;
			if (existsSync(owner)) unlinkSync(owner);
			rmdirSync(lock);
		};
		try {
			writeFileSync(owner, JSON.stringify({ pid: process.pid }), {
				flag: "wx",
				mode: 384
			});
			const hub = await startLockedHub(config, options);
			let closing;
			return {
				...hub,
				close: () => {
					closing ??= hub.close().finally(() => {
						release();
						serving.release();
					});
					return closing;
				}
			};
		} catch (error) {
			release();
			throw error;
		}
	} catch (error) {
		serving.release();
		throw error;
	}
}
async function startLockedHub(config, options) {
	privateDirectory(config.stateDir);
	privateDirectory(config.runtimeDir);
	privateDirectory(path.join(config.stateDir, "grants"));
	privateDirectory(path.join(config.stateDir, "generations"));
	privateDirectory(path.join(config.stateDir, "bounded"));
	if (existsSync(config.socketPath)) {
		const stat = lstatSync(config.socketPath);
		if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe hub socket path");
		if (!await new Promise((resolve) => {
			const socket = net.createConnection(config.socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, 500);
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(false);
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(error.code === "ECONNREFUSED");
			});
		})) throw new Error("Another hub is already running");
		unlinkSync(config.socketPath);
	}
	const boot = randomBytes(16).toString("hex");
	withStateWriter(config, (writer) => writer.write("registry.json", {
		schema: 2,
		boot
	}, { security: true }));
	const sessions = /* @__PURE__ */ new Map();
	const peers = /* @__PURE__ */ new Set();
	const connections = /* @__PURE__ */ new Set();
	const webSockets = /* @__PURE__ */ new Map();
	const outbound = /* @__PURE__ */ new Map();
	const sendControl = (client, value) => outbound.get(client)?.enqueue(value);
	let activeProbes = 0;
	const proof = async (grant, generation, port) => {
		if (activeProbes >= HUB_LIMITS.backendProbes) throw new RegistryError("HUB_BUSY");
		activeProbes++;
		try {
			return await proveBackend(grant, generation, port);
		} finally {
			activeProbes--;
		}
	};
	const handoffs = /* @__PURE__ */ new Map();
	const pruneHandoffs = () => {
		for (const [token, item] of handoffs) if (item.expires <= Date.now()) handoffs.delete(token);
	};
	let stopped = false;
	let pending = Promise.resolve();
	let admittedRegistrations = 0;
	const versionStatus = createVersionStatus(options.versions);
	let url = "";
	let managementUrl;
	let interactionApi;
	const restarting = /* @__PURE__ */ new Map();
	const activateRestart = (generation) => {
		const restart = restarting.get(generation);
		if (!restart) return;
		restart.deadline ??= Date.now() + 21e4;
		for (const item of handoffs.values()) if (item.restart === restart) item.expires = restart.deadline;
	};
	const retire = (generation, writer) => {
		activateRestart(generation);
		const session = sessions.get(generation);
		sessions.delete(generation);
		interactionApi?.retire(generation);
		for (const [ws, id] of webSockets) if (id === generation) ws.terminate();
		if (session && isBoundedGeneration(generation)) {
			const clear = (transaction) => {
				const record = boundedRecord(config, session.grant.run_id, boot);
				if (record.current?.generation === generation) {
					delete record.current;
					saveBounded(transaction, record, true);
				}
			};
			try {
				if (writer) clear(writer);
				else withStateWriter(config, clear);
			} catch {}
		}
	};
	const current = (generation) => {
		const session = sessions.get(generation);
		if (!session) return void 0;
		try {
			const grant = readGrant(config, session.grant.run_id);
			if (session.expires <= Date.now() || grant.revoked || !equal(grant.token, session.grant.token) || grant.backendHost !== session.grant.backendHost) {
				retire(generation);
				return;
			}
		} catch {
			retire(generation);
			return;
		}
		return session;
	};
	const listSessions = () => [...sessions.keys()].map(current).filter((session) => Boolean(session)).map((session) => ({
		label: session.grant.label,
		sessionName: session.sessionName,
		generation: session.generation,
		path: `/s/${session.generation}/`,
		since: session.since,
		...session.runtime ? { runtime: {
			version: session.runtime.version,
			managed: session.runtime.managed
		} } : {},
		...session.software ? { software: session.software } : {}
	}));
	const granted = (runId) => {
		try {
			return !readGrant(config, runId).revoked;
		} catch {
			return false;
		}
	};
	const verified = async (generation) => {
		const session = current(generation);
		if (!session || !await proof(session.grant, generation, session.port) || stopped || current(generation) !== session) return void 0;
		return session;
	};
	const management = new HubManagement(config);
	const gateManagementApi = createGateManagementApi(config, management, (runId) => {
		const matches = [...sessions.keys()].map(current).filter((session) => session?.grant.run_id === runId);
		if (matches.length !== 1 || !matches[0]) return void 0;
		return new URL(`/s/${matches[0].generation}/`, config.publicUrl ?? url).href;
	});
	const interactionTarget = (session) => {
		const descriptor = session?.interaction ?? session?.runtime;
		if (!session || !descriptor) return void 0;
		return {
			identity: {
				runId: session.grant.run_id,
				generation: session.generation,
				runtimeId: descriptor.runtimeId,
				sessionId: descriptor.sessionId
			},
			backendHost: session.grant.backendHost,
			port: session.port,
			token: session.grant.token
		};
	};
	interactionApi = createInteractionApi(config, management, {
		generations: () => [...sessions.keys()].filter((generation) => !!interactionTarget(current(generation))),
		lookup: async (generation) => interactionTarget(await verified(generation)),
		current: (target) => {
			const fresh = interactionTarget(current(target.identity.generation));
			return !!fresh && !stopped && fresh.identity.runId === target.identity.runId && fresh.identity.runtimeId === target.identity.runtimeId && fresh.identity.sessionId === target.identity.sessionId && fresh.backendHost === target.backendHost && fresh.port === target.port && fresh.token === target.token;
		}
	});
	const restartApi = createRestartApi(config, {
		clearHandoff: (id) => {
			for (const [generation, item] of restarting) if (item.id === id) restarting.delete(generation);
			for (const [token, item] of handoffs) {
				if (item.restart?.id !== id) continue;
				const original = current(item.from);
				if (item.client?.readyState !== WebSocket.OPEN || webSockets.get(item.client) !== item.from || original?.grant.run_id !== item.grant.run_id || original.runtime?.runtimeId !== item.restart.runtimeId) {
					handoffs.delete(token);
					continue;
				}
				item.originalRuntimeId = item.restart.runtimeId;
				item.restart = void 0;
				item.successor = item.from;
				item.expires = Infinity;
				sendControl(item.client, JSON.stringify({
					type: "event",
					event: "hub_route",
					payload: {
						generation: item.from,
						token
					}
				}));
			}
		},
		granted,
		lookup: async (generation) => {
			const session = await verified(generation);
			return session ? {
				runId: session.grant.run_id,
				generation,
				runtime: session.runtime
			} : void 0;
		},
		successor: async (runId, runtimeId, sessionId, leafId, version) => {
			for (const generation of sessions.keys()) {
				const session = current(generation);
				const runtime = session?.runtime;
				if (session?.grant.run_id !== runId || !runtime?.managed || runtime.runtimeId !== runtimeId || runtime.sessionId !== sessionId || runtime.leafId !== leafId || runtime.version !== version) continue;
				const proved = await verified(generation);
				const fresh = proved?.runtime;
				if (proved?.grant.run_id === runId && fresh?.managed && fresh.runtimeId === runtimeId && fresh.sessionId === sessionId && fresh.leafId === leafId && fresh.version === version) return `/s/${generation}/`;
			}
		},
		prepareHandoff: (runId, receipt) => {
			const selected = current(receipt.generation);
			if (!selected || selected.grant.run_id !== runId || selected.runtime?.runtimeId !== receipt.runtimeId || selected.runtime.sessionId !== receipt.sessionId || selected.runtime.leafId !== receipt.leafId) throw new Error("Session changed");
			const restart = {
				id: receipt.id,
				runtimeId: receipt.runtimeId
			};
			restarting.set(receipt.generation, restart);
			for (const [token, item] of handoffs) {
				if (item.from !== receipt.generation || item.grant.run_id !== runId) continue;
				item.restart = restart;
				item.expires = Infinity;
				if (!item.client) activateRestart(receipt.generation);
				if (item.client?.readyState === WebSocket.OPEN) sendControl(item.client, JSON.stringify({
					type: "event",
					event: "hub_route",
					payload: {
						generation: item.from,
						token,
						restart: {
							id: receipt.id,
							timeoutMs: 12e4
						}
					}
				}));
			}
		}
	}, management);
	const register = async (value) => {
		const authenticate = () => {
			if (stopped || typeof value.run_id !== "string") throw new RegistryError("AUTH_FAILED");
			const grant = readGrant(config, value.run_id);
			if (grant.revoked || !equal(value.token, grant.token)) throw new RegistryError("AUTH_FAILED");
			return grant;
		};
		if (value.action === "registry_negotiate") return withStateWriter(config, () => {
			const grant = authenticate();
			if (typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce) || typeof value.protocol !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.protocol)) throw new RegistryError("PROTOCOL_REJECTED");
			if (value.protocol !== "bounded-v2") {
				const legacy = hasBoundedRecord(config, grant.run_id) ? void 0 : "legacy-v1";
				return {
					unsupported: true,
					protocol: value.protocol,
					nonce: value.nonce,
					...legacy ? { legacy } : {},
					proof: mac(grant.token, `${value.nonce}:${value.protocol}:UNSUPPORTED_PROTOCOL:${legacy ?? ""}`)
				};
			}
			const record = boundedRecord(config, grant.run_id, boot);
			return {
				protocol: BOUNDED_PROTOCOL,
				nonce: value.nonce,
				boot,
				slot: record.slot,
				proof: mac(grant.token, `${value.nonce}:${BOUNDED_PROTOCOL}:${boot}:${record.slot}`)
			};
		});
		const bounded = [
			"bounded_issue",
			"bounded_register",
			"bounded_unregister"
		].includes(String(value.action));
		if (bounded ? value.protocol !== "bounded-v2" || value.boot !== boot : value.protocol !== void 0) throw new RegistryError("PROTOCOL_REJECTED");
		if (value.action === "bounded_issue") return withStateWriter(config, (writer) => {
			const grant = authenticate();
			writer.assertAdmission();
			return issueBounded(writer, boundedRecord(config, grant.run_id, boot), value, (generation) => !!current(generation));
		});
		if (typeof value.generation !== "string" || !(bounded ? isBoundedGeneration(value.generation) : /^[a-f0-9]{32}$/.test(value.generation))) throw new RegistryError("PROTOCOL_REJECTED");
		const generation = value.generation;
		const ledger = path.join(config.stateDir, "generations", `${generation}.json`);
		const readOwner = () => existsSync(ledger) ? readPrivateJson(ledger) : void 0;
		if (value.action === "unregister" || value.action === "bounded_unregister") return withStateWriter(config, (writer) => {
			const grant = authenticate();
			const session = current(generation);
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				let changed = false;
				for (const key of ["current", "pending"]) if (record[key]?.generation === generation) {
					delete record[key];
					changed = true;
				}
				if (changed) saveBounded(writer, record, true);
			} else {
				if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
				const owner = readOwner();
				if (session && session.grant.run_id !== grant.run_id || owner && owner.run_id !== grant.run_id) throw new RegistryError("AUTH_FAILED");
				if (!owner || session && !owner.retired) writer.write(`generations/${generation}.json`, {
					boot,
					run_id: grant.run_id,
					retired: true
				}, {
					exclusive: !owner,
					security: !!owner
				});
			}
			if (session?.grant.run_id === grant.run_id) retire(generation, writer);
			return {};
		});
		if (value.action !== "register" && value.action !== "bounded_register" || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new RegistryError("PROTOCOL_REJECTED");
		if (value.sessionName !== void 0 && value.sessionName !== null && (typeof value.sessionName !== "string" || value.sessionName.length > 256)) throw new Error("Registration rejected");
		const sessionName = typeof value.sessionName === "string" ? value.sessionName.replace(/\p{Cc}/gu, " ").trim() || null : null;
		const runtime = value.runtime === void 0 ? void 0 : readRuntimeMetadata(value.runtime);
		const software = value.software === void 0 ? void 0 : readSoftwareMetadata(value.software);
		const interaction = readInteractionRegistration(value.interaction);
		const port = Number(value.port);
		const prepared = withStateWriter(config, (writer) => {
			const grant = authenticate();
			writer.assertAdmission();
			const session = current(generation);
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				boundedTuple(record, generation, port, !!session);
				return {
					grant,
					session,
					revision: record.revision,
					owner: void 0
				};
			}
			if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
			const owner = readOwner();
			if (owner && (owner.retired || owner.boot !== boot || owner.run_id !== grant.run_id || !session || session.port !== port)) throw new RegistryError();
			return {
				grant,
				session,
				revision: void 0,
				owner: JSON.stringify(owner)
			};
		});
		const { grant, session } = prepared;
		if (!await proof(grant, generation, port) || stopped) throw new RegistryError("PROOF_FAILED");
		return withStateWriter(config, (writer) => {
			const latestGrant = authenticate();
			writer.assertAdmission();
			if (latestGrant.token !== grant.token || latestGrant.backendHost !== grant.backendHost) throw new RegistryError("AUTH_FAILED");
			if (session && current(generation) !== session) throw new RegistryError();
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				if (record.revision !== prepared.revision) throw new RegistryError();
				if (boundedTuple(record, generation, port, !!session && current(generation) === session) === "pending") {
					record.current = record.pending;
					delete record.pending;
				}
				record.current.expires = Date.now() + config.leaseMs;
				saveBounded(writer, record);
			} else {
				if (hasBoundedRecord(config, grant.run_id) || JSON.stringify(readOwner()) !== prepared.owner) throw new RegistryError();
				if (!readOwner()) writer.write(`generations/${generation}.json`, {
					boot,
					run_id: grant.run_id
				}, { exclusive: true });
			}
			for (const other of sessions.values()) if (other.grant.run_id === grant.run_id && other.generation !== generation) retire(other.generation, writer);
			if (session) {
				session.expires = Date.now() + config.leaseMs;
				session.sessionName = sessionName;
				session.runtime = runtime;
				session.software = software;
				session.interaction = interaction;
			} else sessions.set(generation, {
				grant,
				generation,
				port,
				expires: Date.now() + config.leaseMs,
				since: Date.now(),
				sessionName,
				runtime,
				software,
				interaction
			});
			pruneHandoffs();
			if (!session) {
				for (const item of handoffs.values()) if (!item.restart && item.grant.run_id === grant.run_id && item.from !== generation && !item.successor) item.successor = generation;
			}
			return { url: `${config.publicUrl ?? url}s/${generation}/` };
		});
	};
	const registry = net.createServer((socket) => {
		if (peers.size >= HUB_LIMITS.registrationPeers) {
			socket.destroy();
			return;
		}
		peers.add(socket);
		let data = Buffer.alloc(0);
		let received = false;
		const timer = setTimeout(() => socket.destroy(), 5e3);
		socket.on("error", () => {});
		socket.once("close", () => {
			clearTimeout(timer);
			peers.delete(socket);
		});
		const reply = (ok, result, error = "Registration rejected", code) => {
			if (!socket.destroyed) socket.end(`${JSON.stringify(ok ? {
				ok,
				result
			} : {
				ok,
				error,
				...code ? { code } : {}
			})}\n`);
		};
		socket.on("data", (chunk) => {
			if (received) return;
			if (data.length + chunk.length > 8192) {
				received = true;
				reply(false);
				return;
			}
			data = Buffer.concat([data, chunk]);
			const end = data.indexOf(10);
			if (end < 0) return;
			received = true;
			let value;
			try {
				value = JSON.parse(data.subarray(0, end).toString());
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			} catch {
				reply(false);
				return;
			}
			data = Buffer.alloc(0);
			if (admittedRegistrations >= HUB_LIMITS.registrationOperations) {
				reply(false, void 0, "Registration rejected", "HUB_BUSY");
				return;
			}
			admittedRegistrations++;
			pending = pending.then(async () => {
				if (socket.destroyed) return;
				try {
					const result = await register(value);
					if ("unsupported" in result) {
						const { unsupported: _unsupported, ...details } = result;
						if (!socket.destroyed) socket.end(`${JSON.stringify({
							ok: false,
							error: "Unsupported registration protocol",
							code: "UNSUPPORTED_PROTOCOL",
							...details
						})}\n`);
					} else reply(true, result);
				} catch (error) {
					reply(false, void 0, error instanceof Error && error.message === "ended generation" ? "ended generation" : "Registration rejected", error instanceof RegistryError ? error.code : error instanceof StateBudgetError ? "STATE_QUOTA" : void 0);
				}
			}).finally(() => {
				admittedRegistrations--;
			});
		});
	});
	const allowedBrowser = (request, requireOrigin = false, admin = false) => {
		const local = admin ? managementUrl : url;
		const canonical = admin ? config.management?.publicUrl : config.publicUrl;
		if (!local) return false;
		const allowed = new Set([new URL(local).origin, ...canonical ? [new URL(canonical).origin] : []]);
		const hosts = new Set([...allowed].map((origin) => new URL(origin).host));
		const origin = request.headers.origin;
		return hosts.has(request.headers.host ?? "") && request.headers["sec-fetch-site"] !== "cross-site" && (origin === void 0 ? !requireOrigin : allowed.has(origin) && (!admin || new URL(origin).host === request.headers.host));
	};
	const routePattern = new RegExp(`^/s/(${HUB_GENERATION_SOURCE})(/.*)?$`);
	const matchRoute = (request) => routePattern.exec(request.url ?? "");
	const fail = (response, code) => response.writeHead(code, { "Cache-Control": "no-store" }).end();
	const handle = async (request, response, admin = false) => {
		try {
			if (!allowedBrowser(request, false, admin)) {
				fail(response, 403);
				return;
			}
			const pathname = request.url?.split("?")[0];
			if (admin) {
				if (config.management?.gateway && !gatewayIdentity(config, request)) {
					fail(response, 401);
					return;
				}
				if (await gateManagementApi.handle(request, response, allowedBrowser(request, true, true))) return;
				if (await interactionApi?.handle(request, response, allowedBrowser(request, request.method !== "GET", true))) return;
				if (await restartApi.handle(request, response, allowedBrowser(request, true, true))) return;
				if (![
					"/",
					"/sessions/",
					"/api/sessions",
					"/hub.js",
					"/hub-management.js",
					"/hub.css",
					"/interaction-page.js",
					"/interaction-page.css"
				].includes(pathname ?? "") && !new RegExp(`^/interactions/${HUB_GENERATION_SOURCE}/[a-f0-9]{32}/$`).test(pathname ?? "") || request.headers["service-worker"] !== void 0) {
					fail(response, 404);
					return;
				}
			} else if (pathname?.startsWith("/api/management/")) {
				if (request.method === "GET" && pathname === "/api/management/status") response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({
					available: false,
					authorized: false,
					...managementUrl ? { managementUrl: config.management?.publicUrl ?? managementUrl } : {}
				}));
				else fail(response, 404);
				return;
			}
			if (pathname === "/api/session-handoff") {
				if (request.method !== "POST") {
					fail(response, 405);
					return;
				}
				if (!allowedBrowser(request, true)) {
					fail(response, 403);
					return;
				}
				pruneHandoffs();
				const token = request.headers["x-pi-web-handoff"];
				const item = typeof token === "string" && /^[a-f0-9]{48}$/.test(token) ? handoffs.get(token) : void 0;
				if (!item) {
					fail(response, 410);
					return;
				}
				const grant = readGrant(config, item.grant.run_id);
				if (grant.revoked || !equal(grant.token, item.grant.token) || grant.backendHost !== item.grant.backendHost) {
					handoffs.delete(token);
					fail(response, 410);
					return;
				}
				if (item.restart) {
					try {
						const result = await restartApi.resolve(item.restart.id);
						if (item.expires <= Date.now() || !granted(item.grant.run_id)) throw new Error();
						if (result.status === "succeeded" && typeof result.path === "string") response.writeHead(200, {
							"Content-Type": "application/json",
							"Cache-Control": "no-store"
						}).end(JSON.stringify({ path: result.path }));
						else if ([
							"pending",
							"queued",
							"running"
						].includes(result.status)) response.writeHead(202, {
							"Content-Type": "application/json",
							"Cache-Control": "no-store"
						}).end(JSON.stringify({ pending: true }));
						else fail(response, 410);
					} catch {
						fail(response, 410);
					}
					return;
				}
				const targetGeneration = item.successor ?? item.from;
				const successor = current(targetGeneration);
				const proved = successor && await proof(grant, successor.generation, successor.port);
				const latestGrant = readGrant(config, grant.run_id);
				if (stopped || handoffs.get(token) !== item || item.expires <= Date.now() || latestGrant.revoked || !equal(latestGrant.token, grant.token) || latestGrant.backendHost !== grant.backendHost) {
					handoffs.delete(token);
					fail(response, 410);
					return;
				}
				if (!item.successor && (!proved || current(targetGeneration) !== successor) || targetGeneration !== item.successor && item.successor && current(item.successor)) {
					response.writeHead(202, {
						"Content-Type": "application/json",
						"Cache-Control": "no-store"
					}).end(JSON.stringify({ pending: true }));
					return;
				}
				if (!successor || successor.grant.run_id !== grant.run_id || !proved || stopped || current(targetGeneration) !== successor || item.originalRuntimeId !== void 0 && successor.runtime?.runtimeId !== item.originalRuntimeId || item.expires <= Date.now()) {
					fail(response, 410);
					return;
				}
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({ path: `/s/${successor.generation}/` }));
				return;
			}
			const route = matchRoute(request);
			if (route) {
				const session = current(route[1]);
				if (!session) {
					fail(response, 410);
					return;
				}
				if (!route[2]) {
					response.writeHead(308, {
						Location: `/s/${route[1]}/`,
						"Cache-Control": "no-store"
					}).end();
					return;
				}
				if (!await proof(session.grant, session.generation, session.port)) {
					retire(session.generation);
					fail(response, 410);
					return;
				}
				if (stopped || current(session.generation) !== session || response.destroyed) {
					fail(response, 410);
					return;
				}
				const upstream = http.request({
					host: session.grant.backendHost,
					port: session.port,
					path: route[2],
					method: request.method,
					headers: backendHeaders(request, session),
					agent: false
				}, (result) => {
					proxySessionResponse(request, response, result, route[2]);
				});
				upstream.setTimeout(3e4, () => upstream.destroy());
				upstream.on("error", () => {
					if (!response.headersSent) fail(response, 502);
					else response.destroy();
				});
				response.once("close", () => upstream.destroy());
				request.pipe(upstream);
				return;
			}
			if (!["GET", "HEAD"].includes(request.method ?? "")) {
				fail(response, 405);
				return;
			}
			if (pathname === "/") {
				response.writeHead(302, {
					Location: "/sessions/",
					"Cache-Control": "no-store"
				}).end();
				return;
			}
			if (pathname === "/api/sessions") {
				versionStatus.ensureStarted();
				const items = listSessions().map((session) => ({
					...session,
					path: admin ? `${config.publicUrl ?? url}s/${session.generation}/` : session.path
				}));
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({
					sessions: items,
					versions: versionStatus.snapshot()
				}));
				return;
			}
			const asset = admin && new RegExp(`^/interactions/${HUB_GENERATION_SOURCE}/[a-f0-9]{32}/$`).test(pathname ?? "") ? ["text/html", renderInteractionPageHtml()] : admin && pathname === "/interaction-page.js" ? ["text/javascript", interactionPageJs] : admin && pathname === "/interaction-page.css" ? ["text/css", interactionPageCss] : pathname === "/sessions/" ? ["text/html", renderPortalHtml(admin, config.publicUrl ?? url, config.management?.publicUrl ?? managementUrl, config.managerLinks)] : pathname === "/hub.js" ? ["text/javascript", portalJs] : admin && pathname === "/hub-management.js" ? ["text/javascript", portalManagementJs] : pathname === "/hub.css" ? ["text/css", portalCss + portalManagementCss] : void 0;
			if (!asset) {
				fail(response, pathname?.startsWith("/s/") ? 410 : 404);
				return;
			}
			response.writeHead(200, {
				"Content-Type": `${asset[0]}; charset=utf-8`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
			}).end(request.method === "HEAD" ? void 0 : asset[1]);
		} catch (error) {
			if (!response.headersSent) fail(response, error instanceof RegistryError && error.code === "HUB_BUSY" ? 503 : 500);
			else response.destroy();
		}
	};
	const server = http.createServer((request, response) => void handle(request, response));
	const managementServer = config.management ? http.createServer((request, response) => void handle(request, response, true)) : void 0;
	managementServer?.on("connection", (socket) => {
		if (connections.size >= HUB_LIMITS.connections) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => connections.delete(socket));
	});
	managementServer?.on("clientError", (_error, socket) => socket.destroy());
	managementServer?.on("upgrade", (_request, socket) => socket.destroy());
	managementServer?.on("connect", (_request, socket) => socket.destroy());
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: HUB_LIMITS.inFlightBytes,
		perMessageDeflate: {
			serverNoContextTakeover: true,
			clientNoContextTakeover: true,
			serverMaxWindowBits: 12,
			clientMaxWindowBits: 12,
			concurrencyLimit: HUB_LIMITS.websocketCompression,
			threshold: 1024,
			zlibDeflateOptions: {
				level: 3,
				memLevel: 7
			}
		}
	});
	server.on("connection", (socket) => {
		if (connections.size >= HUB_LIMITS.connections) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => connections.delete(socket));
	});
	const rejectUpgrade = (socket, code) => {
		const timer = setTimeout(() => socket.destroy(), 500);
		timer.unref();
		socket.once("close", () => clearTimeout(timer));
		socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
	};
	let browserAdmissions = 0;
	server.on("upgrade", async (request, socket, head) => {
		let reserved = false;
		let upgradePending = true;
		let browserClosed = false;
		let upstreamSocket;
		let upstreamClosed = false;
		const release = () => {
			if (reserved && !upgradePending && browserClosed && (!upstreamSocket || upstreamClosed)) {
				reserved = false;
				browserAdmissions--;
			}
		};
		try {
			if (!allowedBrowser(request, true)) {
				rejectUpgrade(socket, 403);
				return;
			}
			if (browserAdmissions >= HUB_LIMITS.browserPairs) {
				rejectUpgrade(socket, 503);
				return;
			}
			browserAdmissions++;
			reserved = true;
			socket.once("close", () => {
				browserClosed = true;
				upstreamSocket?.terminate();
				release();
			});
			const route = matchRoute(request);
			const session = route && route[2] === "/ws" ? current(route[1]) : void 0;
			if (!session || !await proof(session.grant, session.generation, session.port) || stopped || current(session.generation) !== session) {
				if (!socket.destroyed) rejectUpgrade(socket, 410);
				return;
			}
			if (browserClosed || socket.destroyed || !reserved) return;
			const host = net.isIP(session.grant.backendHost) === 6 ? `[${session.grant.backendHost}]` : session.grant.backendHost;
			const headers = backendHeaders(request, session);
			delete headers["sec-websocket-extensions"];
			const upstream = new WebSocket(`ws://${host}:${session.port}/ws`, {
				headers,
				perMessageDeflate: false,
				handshakeTimeout: 3e3,
				maxPayload: HUB_LIMITS.inFlightBytes
			});
			upstreamSocket = upstream;
			webSockets.set(upstream, session.generation);
			const handshakeError = () => {
				if (!socket.destroyed) rejectUpgrade(socket, 502);
			};
			upstream.once("error", handshakeError);
			upstream.once("close", () => {
				upstreamClosed = true;
				webSockets.delete(upstream);
				release();
			});
			upstream.once("open", () => {
				upstream.removeListener("error", handshakeError);
				upstream.on("error", () => socket.destroy());
				if (stopped || current(session.generation) !== session || socket.destroyed) {
					upstream.terminate();
					socket.destroy();
					return;
				}
				if (!boundedDeflateOffer(request.headers["sec-websocket-extensions"])) delete request.headers["sec-websocket-extensions"];
				wss.handleUpgrade(request, socket, head, (client) => {
					webSockets.set(client, session.generation);
					let slowClosing = false;
					const slowPair = () => {
						if (slowClosing) return;
						slowClosing = true;
						for (const peer of [client, upstream]) {
							if (peer.readyState === WebSocket.OPEN) peer.close(1013, "Slow consumer; reconnect");
							const timer = setTimeout(() => peer.terminate(), 250);
							timer.unref();
							peer.once("close", () => clearTimeout(timer));
						}
					};
					const clientQueue = new ForwardQueue(client, slowPair);
					const upstreamQueue = new ForwardQueue(upstream, slowPair);
					outbound.set(client, clientQueue);
					const forward = (from, to) => {
						const queue = to === client ? clientQueue : upstreamQueue;
						from.on("message", (data, binary) => {
							if (slowClosing) return;
							if (from === upstream && !binary) try {
								const value = JSON.parse(data.toString());
								if (value?.type === "event" && value.event === "hub_route") return;
							} catch {}
							if (!queue.enqueue(data, binary)) slowPair();
						});
						from.once("close", () => {
							webSockets.delete(from);
							outbound.delete(from);
							clientQueue.dispose();
							upstreamQueue.dispose();
							if (!slowClosing) to.terminate();
						});
						from.on("error", () => to.terminate());
					};
					forward(client, upstream);
					forward(upstream, client);
					pruneHandoffs();
					if (handoffs.size < 512) {
						const token = randomBytes(24).toString("hex");
						const restart = restarting.get(session.generation);
						const activeRestart = restart && (restart.deadline === void 0 || restart.deadline > Date.now()) ? restart : void 0;
						const item = {
							grant: session.grant,
							from: session.generation,
							expires: activeRestart?.deadline ?? Infinity,
							client,
							restart: activeRestart
						};
						handoffs.set(token, item);
						client.once("close", () => {
							item.client = void 0;
							activateRestart(item.from);
							item.expires = item.restart?.deadline ?? Date.now() + 45e3;
						});
						sendControl(client, JSON.stringify({
							type: "event",
							event: "hub_route",
							payload: {
								generation: session.generation,
								token,
								...activeRestart ? { restart: {
									id: activeRestart.id,
									timeoutMs: 12e4
								} } : {}
							}
						}));
					}
				});
			});
		} catch {
			upstreamSocket?.terminate();
			if (!socket.destroyed) rejectUpgrade(socket, 502);
		} finally {
			upgradePending = false;
			release();
		}
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	const listen = (target, address, host) => new Promise((resolve, reject) => {
		target.once("error", reject);
		const ready = () => {
			target.removeListener("error", reject);
			resolve();
		};
		if (typeof address === "string") target.listen(address, ready);
		else target.listen(address, host, ready);
	});
	try {
		await listen(registry, config.socketPath);
		chmodSync(config.socketPath, 384);
		await listen(server, config.port, config.host);
		const port = server.address().port;
		url = `http://${config.host === "::1" ? "[::1]" : config.host}:${port}/`;
		if (managementServer && config.management) {
			await listen(managementServer, config.management.port, "127.0.0.1");
			managementUrl = `http://127.0.0.1:${managementServer.address().port}/`;
			const chatOrigins = [new URL(url).origin, ...config.publicUrl ? [new URL(config.publicUrl).origin] : []];
			if ([managementUrl, config.management.publicUrl].some((value) => value && chatOrigins.includes(new URL(value).origin))) throw new Error("Management origin must differ from chat origin");
		}
	} catch (error) {
		stopped = true;
		interactionApi?.close();
		versionStatus.close();
		for (const peer of peers) peer.destroy();
		for (const connection of connections) connection.destroy();
		await Promise.all([
			new Promise((resolve) => registry.close(() => resolve())),
			new Promise((resolve) => server.close(() => resolve())),
			...managementServer ? [new Promise((resolve) => managementServer.close(() => resolve()))] : []
		]);
		throw error;
	}
	const sweep = setInterval(() => {
		for (const id of sessions.keys()) current(id);
		pruneHandoffs();
		for (const [generation, item] of restarting) if (item.deadline !== void 0 && item.deadline <= Date.now()) restarting.delete(generation);
	}, Math.min(1e3, config.leaseMs));
	sweep.unref();
	let closing;
	return {
		url,
		...managementUrl ? { managementUrl } : {},
		socketPath: config.socketPath,
		listSessions,
		/** Host-local launcher lookup only; never exposes a registration token. */
		sessionPath(runId) {
			const matches = [...sessions.values()].filter((session) => session.grant.run_id === runId && session.expires > Date.now());
			return !stopped && matches.length === 1 ? `/s/${matches[0].generation}/` : void 0;
		},
		/** Local readiness only; never exposed as a public control-plane endpoint. */
		async isRunReady(runId) {
			if (stopped || !/^[a-f0-9]{32}$/.test(runId)) return false;
			const matches = [...sessions.values()].filter((s) => s.grant.run_id === runId);
			if (matches.length !== 1) return false;
			const session = matches[0];
			const live = () => {
				if (stopped || session.expires <= Date.now() || sessions.get(session.generation) !== session) return false;
				const grant = readGrant(config, runId);
				return !grant.revoked && equal(grant.token, session.grant.token) && grant.backendHost === session.grant.backendHost;
			};
			try {
				return live() && await proof(session.grant, session.generation, session.port) && live();
			} catch {
				return false;
			}
		},
		close() {
			if (closing) return closing;
			stopped = true;
			interactionApi?.close();
			handoffs.clear();
			versionStatus.close();
			clearInterval(sweep);
			for (const id of sessions.keys()) retire(id);
			for (const peer of peers) peer.destroy();
			for (const connection of connections) connection.destroy();
			server.closeAllConnections();
			managementServer?.closeAllConnections();
			closing = Promise.all([
				new Promise((resolve) => server.close(() => resolve())),
				new Promise((resolve) => registry.close(() => resolve())),
				new Promise((resolve) => wss.close(() => resolve())),
				...managementServer ? [new Promise((resolve) => managementServer.close(() => resolve()))] : [],
				pending
			]).then(() => {});
			return closing;
		}
	};
}
//#endregion
//#region bin/pi-web-hub.mjs
init_config();
var help = `Pi Web Hub — independent multi-session portal

  pi-manager init [--port 16180] [--public-url https://pi.example.com/]
    [--management-port 16181] [--management-public-url https://admin.example.com/]
  pi-manager serve
  pi-manager issue --label "Project A" --output /private/session-a.json [--backend-host 127.0.0.1]
  pi-manager revoke --run-id <session-capability-id>
  pi-manager pair                     Generate a single-use management code (10 minutes)
  pi-manager revoke-management        Revoke all browser management sessions

All commands accept --config <file> (default ~/.config/pi-manager/config.json).
The hub never launches agents or deploys SSH/TLS/login. See README.md.
Mount only the runtime directory and the individual credential into a Pi container;
never expose the hub administrator state directory to agents.
`;
async function main(args) {
	const command = args.shift();
	if (!command || command === "--help" || command === "help") {
		process.stdout.write(help);
		return;
	}
	const permitted = new Map([
		["init", [
			"--config",
			"--port",
			"--public-url",
			"--management-port",
			"--management-public-url"
		]],
		["serve", ["--config"]],
		["issue", [
			"--config",
			"--label",
			"--output",
			"--backend-host"
		]],
		["revoke", ["--config", "--run-id"]],
		["pair", ["--config"]],
		["revoke-management", ["--config"]]
	]).get(command);
	if (!permitted) throw new Error("Unknown hub command; use --help");
	const options = /* @__PURE__ */ new Map();
	while (args.length) {
		const key = args.shift();
		const value = args.shift();
		if (!permitted.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid hub arguments; use --help");
		options.set(key, value);
	}
	const configFile = path.resolve(options.get("--config") ?? process.env.PI_MANAGER_CONFIG ?? path.join(homedir(), ".config/pi-manager/config.json"));
	if (command === "init") {
		const port = options.has("--port") ? Number(options.get("--port")) : 16180;
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
		const publicUrl = options.get("--public-url");
		if (publicUrl !== void 0) {
			const { validatedPublicUrl } = await Promise.resolve().then(() => (init_connection_config(), connection_config_exports));
			if (new URL(validatedPublicUrl(publicUrl)).pathname !== "/") throw new Error("Hub public URL must use the domain root");
		}
		let management;
		if (options.has("--management-public-url") && !options.has("--management-port")) throw new Error("Management port required");
		if (options.has("--management-port")) {
			const { managementConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			management = managementConfig({
				port: Number(options.get("--management-port")),
				...options.has("--management-public-url") ? { publicUrl: options.get("--management-public-url") } : {}
			}, port, publicUrl);
		}
		initializeHub(configFile, {
			port,
			...publicUrl ? { publicUrl } : {},
			...management ? { management } : {}
		});
		process.stdout.write(`${JSON.stringify({
			configured: true,
			configFile
		})}\n`);
		return;
	}
	const config = readHubConfig(configFile);
	if (command === "pair") process.stdout.write(`${JSON.stringify(issueManagementCode(config))}\n`);
	else if (command === "revoke-management") {
		revokeManagement(config);
		process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
	} else if (command === "issue") {
		if (!options.has("--output") || !options.has("--label")) throw new Error("issue requires --output and --label");
		const credentialFile = path.resolve(options.get("--output"));
		const credential = issueSession(config, credentialFile, {
			label: options.get("--label"),
			backendHost: options.get("--backend-host")
		});
		process.stdout.write(`${JSON.stringify({
			runId: credential.run_id,
			credentialFile,
			socketPath: config.socketPath
		})}\n`);
	} else if (command === "revoke") {
		if (!options.has("--run-id")) throw new Error("revoke requires --run-id");
		revokeSession(config, options.get("--run-id"));
		process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
	} else if (command === "serve") {
		const hub = await startHub(config);
		process.stdout.write(`${JSON.stringify({
			localUrl: hub.url,
			portalUrl: `${config.publicUrl ?? hub.url}sessions/`,
			socketPath: hub.socketPath,
			...hub.managementUrl ? { managementUrl: hub.managementUrl } : {}
		})}\n`);
		let closing = false;
		const stop = () => {
			if (closing) return;
			closing = true;
			hub.close().then(() => {
				process.exitCode = 0;
			}).catch(() => {
				process.exitCode = 1;
			});
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	} else throw new Error("Unknown hub command; use --help");
}
main(process.argv.slice(2)).catch(() => {
	process.stderr.write("Pi Web Hub failed. Check arguments, private file permissions, configuration and port/socket availability. Use --help.\n");
	process.exitCode = 1;
});
//#endregion
export {};
