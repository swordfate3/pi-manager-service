import { constants } from "node:fs";
import { open } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { absolute } from "../config.ts";
import { identifier, keys, ManagerError, record, requireThat, taskId, token } from "../validation.ts";

export interface EnrollmentConfig {
  socketPath: string; authorityFile: string; registryHostDirectory: string; exportHostDirectory: string;
}
export function enrollmentConfig(value: unknown): EnrollmentConfig {
  const e = record(structuredClone(value)); keys(e, ["socketPath", "authorityFile", "registryHostDirectory", "exportHostDirectory"]);
  for (const p of Object.values(e)) requireThat(absolute(p) !== "/" && !(p as string).includes("\\"));
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  const paths = [path.dirname(e.socketPath as string), e.authorityFile as string, e.registryHostDirectory as string, e.exportHostDirectory as string];
  requireThat(!paths.some((a, i) => paths.slice(i + 1).some(b => overlaps(a, b))));
  return Object.freeze(e) as unknown as EnrollmentConfig;
}
/** Nonblocking descriptor checks precede reads, including for FIFOs/devices. */
export async function readEnrollmentAuthority(file: string): Promise<string> {
  try {
    const handle = await open(absolute(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await handle.stat();
      requireThat(s.isFile() && s.uid === process.getuid?.() && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= 8192, 403);
      const value = record(JSON.parse(await handle.readFile("utf8"))); keys(value, ["token"]);
      return token(value.token);
    } finally { await handle.close(); }
  } catch { throw new ManagerError(403); }
}

export class EnrollmentClient {
  readonly #config: EnrollmentConfig;
  readonly #active = new Set<http.ClientRequest>();
  #closed = false;
  constructor(config: EnrollmentConfig) { this.#config = structuredClone(config); }
  async #call(operation: "issue" | "status", key: string, label: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const data = JSON.stringify({ key: taskId(key), label: identifier(label) });
    requireThat(!this.#closed && this.#active.size < 16, 503);
    const authority = await readEnrollmentAuthority(this.#config.authorityFile);
    requireThat(!this.#closed && this.#active.size < 16, 503);
    return new Promise((resolve, reject) => {
      let done = false;
      const req = http.request({ socketPath: this.#config.socketPath, path: `/${operation}`, method: "POST", agent: false,
        headers: { host: "pi-enrollment", authorization: `Bearer ${authority}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) } });
      this.#active.add(req);
      const finish = (value?: Record<string, unknown>) => {
        if (done) return; done = true; clearTimeout(timer); this.#active.delete(req); req.destroy();
        if (value) resolve(value); else reject(new ManagerError(503));
      };
      const timer = setTimeout(() => finish(), Math.max(1, Math.min(timeoutMs, 5000)));
      req.on("error", () => finish());
      req.on("response", res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("error", () => finish()); res.on("aborted", () => finish());
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024) finish(); else chunks.push(chunk); });
        res.on("end", () => {
          if (done) return;
          try {
            requireThat(res.statusCode === 200);
            const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            keys(value, operation === "issue" ? ["ok"] : ["ready"]);
            requireThat(operation === "issue" ? value.ok === true : typeof value.ready === "boolean");
            finish(value);
          } catch { finish(); }
        });
      }); req.end(data);
    });
  }
  async issue(key: string, label: string): Promise<void> { await this.#call("issue", key, label); }
  async status(key: string, label: string, timeoutMs?: number): Promise<boolean> { return (await this.#call("status", key, label, timeoutMs)).ready === true; }
  close() { this.#closed = true; for (const req of this.#active) req.destroy(); }
}
