import { lstat, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { strictJson } from "../updates/json.ts";
import type { NativeRuntimeSnapshot } from "./native.ts";

export type RuntimeCommand = { action: "snapshot" } | { action: "cancel"; operation_id: string } |
  { action: "prepare"; operation_id: string; expected: { runtime_id: string; session_id: string; leaf_id: string | null } } |
  { action: "commit"; operation_id: string; expected: NativeRuntimeSnapshot };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
function command(value: RuntimeCommand): RuntimeCommand {
  if (!object(value)) throw Error("Invalid runtime request");
  const expectedKeys = value.action === "snapshot" ? "action" : value.action === "cancel" ? "action,operation_id" :
    value.action === "prepare" || value.action === "commit" ? "action,expected,operation_id" : "";
  if (!expectedKeys || Object.keys(value).sort().join() !== expectedKeys ||
    (value.action !== "snapshot" && !/^[a-f0-9]{32}$/.test(value.operation_id))) throw Error("Invalid runtime request");
  if (value.action === "prepare" && (!object(value.expected) || Object.keys(value.expected).sort().join() !== "leaf_id,runtime_id,session_id" ||
    !identifier(value.expected.runtime_id) || !identifier(value.expected.session_id) ||
    (value.expected.leaf_id !== null && !identifier(value.expected.leaf_id)))) throw Error("Invalid runtime request");
  if (value.action === "commit") {
    const s = value.expected;
    const absolute = (p: unknown) => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) === p && p !== '/' && p.length <= 4096 && !/\p{Cc}/u.test(p);
    if (!object(s) || Object.keys(s).sort().join() !== 'busy,cwd,idle,leaf_id,model,pending,provider,run_id,runtime_id,session_file,session_id,thinking,version' ||
      !/^[a-f0-9]{32}$/.test(s.run_id) || !identifier(s.runtime_id) || !identifier(s.session_id) ||
      (s.leaf_id !== null && !identifier(s.leaf_id)) || !absolute(s.session_file) || !absolute(s.cwd) ||
      typeof s.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(s.version) || s.version.length > 64 ||
      s.idle !== true || s.pending !== false || s.busy !== false || !identifier(s.thinking) ||
      (s.provider !== null && !identifier(s.provider)) || (s.model !== null && !identifier(s.model))) throw Error('Invalid runtime request');
  }
  return structuredClone(value);
}

/** Executor-only channel. No discovery, credential output, path creation or PID authority. */
export class RuntimeClient {
  readonly #socketPath: string; readonly #token: string; readonly #timeout: number;
  #identity?: string; #pending = false;
  constructor(options: { socketPath: string; token: string; timeoutMs?: number }) {
    const { socketPath, token, timeoutMs = 2000 } = options;
    if (!path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || socketPath.includes("\0") || Buffer.byteLength(socketPath) > 100 ||
      !/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error("Invalid runtime endpoint");
    this.#socketPath = socketPath; this.#token = token; this.#timeout = timeoutMs;
  }
  async #endpoint() {
    const parent = path.dirname(this.#socketPath), directory = await lstat(parent), socket = await lstat(this.#socketPath);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
      !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) throw Error("Unsafe runtime endpoint");
    const identity = `${directory.dev}:${directory.ino}:${socket.dev}:${socket.ino}`;
    if (this.#identity && identity !== this.#identity) throw Error("Changed runtime endpoint");
    this.#identity = identity;
  }
  async request(value: RuntimeCommand): Promise<unknown> {
    const fields = command(value);
    if (this.#pending) throw Error("Runtime request refused");
    this.#pending = true;
    try {
      await this.#endpoint();
      const result = await new Promise<unknown>((resolve, reject) => {
        let data = Buffer.alloc(0), done = false;
        const peer = net.createConnection(this.#socketPath);
        const fail = () => { if (done) return; done = true; peer.destroy(); reject(Error("Runtime request refused")); };
        const timer = setTimeout(fail, this.#timeout);
        peer.on("error", fail);
        peer.on("close", () => { clearTimeout(timer); if (!done) fail(); });
        peer.on("connect", () => peer.end(JSON.stringify({ token: this.#token, ...fields }) + "\n"));
        peer.on("data", (chunk: Buffer) => {
          if (done) return;
          if (data.length + chunk.length > 16384) { fail(); return; }
          data = Buffer.concat([data, chunk]);
        });
        peer.on("end", () => {
          if (done) return;
          try {
            if (!data.length || data.indexOf(10) !== data.length - 1) throw Error();
            const reply = strictJson(data.subarray(0, -1));
            if (!object(reply) || Object.keys(reply).sort().join() !== "ok,result" || reply.ok !== true) throw Error();
            done = true; clearTimeout(timer); peer.destroy(); resolve(reply.result);
          } catch { fail(); }
        });
      });
      await this.#endpoint(); return result;
    } finally { this.#pending = false; }
  }
}
