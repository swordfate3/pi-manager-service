// Only model output is synthetic. Pi's CLI, RPC, agent runtime and shutdown are real.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const log = (value: unknown) => appendFileSync(path.join(process.env.HOME!, "acceptance.jsonl"), JSON.stringify(value) + "\n");
  const faux = registerFauxProvider({ provider: "native-fixture", models: [{ id: "deterministic", name: "Native lifecycle acceptance", reasoning: false }] });
  faux.setResponses(Array.from({ length: 2 }, () => async (context) => {
    log({ event: "model_call", projectContextLoaded: JSON.stringify(context).includes("PROJECT_CONTEXT_MUST_NOT_LOAD") });
    return fauxAssistantMessage("NATIVE_PI_GENERATION_OK 答复🙂\u2028line\u2029end");
  }));
  const model = faux.getModel();
  pi.registerProvider("native-fixture", {
    name: "Native lifecycle acceptance", baseUrl: model.baseUrl, apiKey: "synthetic-not-a-credential", api: faux.api as never,
    models: faux.models.map((entry) => ({ ...entry, api: faux.api as never })),
  });
  pi.on("session_start", (_event, ctx) => log({ event: "session_start", version: VERSION, cwd: ctx.cwd, env: process.env, model: ctx.model?.id, provider: ctx.model?.provider }));
  pi.on("session_shutdown", () => {
    log({ event: "session_shutdown" });
    faux.unregister();
    pi.unregisterProvider("native-fixture");
  });
}
