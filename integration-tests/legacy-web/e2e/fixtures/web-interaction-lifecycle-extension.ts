import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInteractionClient } from "../../extensions/interactions/client.ts";

const effectFile = path.join(process.cwd(), "web-interaction-lifecycle-effects.jsonl");
const instanceId = randomUUID();

function record(value: Record<string, unknown>) {
  appendFileSync(effectFile, `${JSON.stringify({ ...value, instanceId, at: Date.now() })}\n`, "utf8");
}

export default function lifecycleInteractionFixture(pi: ExtensionAPI) {
  let currentSession = "";
  let lifecycle = new AbortController();
  const reloadPolls = new Set<ReturnType<typeof setInterval>>();
  const client = createInteractionClient(pi.events, {
    id: "fixture-lifecycle-source",
    version: "1",
    packageName: "interaction-lifecycle-fixture",
    actions: { write: { method: "confirm", classification: "sensitive" } },
  });

  const rotate = (event: string, sessionId?: string) => {
    lifecycle.abort();
    record({ event, ...(sessionId ? { sessionId } : {}) });
  };

  pi.on("session_before_switch", (_event, ctx) => {
    rotate("session-before-switch", ctx.sessionManager.getSessionId());
  });

  pi.on("session_before_fork", (_event, ctx) => {
    rotate("session-before-fork", ctx.sessionManager.getSessionId());
  });

  pi.on("session_before_tree", (_event, ctx) => {
    rotate("session-before-tree", ctx.sessionManager.getSessionId());
  });

  pi.on("session_start", (_event, ctx) => {
    currentSession = ctx.sessionManager.getSessionId();
    if (lifecycle.signal.aborted) lifecycle = new AbortController();
    record({ event: "session-start", sessionId: currentSession });
  });

  pi.registerCommand("test-lifecycle-confirm", {
    description: "Exercise isolated cooperative confirmation lifecycle fencing",
    handler: async (args, ctx) => {
      const [operationId, mode = "plain"] = args.trim().split(/\s+/);
      if (!/^[a-f0-9]{32}$/.test(operationId) || !["plain", "reload"].includes(mode)) {
        ctx.ui.notify("FIXTURE_LIFECYCLE_INVALID_ARGUMENTS", "error");
        return;
      }
      const sourceSession = ctx.sessionManager.getSessionId();
      const binding = lifecycle;
      record({ event: "started", operationId, sessionId: sourceSession, mode });
      const result = await client.interact(
        {
          action: "write",
          classification: "sensitive",
          method: "confirm",
          revision: `lifecycle-v1:${operationId}:${instanceId}`,
          schema: { kind: "confirm" },
          content: {
            title: "Lifecycle-sensitive fixture write",
            preview: `PRIVATE-LIFECYCLE-PREVIEW:${operationId}`,
            operationId,
            sourceSession,
            instanceId,
          },
          deadline: Date.now() + 30_000,
        },
        {
          operationId,
          isCurrent: () => lifecycle === binding && !binding.signal.aborted && currentSession === sourceSession,
          signal: binding.signal,
          local: (signal) => {
            record({ event: "local-started", operationId, sessionId: sourceSession });
            if (mode === "reload") {
              const trigger = path.join(process.cwd(), `.pi-web-lifecycle-reload-${operationId}`);
              const poll = setInterval(() => {
                if (!existsSync(trigger)) return;
                clearInterval(poll);
                reloadPolls.delete(poll);
                record({ event: "reload-requested", operationId, sessionId: sourceSession });
                void ctx
                  .reload()
                  .catch(() => record({ event: "reload-failed", operationId, sessionId: sourceSession }));
              }, 10);
              poll.unref();
              reloadPolls.add(poll);
            }
            return ctx.ui.confirm("Lifecycle-sensitive fixture write", `PRIVATE-LIFECYCLE-PREVIEW:${operationId}`, {
              signal,
            });
          },
        },
      );
      record({
        event: "settled",
        operationId,
        sessionId: sourceSession,
        state: result.state,
        winner: result.winner,
      });
      if (
        result.state === "allowed" &&
        result.answer === true &&
        lifecycle === binding &&
        !binding.signal.aborted &&
        currentSession === sourceSession
      ) {
        record({ event: "effect", operationId, sessionId: sourceSession });
        ctx.ui.notify("FIXTURE_LIFECYCLE_EFFECT_COMMITTED", "info");
      } else ctx.ui.notify("FIXTURE_LIFECYCLE_NO_EFFECT", "info");
    },
  });

  pi.on("session_shutdown", (event) => {
    rotate("shutdown", currentSession);
    for (const poll of reloadPolls) clearInterval(poll);
    reloadPolls.clear();
    client.dispose();
    record({ event: "disposed", reason: event.reason, sessionId: currentSession });
  });
}
