import path from "node:path";
import { absolute } from "./config.ts";
import { identifier, keys, record, requireThat } from "./validation.ts";
import { workspaceSelection } from "./workspaces.ts";
import type { WorkspaceSelection } from "./api.ts";

export interface LocalConfig {
  port: number; chatPort: number; home: string; workspaceRoots: Record<string, string>;
  defaultWorkspace: WorkspaceSelection; stateRoot: string; launcher: string; hubCli: string;
  host?: "127.0.0.1"; protectedRoots?: string[]; dockerExecutable?: string; startupTimeoutMs?: number;
  publicOrigin?:string;
}
export function localConfig(value: unknown): LocalConfig {
  const c = record(structuredClone(value));
  keys(c, ["port", "chatPort", "home", "workspaceRoots", "defaultWorkspace", "stateRoot", "launcher", "hubCli"],
    ["host", "protectedRoots", "dockerExecutable", "startupTimeoutMs", "publicOrigin"]);
  requireThat(c.host === undefined || c.host === "127.0.0.1");
  for (const port of [c.port, c.chatPort]) requireThat(Number.isInteger(port) && (port === 0 || (Number(port) >= 1024 && Number(port) <= 65535)));
  requireThat(c.port === 0 || c.port !== c.chatPort);
  for (const key of ["home", "stateRoot", "launcher", "hubCli"]) requireThat(absolute(c[key]) !== "/");
  if (c.dockerExecutable !== undefined) absolute(c.dockerExecutable);
  const roots = record(c.workspaceRoots); requireThat(Object.keys(roots).length > 0 && Object.keys(roots).length <= 32);
  for (const [id, root] of Object.entries(roots)) {
    identifier(id); const relative = path.relative(c.home as string, absolute(root));
    requireThat(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  c.defaultWorkspace = workspaceSelection(c.defaultWorkspace); requireThat(Object.hasOwn(roots, (c.defaultWorkspace as WorkspaceSelection).root));
  requireThat(c.protectedRoots === undefined || Array.isArray(c.protectedRoots) && c.protectedRoots.length <= 64);
  for (const root of (c.protectedRoots ?? []) as unknown[]) absolute(root);
  requireThat(c.startupTimeoutMs === undefined || Number.isSafeInteger(c.startupTimeoutMs) && Number(c.startupTimeoutMs) >= 100 && Number(c.startupTimeoutMs) <= 300000);
  if(c.publicOrigin !== undefined) {
    requireThat(typeof c.publicOrigin === "string");
    let origin:URL; try { origin=new URL(c.publicOrigin); } catch { throw new Error("Invalid HTTPS publicOrigin"); }
    requireThat(origin.protocol === "https:" && origin.origin === c.publicOrigin && !origin.username && !origin.password && !origin.search && !origin.hash);
  }
  return c as unknown as LocalConfig;
}
