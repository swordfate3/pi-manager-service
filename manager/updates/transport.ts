import { Agent, request } from "node:https";
import { checkServerIdentity, rootCertificates } from "node:tls";

export interface OfficialRequest { readonly url: string; readonly signal: AbortSignal; readonly maxBytes: number; readonly timeoutMs: number }
export interface OfficialResponse {
  readonly url: string;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}
/** Construction-only trusted seam; implementations must honor abort. Never supplied by a task/browser. */
export type OfficialTransport = (request: OfficialRequest) => Promise<OfficialResponse>;
export class TransportError extends Error {
  readonly code: "unavailable" | "refused" | "limit" | "timeout";
  constructor(code: TransportError["code"]) { super("Official transport refused"); this.code = code; }
}

const directTransport: OfficialTransport = ({ url, signal }) => new Promise((resolve, reject) => {
  // Own agent, no global fetch dispatcher/proxy, npmrc, cookies, auth or ambient TLS trust overrides.
  const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
  const req = request(url, { agent, method: "GET", signal, rejectUnauthorized: true,
    ca: [...rootCertificates], checkServerIdentity, maxHeaderSize: 16 * 1024,
    headers: { accept: url.endsWith(".tgz") ? "application/octet-stream" : "application/vnd.npm.install-v1+json", "accept-encoding": "identity" },
  }, res => {
    res.once("close", () => agent.destroy());
    resolve({ url, statusCode: res.statusCode ?? 0, headers: res.headers, body: res });
  });
  req.once("error", () => { agent.destroy(); reject(new TransportError("unavailable")); });
  req.end();
});

export async function boundedDownload(url: string, maxBytes: number, timeoutMs: number, transport: OfficialTransport = directTransport): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.origin !== "https://registry.npmjs.org" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== url)
    throw new TransportError("refused");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new TransportError("timeout")); controller.abort(); }, timeoutMs);
  });
  const download = async () => {
    const res = await transport(Object.freeze({ url, signal: controller.signal, maxBytes, timeoutMs }));
    if (res.statusCode !== 200 || res.url !== url) throw new TransportError("refused");
    const encoding = res.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "identity") throw new TransportError("refused");
    const length = res.headers["content-length"];
    if (length !== undefined && (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxBytes))
      throw new TransportError("limit");
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      if (controller.signal.aborted) throw new TransportError("timeout");
      if (!(chunk instanceof Uint8Array)) throw new TransportError("refused");
      size += chunk.byteLength; if (size > maxBytes) throw new TransportError("limit");
      chunks.push(Buffer.from(chunk));
    }
    if (length !== undefined && Number(length) !== size) throw new TransportError("refused");
    return Buffer.concat(chunks, size);
  };
  try { return await Promise.race([download(), deadline]); }
  catch (error) { throw error instanceof TransportError ? error : new TransportError("unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}
