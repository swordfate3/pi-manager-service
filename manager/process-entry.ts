/** Shared signal lifecycle only. No policy, credentials or process spawning. */
export async function runProcess(start: () => Promise<{ port?: number; close(): Promise<void> }>) {
  try {
    const service = await start();
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      try { await service.close(); process.exitCode = 0; }
      catch { process.stderr.write("Manager shutdown incomplete\n"); process.exitCode = 1; }
      finally { if (process.connected) process.disconnect?.(); }
    };
    process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
    // A lost supervisor control channel shuts down only these owned service processes.
    process.once("disconnect", () => { void close(); });
    if (process.send) process.send({ ready: true, ...(service.port === undefined ? {} : { port: service.port }) });
    else process.stdout.write(JSON.stringify({ ready: true, ...(service.port === undefined ? {} : { port: service.port }) }) + "\n");
  } catch { process.stderr.write("Manager service failed\n"); process.exitCode = 1; if (process.connected) process.disconnect?.(); }
}
export function configArgument(args: string[]) {
  if (args.length !== 2 || args[0] !== "--config") throw new Error("Explicit configuration required"); return args[1];
}
