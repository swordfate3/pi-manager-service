import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("test-terminal-confirm", {
    description: "Synthetic trusted UI confirmation, never a memory write",
    handler: async (_args, ctx) => {
      const approved = await ctx.ui.confirm("Synthetic terminal confirmation", "PRIVATE_FIXTURE_BODY_NOT_FOR_WS", {
        timeout: 30_000,
      });
      ctx.ui.notify(approved ? "FIXTURE_APPROVED_BY_RPC" : "FIXTURE_REJECTED_BY_RPC");
    },
  });

  for (const mode of ["timeout", "abort"] as const) {
    pi.registerCommand(`test-terminal-confirm-${mode}`, {
      description: `Synthetic confirmation with real ${mode}, never a memory write`,
      handler: async (_args, ctx) => {
        const controller = new AbortController();
        const timer = mode === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
        try {
          const approved = await ctx.ui.confirm(
            `Synthetic terminal confirmation ${mode}`,
            "PRIVATE_FIXTURE_BODY_NOT_FOR_WS",
            mode === "timeout" ? { timeout: 100 } : { signal: controller.signal },
          );
          ctx.ui.notify(approved ? "FIXTURE_UNEXPECTED_APPROVAL" : `FIXTURE_CANCELLED_BY_${mode.toUpperCase()}`);
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }
}
