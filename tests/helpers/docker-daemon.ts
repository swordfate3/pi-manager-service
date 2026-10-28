import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function dockerDaemon(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "manager-docker-test-"));
  const work = path.join(root, "work");
  await mkdir(path.join(work, "project"), { recursive: true });
  const state = path.join(root, "private");
  const socketPath = path.join(root, "docker.sock");
  const image = `sha256:${"1".repeat(64)}`;
  const daemonId = "test-daemon-identity";
  const containers = new Map<string, any>();
  const volumes = new Map<string, any>();
  const calls: { method: string; route: string; body: any }[] = [];
  const cleanups: (() => Promise<unknown>)[] = [];
  const behavior = { daemonId, loseCreateReply: false, failStart: false };
  const imageEnv = ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=24.0.0", "PYTHON=/usr/bin/python3"];
  const imageLabels: Record<string, string> = {};
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const route = decodeURIComponent(req.url!);
    calls.push({ method: req.method!, route, body });
    const send = (status: number, data?: any) => { res.writeHead(status, { "content-type": "application/json" }); res.end(data === undefined ? undefined : JSON.stringify(data)); };
    if (route === "/info") return send(200, { ID: behavior.daemonId });
    if (route.startsWith("/images/")) return send(200, { Id: image, Config: { Volumes: null, User: "1000:1000", Entrypoint: ["/usr/local/bin/pi-entrypoint"], Env: imageEnv, Labels: imageLabels } });
    if (route === "/volumes/create") {
      const data = { Name: body.Name, Driver: body.Driver, Options: null, Labels: body.Labels };
      volumes.set(body.Name, data); return send(201, data);
    }
    if (route.startsWith("/volumes/")) return send(volumes.has(route.slice(9)) ? 200 : 404, volumes.get(route.slice(9)));
    if (route.startsWith("/containers/create?")) {
      const id = String(containers.size + 1).padStart(64, "a");
      const data = { Id: id, Image: body.Image, Config: structuredClone(body), HostConfig: body.HostConfig,
        Mounts: body.HostConfig.Mounts.map((m: any) => ({ Type: m.Type, Source: m.Source, Destination: m.Target, RW: !m.ReadOnly, ...(m.Type === "volume" ? { Name: m.Source } : {}) })),
        State: { Running: false, Status: "created" } };
      data.Config.Env = [...imageEnv.filter(e => !body.Env.some((v: string) => v.split("=")[0] === e.split("=")[0])), ...body.Env];
      containers.set(id, data);
      if (behavior.loseCreateReply) return req.socket.destroy();
      return send(201, { Id: id, Warnings: [] });
    }
    const match = /^\/containers\/([a-f0-9]{64})\/(json|start|stop)(?:\?.*)?$/.exec(route);
    if (match) {
      const item = containers.get(match[1]);
      if (!item) return send(404);
      if (match[2] === "json") return send(200, item);
      if (match[2] === "start") {
        if (behavior.failStart) return send(500);
        item.State = { Running: true, Status: "running" }; return send(204);
      }
      item.State = { Running: false, Status: "exited" }; return send(204);
    }
    return send(404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
  });
  return { root, work, state, socketPath, image, daemonId, containers, volumes, calls, behavior, cleanups, imageEnv, imageLabels };
}
