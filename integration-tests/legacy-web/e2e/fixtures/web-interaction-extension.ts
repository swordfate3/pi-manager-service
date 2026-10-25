import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInteractionClient, registerInteractionPanel } from "../../extensions/interactions/client.ts";

export default function interactionFixture(pi: ExtensionAPI) {
  let currentSession = "";
  let cancelNextSwitch = false;
  pi.on("session_before_switch", () => {
    if (cancelNextSwitch) {
      cancelNextSwitch = false;
      return { cancel: true };
    }
  });
  pi.registerCommand("test-cancel-session", {
    description: "Cancel one native session transition in an isolated test",
    handler: async (_args, ctx) => {
      cancelNextSwitch = true;
      const result = await ctx.newSession();
      if (result.cancelled) ctx.ui.notify("FIXTURE_SESSION_SWITCH_CANCELLED", "info");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    currentSession = ctx.sessionManager.getSessionId();
  });
  const client = createInteractionClient(pi.events, {
    id: "fixture-memory",
    version: "1",
    packageName: "interaction-fixture",
    actions: { write: { method: "confirm", classification: "sensitive" } },
  });
  pi.registerCommand("test-web-confirm", {
    description: "Isolated cooperative interaction test",
    handler: async (args, ctx) => {
      const session = ctx.sessionManager.getSessionId();
      const controller = new AbortController();
      const cancelTimer = args === "cancel" ? setTimeout(() => controller.abort(), 150) : undefined;
      const answer = await client.interact(
        {
          action: "write",
          classification: "sensitive",
          method: "confirm",
          revision: "fixture-preview-1",
          schema: { kind: "confirm" },
          content: { title: "Test sensitive write", preview: "PRIVATE-REAL-PI-PREVIEW" },
          deadline: Date.now() + (args === "timeout" ? 250 : 10_000),
        },
        {
          isCurrent: () => ctx.sessionManager.getSessionId() === session,
          signal: controller.signal,
          local: (signal) => ctx.ui.confirm("Test sensitive write", "PRIVATE-REAL-PI-PREVIEW", { signal }),
        },
      );
      clearTimeout(cancelTimer);
      if (answer.state === "allowed" && answer.answer === true)
        ctx.ui.notify("FIXTURE_WEB_INTERACTION_COMMITTED", "info");
      else ctx.ui.notify("FIXTURE_WEB_INTERACTION_NOT_COMMITTED", "info");
    },
  });
  pi.on("session_shutdown", () => client.dispose());
  const mcp = createInteractionClient(pi.events, {
    id: "pi-mcp-adapter",
    version: "fixture",
    packageName: "interaction-fixture",
    actions: { reconnect: { method: "confirm", classification: "sensitive" } },
  });
  const panels = [
    registerInteractionPanel(pi.events, {
      manifest: {
        id: "pi-mcp-adapter",
        version: "fixture",
        packageName: "interaction-fixture",
        commands: ["mcp-adapter"],
        methods: ["reconnect", "enable", "disable", "oauth"],
      },
      isCurrent: () => !!currentSession,
      snapshot: async () => ({
        revision: "fixture-mcp-1",
        items: [{ name: "isolated-tools", status: "connected", toolCount: 3, disabled: false }],
        config: { programmaticConfig: false },
      }),
      invoke: async (method, params, context) => {
        if (method !== "reconnect") throw new Error("Fixture implements reconnect only");
        const session = currentSession;
        const result = await mcp.interact(
          {
            action: "reconnect",
            classification: "sensitive",
            method: "confirm",
            revision: context.revision,
            schema: { kind: "confirm" },
            content: { title: "Reconnect fixture service", preview: "PRIVATE-MCP-RECONNECT", server: params.name },
            deadline: Date.now() + 60000,
          },
          { isCurrent: () => currentSession === session, signal: context.signal },
        );
        if (result.state === "allowed" && result.answer === true) pi.events.emit("fixture:reconnected", {});
        return { ok: result.state === "allowed" && result.answer === true };
      },
    }),
    registerInteractionPanel(pi.events, {
      manifest: {
        id: "pi-subagents-lite",
        version: "fixture",
        packageName: "interaction-fixture",
        commands: ["agents"],
        methods: ["spawn", "set-default-model", "set-default-thinking", "set-agent-model", "set-concurrency"],
      },
      isCurrent: () => !!currentSession,
      snapshot: async () => ({
        revision: "fixture-agents-1",
        items: [],
        config: {
          agentTypes: [{ name: "worker", description: "Isolated worker", effectiveModel: "faux/faux-1" }],
          models: [{ key: "faux/faux-1", thinkingLevels: ["low", "medium"] }],
          defaultModel: null,
          defaultThinking: null,
          typeModels: {},
          concurrency: { default: 2, providers: {}, models: {} },
        },
      }),
      invoke: async () => ({ ok: false, cancelled: true }),
    }),
  ];
  for (const name of ["mcp-adapter", "agents"])
    pi.registerCommand(name, {
      description: "Isolated panel fixture",
      handler: async (_args, ctx) => {
        ctx.ui.notify("FIXTURE_UNEXPECTED_TUI_PANEL", "warning");
      },
    });
  pi.on("session_start", (_event, ctx) => {
    pi.events.on("fixture:reconnected", () => ctx.ui.notify("FIXTURE_MCP_RECONNECTED_ONCE", "info"));
  });
  pi.on("session_shutdown", () => {
    for (const panel of panels) panel.dispose();
    mcp.dispose();
  });
}
