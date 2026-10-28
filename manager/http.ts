import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ManagerError, requireThat, token } from "./validation.ts";

export function header(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[i+1]);
  requireThat(values.length <= 1); return values[0];
}
export function bearer(req: IncomingMessage): string {
  const auth = header(req, "authorization");
  // Browsers behind a Basic-auth gateway need Authorization for the gateway.
  // The gateway removes it before forwarding; Manager's credential stays separate.
  const management = header(req, "x-pi-manager-token");
  requireThat(!(auth !== undefined && management !== undefined));
  if (management !== undefined) return token(management);
  requireThat(auth && auth.startsWith("Bearer "), 401); return token(auth.slice(7));
}
export function boundary(req: IncomingMessage, origin: string) {
  requireThat(header(req, "host") === new URL(origin).host, 403);
  const from = header(req, "origin");
  requireThat(req.method === "GET" ? from === undefined || from === origin : from === origin, 403);
  // Reject ambiguity even for cookie-authenticated routes.
  header(req, "authorization"); header(req, "x-pi-manager-token"); header(req, "cookie"); header(req, "content-type");
  requireThat(req.url && req.url.length <= 512 && !/[\\%?#]/.test(req.url));
}
export async function jsonBody(req: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  requireThat(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32768);
  requireThat(header(req, "content-type") === "application/json");
  const declared = header(req, "content-length"); requireThat(!declared || Number(declared) <= maxBytes, 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; requireThat(size <= maxBytes, 413); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ManagerError(400); }
}
export function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, endpoint: number | string) {
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 250 }, (req, res) => {
    const deadline = setTimeout(() => { reply(res, 408, { error: "Request deadline exceeded" }); req.socket.destroy(); }, 5000);
    void handler(req, res).catch(error => reply(res, error instanceof ManagerError ? error.status : 503, { error: error instanceof ManagerError ? error.message : "Service unavailable" })).finally(() => clearTimeout(deadline));
  });
  server.maxConnections = 64; server.maxRequestsPerSocket = 20; server.keepAliveTimeout = 1000;
  server.setTimeout(5000, socket => socket.destroy());
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); if (typeof endpoint === "number") server.listen(endpoint, "127.0.0.1", resolve); else server.listen(endpoint, resolve); });
  let closing: Promise<void> | undefined;
  return {
    port: typeof server.address() === "object" ? (server.address() as { port: number }).port : 0,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); for (const socket of sockets) socket.destroy(); });
    },
  };
}
