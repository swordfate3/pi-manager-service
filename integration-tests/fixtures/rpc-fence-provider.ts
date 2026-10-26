// The provider is synthetic; Pi/RPC, the immutable guard and Web are real.
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const root = process.env.PI_RUNTIME_PROBE_STATE!;
  const record = (event: string, fields = {}) => appendFileSync(path.join(root, "observations.jsonl"), JSON.stringify({ event, ...fields }) + "\n");
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
    } else if (message !== "PROBE_BOOTSTRAP_ONCE") throw Error("Unexpected fixture request");
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
  let timer: NodeJS.Timeout | undefined;
  pi.on("session_start", () => {
    // Attaching a data observer before Pi installs its JSONL reader would put
    // stdin in flowing mode and lose an early parent request. Observe only
    // after the real reader exists; never replace it or substitute a guard.
    timer = setInterval(() => {
      if (process.stdin.listenerCount("data") === 0) return;
      clearInterval(timer); timer = undefined;
      process.stdin.on("data", observe); record("rpc_ready", { version: VERSION, ...guardState() });
    }, 10);
  });
  pi.on("session_shutdown", () => {
    clearInterval(timer); process.stdin.off("data", observe); faux.unregister(); pi.unregisterProvider("rpc-fence-fixture");
  });
}
