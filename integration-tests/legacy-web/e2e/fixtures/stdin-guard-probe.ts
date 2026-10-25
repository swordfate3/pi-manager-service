import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const guard = (globalThis as any)[Symbol.for("pi.runtime.stdin-guard.v1")];
    writeFileSync(
      path.join(ctx.cwd, "guard-start.json"),
      JSON.stringify({ present: !!guard, intact: guard?.intact(), safe: guard?.safe() }),
    );
  });
  pi.registerCommand("guard-touch", {
    description: "Synthetic guard regression only",
    handler: async (_args, ctx) => {
      const guard = (globalThis as any)[Symbol.for("pi.runtime.stdin-guard.v1")];
      writeFileSync(path.join(ctx.cwd, "guard-command.json"), JSON.stringify({ safeAtDispatch: guard?.safe() }));
    },
  });
  pi.registerCommand("guard-hold", {
    description: "Synthetic asynchronous command guard regression only",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const guard = (globalThis as any)[Symbol.for("pi.runtime.stdin-guard.v1")];
      writeFileSync(path.join(cwd, "guard-held.json"), JSON.stringify({ safeAtDispatch: guard?.safe() }));
      const deadline = Date.now() + 10_000;
      while (!existsSync(path.join(cwd, "guard-release")) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(path.join(cwd, "guard-finished"), "done");
    },
  });
}
