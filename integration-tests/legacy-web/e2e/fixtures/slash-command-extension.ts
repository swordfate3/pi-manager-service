import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let cancelNextFork = false;

  pi.on("session_before_fork", async () => {
    if (!cancelNextFork) return;
    cancelNextFork = false;
    return { cancel: true };
  });

  pi.registerCommand("e2e-cancel-fork", {
    description: "Cancel the next fork for browser E2E",
    handler: async () => {
      cancelNextFork = true;
    },
  });

  pi.registerCommand("e2e-command", {
    description: "Test browser execution of a registered extension command",
    handler: async () => {
      pi.setSessionName("extension-command-ran");
    },
  });
}
