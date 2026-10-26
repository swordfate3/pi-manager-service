import http from "node:http";
import path from "node:path";

export class DockerOperationError extends Error {
  readonly status?: number;
  constructor(message = "Docker operation rejected", status?: number) { super(message); this.status = status; }
}

/** A failed mutating request is not evidence that Docker did nothing. */
export class DockerOutcomeUnknownError extends DockerOperationError {
  constructor() { super("Docker operation outcome unknown; reconciliation required"); }
}

export interface DockerTransportOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function bounded(value: number | undefined, fallback: number, max: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new DockerOperationError("Invalid Docker transport limit");
  return n;
}

/** Private executor infrastructure, never exposed as a general HTTP proxy. */
export class DockerEngine {
  readonly #socket: string;
  readonly #timeout: number;
  readonly #maxBytes: number;
  readonly #active = new Set<http.ClientRequest>();
  #closed = false;

  constructor(socketPath: string, options: DockerTransportOptions = {}) {
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) || socketPath.includes("\0")) throw new DockerOperationError("Invalid Docker socket");
    this.#socket = socketPath;
    this.#timeout = bounded(options.timeoutMs, 10_000, 120_000);
    this.#maxBytes = bounded(options.maxBytes, 1024 * 1024, 4 * 1024 * 1024);
  }

  async call(method: "GET" | "POST" | "DELETE", route: string, value?: unknown, options: { allowMissing?: boolean } = {}): Promise<unknown> {
    if (this.#closed || this.#active.size >= 16) throw new DockerOperationError("Docker transport unavailable");
    if (!["GET", "POST", "DELETE"].includes(method) || typeof route !== "string" || route.length > 8192 || !route.startsWith("/") || route.startsWith("//") || /[\x00-\x20\x7f#\\]/.test(route)) throw new DockerOperationError("Invalid Docker operation");
    let decoded: string;
    try { decoded = decodeURIComponent(route.split("?")[0]); } catch { throw new DockerOperationError("Invalid Docker operation"); }
    if (decoded.split("/").some(part => part === "." || part === "..") || decoded.includes("\0")) throw new DockerOperationError("Invalid Docker operation");
    if (method !== "GET" && options.allowMissing) throw new DockerOperationError("Invalid Docker operation");
    let body: string | undefined;
    try { body = value === undefined ? undefined : JSON.stringify(value); } catch { throw new DockerOperationError("Invalid Docker request"); }
    if ((body && Buffer.byteLength(body) > 128 * 1024) || (method === "GET" && value !== undefined)) throw new DockerOperationError("Invalid Docker request");
    return new Promise((resolve, reject) => {
      let done = false;
      const uncertain = () => method === "GET" ? new DockerOperationError("Docker transport unavailable") : new DockerOutcomeUnknownError();
      const request = http.request({ socketPath: this.#socket, method, path: route, agent: false,
        headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
      this.#active.add(request);
      const timer = setTimeout(() => finish(uncertain()), this.#timeout);
      const finish = (error?: Error, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#active.delete(request);
        request.destroy();
        if (error) reject(error); else resolve(result);
      };
      request.on("error", () => finish(uncertain()));
      request.on("response", response => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("error", () => finish(uncertain()));
        response.on("aborted", () => finish(uncertain()));
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.#maxBytes) { finish(method === "GET" ? new DockerOperationError("Docker response limit exceeded") : uncertain()); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (done) return;
          const status = response.statusCode ?? 0;
          if (status === 404 && options.allowMissing) return finish(undefined, null);
          if (status < 200 || status >= 300) return finish(new DockerOperationError("Docker operation rejected", status));
          if (!bytes) return finish(undefined, null);
          try { finish(undefined, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); }
          catch { finish(method === "GET" ? new DockerOperationError("Invalid Docker response") : uncertain()); }
        });
      });
      request.end(body);
    });
  }

  close(): void {
    this.#closed = true;
    for (const request of this.#active) request.destroy(new Error("closed"));
  }
}
