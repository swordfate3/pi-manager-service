// The provider is synthetic; Pi/RPC, the immutable guard and Web are real.
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Test-only command invokes the supported Pi lifecycle; no production test hook.
  pi.registerCommand('probe-reload', { description: 'Reload the isolated runtime fixture', handler: async (_args, ctx) => { await ctx.reload(); } });
  const root = process.env.PI_RUNTIME_PROBE_STATE!;
  const record = (event: string, fields = {}) => appendFileSync(path.join(root, "observations.jsonl"), JSON.stringify({ event, ...fields }) + "\n");
  const waitForRelease = async (stage: string) => {
    const deadline = Date.now() + 20_000;
    while (!existsSync(path.join(root, `release-${stage}`))) {
      if (Date.now() >= deadline) throw Error(`Preflight ${stage} release deadline`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  if (process.env.PI_RUNTIME_PROBE_PREFLIGHT === "1") {
    pi.on("input", async event => {
      if (event.text === "PROBE_PREFLIGHT_input") {
        record("preflight_paused", { stage: "input" });
        await waitForRelease("input");
      }
      if (event.text === "PROBE_HANDLED") {
        record("handled_pending");
        await waitForRelease("handled");
        record("handled_finished");
        return { action: "handled" };
      }
      return { action: "continue" };
    });
    pi.on("before_agent_start", async event => {
      if (event.prompt !== "PROBE_PREFLIGHT_before_agent_start") return;
      record("preflight_paused", { stage: "before_agent_start" });
      await waitForRelease("before_agent_start");
    });
  }
  const faux = registerFauxProvider({ provider: "rpc-fence-fixture", models: [{ id: "deterministic", name: "RPC fence acceptance", reasoning: true }] });
  const answer = async (context: any) => {
    const last = context.messages.findLast((entry: any) => entry.role === "user");
    const message = typeof last?.content === "string" ? last.content : last?.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    record("provider_call", { message });
    if (message === "PROBE_GENERATION") {
      const deadline = Date.now() + 20_000;
      while (!existsSync(path.join(root, "release-generation"))) {
        if (Date.now() >= deadline) throw Error("Generation release deadline");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } else if (!["PROBE_BOOTSTRAP_ONCE", "PROBE_PREFLIGHT_input", "PROBE_PREFLIGHT_before_agent_start"].includes(message)) throw Error("Unexpected fixture request");
    return fauxAssistantMessage("RPC_FENCE_RESPONSE_COMPLETED");
  };
  faux.setResponses(Array.from({ length: 4 }, () => answer));
  const model = faux.getModel();
  pi.registerProvider("rpc-fence-fixture", { name: "RPC fence fixture", baseUrl: model.baseUrl, apiKey: "synthetic-not-a-credential",
    api: faux.api as never, models: faux.models.map(entry => ({ ...entry, api: faux.api as never })) });
  const guardState = () => {
    const guard = (globalThis as any)[Symbol.for("pi.runtime.stdin-guard.v1")];
    return { intact: guard?.intact(), safe: guard?.safe() };
  };
  const observe = () => record("stdin", guardState());
  let pipe: { onread: (...args: any[]) => any } | undefined;
  let originalRead: ((...args: any[]) => any) | undefined;
  let timer: NodeJS.Timeout | undefined;
  pi.on("session_start", () => {
    // Attaching a data observer before Pi installs its JSONL reader would put
    // stdin in flowing mode and lose an early parent request. Observe only
    // after the real reader exists; never replace it or substitute a guard.
    timer = setInterval(() => {
      if (process.stdin.listenerCount("data") === 0) return;
      clearInterval(timer); timer = undefined;
      if (process.env.PI_RUNTIME_PROBE_ADMISSION === '1') {
        // Test-only upstream observation. The actual pipe read handler returns
        // only after synchronously dispatching through the unchanged real
        // stdin guard. A denied data event cannot notify ordinary listeners.
        pipe = (process.stdin as any)._handle;
        if (!pipe || typeof pipe.onread !== 'function') throw Error('Admission observation unavailable');
        originalRead = pipe.onread;
        pipe.onread = function (...args: any[]) {
          const result = Reflect.apply(originalRead!, this, args);
          record('raw_stdin_boundary', guardState());
          return result;
        };
      }
      process.stdin.on("data", observe); record("rpc_ready", { version: VERSION, ...guardState() });
    }, 10);
  });
  pi.on("session_shutdown", () => {
    if (pipe && originalRead) pipe.onread = originalRead;
    clearInterval(timer); process.stdin.off("data", observe); faux.unregister(); pi.unregisterProvider("rpc-fence-fixture");
  });
}
