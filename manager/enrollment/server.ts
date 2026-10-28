import { chmod, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { issueSession, privateDirectory as privateHubDirectory, provisionGrant, type HubConfig } from "../../hub/config.ts";
import { withStateWriter } from "../../hub/state-budget.ts";
import { absolute, privateDirectory } from "../config.ts";
import { bearer, header, jsonBody, listen, reply } from "../http.ts";
import { digest, equalHash, identifier, keys, ManagerError, record, requireThat, taskId } from "../validation.ts";

export interface ProvisioningConfig {
  socketPath: string; exportDir: string; tokenHash: string; socketMode?: 0o600 | 0o660;
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export function provisioningConfig(value: unknown): ProvisioningConfig {
  const p = record(structuredClone(value)); keys(p, ["socketPath", "exportDir", "tokenHash"], ["socketMode"]);
  requireThat(absolute(p.socketPath) !== "/" && absolute(p.exportDir) !== "/");
  requireThat(typeof p.tokenHash === "string" && /^[a-f0-9]{64}$/.test(p.tokenHash));
  requireThat(p.socketMode === undefined || p.socketMode === 0o600 || p.socketMode === 0o660);
  return Object.freeze(p) as unknown as ProvisioningConfig;
}

/** Private, bounded enrollment only. No Docker authority or capability responses. */
export async function startEnrollmentBroker(hub: HubConfig, input: ProvisioningConfig, ready: (runId: string) => Promise<boolean>) {
  const config = provisioningConfig(input);
  // Owner-only registry and export binds must be usable by the fixed Pi UID.
  requireThat(process.getuid?.() === 1000, 403);
  const parent = path.dirname(config.socketPath);
  requireThat(![hub.stateDir, hub.runtimeDir, config.exportDir].some(p => overlaps(parent, p)) &&
    ![hub.stateDir, hub.runtimeDir].some(p => overlaps(config.exportDir, p)), 403);
  await privateDirectory(parent, config.socketMode === 0o660);
  for (const p of [config.exportDir, hub.stateDir, path.join(hub.stateDir, "grants"), hub.runtimeDir]) {
    privateHubDirectory(p); requireThat(await realpath(p) === p, 403);
  }
  // Never unlink an existing endpoint (including an apparently stale socket).
  try { await lstat(config.socketPath); throw new ManagerError(409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = await listen(async (req, res) => {
    requireThat(equalHash(digest(bearer(req)), config.tokenHash), 401);
    requireThat(header(req, "host") === "pi-enrollment", 403);
    requireThat(req.method === "POST" && ["/issue", "/status"].includes(req.url ?? ""), 404);
    requireThat(header(req, "origin") === undefined, 403);
    const input = record(await jsonBody(req)); keys(input, ["key", "label"]);
    const key = taskId(input.key), label = identifier(input.label);
    try {
      if (req.url === "/issue") {
        issueSession(hub, path.join(config.exportDir, `registration-${key}.json`), { label, provisionKey: key });
        reply(res, 200, { ok: true });
      } else {
        const grant = withStateWriter(hub, writer => { writer.assertAdmission(); return provisionGrant(hub, key); });
        requireThat(!grant || grant.label === label, 409);
        const isReady = !!grant && !grant.revoked && await ready(grant.run_id);
        reply(res, 200, { ready: isReady });
      }
    } catch { throw new ManagerError(409); }
  }, config.socketPath);
  try { await chmod(config.socketPath, config.socketMode ?? 0o600); }
  catch (error) { await server.close(); throw error; }
  return server;
}
