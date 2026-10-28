import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { keys, ManagerError, record, requireThat } from "../validation.ts";

export interface RuntimeProfile {
  readonly runtimeVolume?: string;
  readonly modelsFile?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly extensions?: readonly { readonly packageRoot: string; readonly entry: string }[];
}
const absolute = (v: unknown): string => {
  requireThat(typeof v === "string" && path.isAbsolute(v) && v !== "/" && path.resolve(v) === v && !v.includes("\0") && !v.includes("\\")); return v;
};
export function runtimeProfile(value: unknown): RuntimeProfile {
  const p = record(structuredClone(value)); keys(p, [], ["runtimeVolume", "modelsFile", "environment", "extensions"]);
  if (p.runtimeVolume !== undefined) requireThat(typeof p.runtimeVolume === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(p.runtimeVolume) && !p.runtimeVolume.startsWith("pi-manager-home-"));
  if (p.modelsFile !== undefined) absolute(p.modelsFile);
  if (p.environment !== undefined) {
    const env = record(p.environment); requireThat(Object.keys(env).length <= 32);
    let bytes = 0;
    for (const [key, value] of Object.entries(env)) {
      requireThat(/^[A-Z_][A-Z0-9_]*$/.test(key) && !["HOME", "PATH", "NODE_OPTIONS", "NODE_PATH"].includes(key) && !/^(LD_|PI_)/.test(key));
      requireThat(typeof value === "string" && !value.includes("\0")); bytes += Buffer.byteLength(`${key}=${value}\0`);
    }
    requireThat(bytes <= 8192); Object.freeze(env);
  }
  if (p.extensions !== undefined) {
    requireThat(Array.isArray(p.extensions) && p.extensions.length <= 16);
    for (const value of p.extensions) {
      const e = record(value); keys(e, ["packageRoot", "entry"]); absolute(e.packageRoot);
      requireThat(typeof e.entry === "string" && e.entry.length <= 512 && !/[\\\0]/.test(e.entry) && e.entry.split("/").every(s => s !== "" && s !== "." && s !== "..") && /\.(ts|js|mjs)$/.test(e.entry));
      Object.freeze(e);
    }
    Object.freeze(p.extensions);
  }
  return Object.freeze(p) as RuntimeProfile;
}
export const runtimeProfileSources = (p?: RuntimeProfile): string[] => p ? [...(p.modelsFile ? [p.modelsFile] : []), ...(p.extensions ?? []).map(e => e.packageRoot)] : [];

export async function validateRuntimeSources(profile: RuntimeProfile): Promise<void> {
  try {
    if (profile.modelsFile) {
      requireThat(await realpath(profile.modelsFile) === profile.modelsFile);
      const file = await open(profile.modelsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const info = await file.stat(); requireThat(info.isFile() && info.size <= 1024 * 1024); record(JSON.parse(await file.readFile("utf8"))); }
      finally { await file.close(); }
    }
    for (const e of profile.extensions ?? []) {
      requireThat(await realpath(e.packageRoot) === e.packageRoot && (await stat(e.packageRoot)).isDirectory());
      const entry = path.join(e.packageRoot, e.entry);
      requireThat(await realpath(entry) === entry && (await stat(entry)).isFile());
    }
  } catch { throw new ManagerError(400); }
}

export function runtimeProfileMounts(p?: RuntimeProfile) {
  return p ? [
    ...(p.runtimeVolume ? [{ Type: "volume", Source: p.runtimeVolume, Target: "/home/node/.local", ReadOnly: true, VolumeOptions: { NoCopy: true } }] : []),
    ...(p.modelsFile ? [{ Type: "bind", Source: p.modelsFile, Target: "/home/node/.pi/manager-agent/models.json", ReadOnly: true }] : []),
    ...(p.extensions ?? []).map((e, i) => ({ Type: "bind", Source: e.packageRoot, Target: `/opt/pi-profile/extensions/${i}`, ReadOnly: true })),
  ] : [];
}
