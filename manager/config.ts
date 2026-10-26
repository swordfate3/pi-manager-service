import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeBackendConfig } from "./backends/native.ts";
import type { DockerBackendConfig } from "./backends/docker.ts";
import { identifier, keys, record, requireThat } from "./validation.ts";

export interface ServiceConfig { socketPath: string; origin: string; chatOrigin: string; port: number }
export interface ExecutorConfig {
  stateRoot: string; submitSocket: string; adminSocket: string;
  principals: { id: string; role: "submitter" | "admin"; tokenHash: string }[];
  trustedLocalNative: boolean; native: NativeBackendConfig | null;
  docker?: DockerBackendConfig | null;
  workspaces: Record<string, { label: string; root: string; path: string }>;
  recoverStaleLock?: boolean; socketMode?: number;
}
export function absolute(value: unknown): string {
  requireThat(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && path.resolve(value) === value); return value;
}
export function origin(value: unknown): string {
  requireThat(typeof value === "string"); const u = new URL(value);
  requireThat(u.origin === value && ["http:", "https:"].includes(u.protocol));
  // Plain HTTP credentials are allowed only on the private loopback entry.
  requireThat(u.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)); return value;
}
export function serviceConfig(value: unknown): ServiceConfig {
  const c = record(value); keys(c, ["socketPath", "origin", "chatOrigin", "port"]);
  const result = { socketPath: absolute(c.socketPath), origin: origin(c.origin), chatOrigin: origin(c.chatOrigin), port: c.port as number };
  requireThat(result.origin !== result.chatOrigin && Number.isInteger(result.port) && result.port >= 0 && result.port <= 65535);
  return Object.freeze(result);
}
export function executorConfig(value: unknown): ExecutorConfig {
  const c = record(structuredClone(value));
  keys(c, ["stateRoot", "submitSocket", "adminSocket", "principals", "trustedLocalNative", "native", "workspaces"], ["docker", "recoverStaleLock", "socketMode"]);
  absolute(c.stateRoot); absolute(c.submitSocket); absolute(c.adminSocket);
  requireThat(path.dirname(c.submitSocket as string) !== path.dirname(c.adminSocket as string));
  requireThat(typeof c.trustedLocalNative === "boolean");
  requireThat(c.recoverStaleLock === undefined || typeof c.recoverStaleLock === "boolean");
  requireThat(c.socketMode === undefined || [0o600, 0o660].includes(c.socketMode as number));
  requireThat(Array.isArray(c.principals) && c.principals.length > 0 && c.principals.length <= 100);
  const ids = new Set(); const hashes = new Set();
  for (const p of c.principals) {
    const principal = record(p); keys(principal, ["id", "role", "tokenHash"]); identifier(principal.id);
    requireThat(["admin", "submitter"].includes(principal.role as string) && typeof principal.tokenHash === "string" && /^[0-9a-f]{64}$/.test(principal.tokenHash));
    requireThat(!ids.has(principal.id) && !hashes.has(principal.tokenHash)); ids.add(principal.id); hashes.add(principal.tokenHash);
  }
  const workspaces = record(c.workspaces); requireThat(Object.keys(workspaces).length <= 100);
  requireThat(c.native === null || c.docker == null);
  if (c.docker != null) {
    const d = record(c.docker);
    keys(d, ["socketPath", "daemonId", "image", "pathCoordinates", "stateRoot", "workspaceRoots"], ["protectedRoots", "timeoutMs", "entrypoint", "command", "web"]);
    const dockerPath = (v: unknown) => { const p = absolute(v); requireThat(p !== path.parse(p).root); return p; };
    const overlaps = (a: string, b: string) => {
      const contains = (root: string, value: string) => { const r = path.relative(root, value); return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
      return contains(a, b) || contains(b, a);
    };
    dockerPath(d.socketPath); dockerPath(d.stateRoot);
    requireThat(d.pathCoordinates === "host" && typeof d.daemonId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(d.daemonId));
    requireThat(typeof d.image === "string" && /^sha256:[a-f0-9]{64}$/.test(d.image));
    requireThat(d.timeoutMs === undefined || (Number.isSafeInteger(d.timeoutMs) && (d.timeoutMs as number) >= 1 && (d.timeoutMs as number) <= 120000));
    for (const args of [d.entrypoint, d.command]) if (args !== undefined) {
      requireThat(Array.isArray(args) && args.length > 0 && args.length <= 64 && args.every(a => typeof a === "string" && a.length > 0 && a.length <= 8192 && !a.includes("\0")));
    }
    // Reserve three protected-path slots for executor authority, independent of administrator additions.
    requireThat(d.protectedRoots === undefined || (Array.isArray(d.protectedRoots) && d.protectedRoots.length <= 61));
    const protectedPaths = [c.stateRoot as string, path.dirname(c.submitSocket as string), path.dirname(c.adminSocket as string),
      d.stateRoot as string, d.socketPath as string, fileURLToPath(new URL("..", import.meta.url)),
      ...((d.protectedRoots ?? []) as unknown[]).map(dockerPath)];
    if (d.web !== undefined) {
      const w = record(d.web); keys(w, ["packageRoot", "hubConfigFile", "port"], ["provider"]);
      protectedPaths.push(dockerPath(w.packageRoot), dockerPath(w.hubConfigFile));
      requireThat(Number.isInteger(w.port) && (w.port as number) >= 1 && (w.port as number) <= 65535 && d.command === undefined && d.entrypoint === undefined);
      if (w.provider !== undefined) {
        const p = record(w.provider); keys(p, ["packageRoot", "name", "model"]); protectedPaths.push(dockerPath(p.packageRoot));
        requireThat([p.name,p.model].every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(v)));
      }
    }
    requireThat(!overlaps(c.stateRoot as string, d.stateRoot as string));
    const roots = record(d.workspaceRoots);
    requireThat(Object.keys(roots).length > 0 && Object.keys(roots).length <= 32);
    for (const [name, value] of Object.entries(roots)) {
      identifier(name); const root = dockerPath(value);
      requireThat(!protectedPaths.some(p => overlaps(root, p)));
    }
  }
  if (c.native !== null) {
    requireThat(c.trustedLocalNative === true, 403);
    const n = record(c.native);
    keys(n, ["piExecutable", "workspaceRoots", "stateRoot", "agentRoot"], ["provider", "web", "startupTimeoutMs", "rpcTimeoutMs", "generationTimeoutMs", "stopTimeoutMs", "maxFrameBytes", "maxStderrBytes"]);
    absolute(n.piExecutable); absolute(n.stateRoot); absolute(n.agentRoot);
    for (const [id, root] of Object.entries(record(n.workspaceRoots))) { identifier(id); absolute(root); }
    if (n.provider !== undefined) { const p = record(n.provider); keys(p, ["extensionPath", "name", "model"]); absolute(p.extensionPath); }
    if (n.web !== undefined) {
      const web = record(n.web); keys(web, ["extensionPath", "hubConfigFile", "port"]);
      absolute(web.extensionPath); absolute(web.hubConfigFile);
      requireThat(Number.isInteger(web.port) && (web.port as number) >= 1 && (web.port as number) <= 65535);
    }
  }
  for (const [id, value] of Object.entries(workspaces)) {
    identifier(id); const w = record(value); keys(w, ["label", "root", "path"]); identifier(w.root);
    requireThat(typeof w.label === "string" && w.label.length > 0 && w.label.length <= 100 && !/[\x00-\x1f]/.test(w.label));
    requireThat(typeof w.path === "string" && w.path.length <= 512 && !path.isAbsolute(w.path) && !w.path.includes("\\") && !w.path.includes("\0") && !w.path.split("/").includes(".."));
    const backend = (c.docker ?? c.native) as DockerBackendConfig | NativeBackendConfig | null;
    requireThat(backend !== null && Object.hasOwn(backend.workspaceRoots, w.root as string));
  }
  return c as unknown as ExecutorConfig;
}

/** Provisioning owns OS users/groups/mounts; checking a mode is NOT proof of isolation. */
export async function privateDirectory(directory: string, allowGroupSearch = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const s = await lstat(directory);
  requireThat(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & (allowGroupSearch ? 0o027 : 0o077)) === 0 && await realpath(directory) === directory, 403);
}
export async function readPrivateJson(file: string): Promise<unknown> {
  const handle = await open(absolute(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    requireThat(s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0 && s.size <= 1024 * 1024, 403);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
