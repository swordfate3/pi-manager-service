/** Real SDK provider; only model responses are synthetic, never runtime control. */
import { appendFileSync, existsSync } from "node:fs";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", name: "Synthetic runtime acceptance", reasoning: true }],
  });
  const answer = async (context: TranscriptContext) => {
    const last = context.messages.findLast((entry) => entry.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ?? "");
    appendFileSync(
      "/workspace/model-calls.jsonl",
      `${JSON.stringify({ generation: text === "WAIT_FOR_RUNTIME_ACCEPTANCE" })}\n`,
    );
    if (text === "WAIT_FOR_RUNTIME_ACCEPTANCE") {
      const deadline = Date.now() + 540_000;
      while (!existsSync("/workspace/release-generation")) {
        if (Date.now() >= deadline) throw new Error("Synthetic generation release timed out");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return fauxAssistantMessage("SYNTHETIC_GENERATION_COMPLETED");
  };
  faux.setResponses(Array.from({ length: 8 }, () => answer));
  const model = faux.getModel();
  pi.registerProvider("faux", {
    name: "Synthetic runtime acceptance",
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api as never,
    models: faux.models.map((entry) => ({ ...entry, api: faux.api as never })),
  });
  pi.on("session_start", (_event, ctx) => {
    appendFileSync(
      "/workspace/runtime-observations.jsonl",
      `${JSON.stringify({
        event: "session_start",
        version: VERSION,
        cwd: ctx.cwd,
        session_id: ctx.sessionManager.getSessionId(),
        leaf_id: ctx.sessionManager.getLeafId(),
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinking: pi.getThinkingLevel(),
      })}\n`,
    );
  });
  pi.on("session_shutdown", () => {
    faux.unregister();
    pi.unregisterProvider("faux");
  });
}
