import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { executorConfig, privateDirectory } from "../config.ts";
import { bearer, header, jsonBody, listen, reply } from "../http.ts";
import { requireThat } from "../validation.ts";
import { TaskEngine } from "./engine.ts";
import { NativeTaskAdapter } from "./native-adapter.ts";
import { DockerTaskAdapter } from "./docker-adapter.ts";

export async function startExecutor(value: unknown) {
  const config = executorConfig(value);
  await privateDirectory(config.stateRoot);
  for (const socket of [config.submitSocket, config.adminSocket]) {
    requireThat(Buffer.byteLength(socket) <= 100);
    await privateDirectory(path.dirname(socket), config.socketMode === 0o660);
    // Never unlink an existing listener or stale path automatically.
    let exists = true; try { await lstat(socket); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw e; }
    requireThat(!exists, 409);
  }
  const adapter = config.docker ? await DockerTaskAdapter.open(config) : config.native ? new NativeTaskAdapter(config) : undefined;
  let engine: TaskEngine;
  try { engine = await TaskEngine.open(config, adapter); }
  catch (error) { await adapter?.close(); throw error; }
  const servers: Awaited<ReturnType<typeof listen>>[] = [];
  try {
    for (const [transport, socket] of [["submit", config.submitSocket], ["admin", config.adminSocket]] as const) {
      servers.push(await listen(async (req, res) => {
        requireThat(req.method === "POST" && req.url === "/rpc" && header(req, "host") === "executor");
        const credential = bearer(req); const message = await jsonBody(req);
        reply(res, 200, await engine.dispatch(transport, credential, message));
      }, socket));
      await chmod(socket, config.socketMode ?? 0o600);
    }
  } catch (error) { await Promise.allSettled(servers.map(s => s.close())); await engine.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => {
    const results = await Promise.allSettled(servers.map(s => s.close()));
    await engine.close(); requireThat(results.every(r => r.status === "fulfilled"), 503);
  })() };
}
