import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only entry to Pi's real reload API without launching a desktop browser.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("connection-test-reload", {
    description: "Reload the isolated connection integration test runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
