/** Fixed probe instrumentation. Only model responses are simulated; no policy is replaced. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  VERSION,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_RUNTIME_PROBE_STATE;
  if (!directory || !path.isAbsolute(directory))
    throw new Error("Missing private probe state");
  const selection = JSON.parse(
    readFileSync(path.join(directory, "selection.json"), "utf8"),
  );
  if (
    !selection ||
    Object.keys(selection).sort().join(",") !== "model,provider" ||
    typeof selection.provider !== "string" ||
    typeof selection.model !== "string"
  )
    throw new Error("Invalid probe model");
  const trace = path.join(directory, "observations.jsonl");
  const record = (event: string, values: Record<string, unknown> = {}) => {
    if (existsSync(trace) && statSync(trace).size > 512 * 1024)
      throw new Error("Probe observation limit");
    appendFileSync(
      trace,
      `${JSON.stringify({ event, pid: process.pid, ...values })}\n`,
      { mode: 0o600 },
    );
  };
  const waitRelease = async (name: string) => {
    const deadline = Date.now() + 20_000;
    while (!existsSync(path.join(directory, name))) {
      if (Date.now() >= deadline) throw new Error("Probe release timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const faux = registerFauxProvider({
    provider: selection.provider,
    models: [
      { id: selection.model, name: "Offline runtime probe", reasoning: true },
    ],
  });
  const answer = async (context: TranscriptContext) => {
    const last = context.messages.findLast((entry) => entry.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n") ?? "");
    const generation = text === "PROBE_GENERATION";
    const bootstrap = text === "PROBE_BOOTSTRAP_ONCE";
    record("provider_call", {
      generation,
      bootstrap,
      savedPrompt: text.includes("PROBE_SAVED_DO_NOT_REPLAY"),
    });
    if (!generation && !bootstrap)
      throw new Error("Unexpected probe model request");
    if (generation) await waitRelease("release-generation");
    record("provider_complete");
    return fauxAssistantMessage("PROBE_RESPONSE_COMPLETED");
  };
  faux.setResponses(Array.from({ length: 8 }, () => answer));
  const model = faux.getModel();
  pi.registerProvider(selection.provider, {
    name: "Offline runtime probe",
    baseUrl: model.baseUrl,
    apiKey: "synthetic-probe-key",
    api: faux.api as never,
    models: faux.models.map((entry) => ({ ...entry, api: faux.api as never })),
  });

  // Observe downstream of the real immutable preload. Never taint, freeze,
  // release, clear or substitute the guard from this extension.
  const observeInput = (data: Buffer | string) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      Symbol.for("pi.runtime.stdin-guard.v1"),
    );
    const guard = descriptor?.value;
    record("stdin", {
      data: Buffer.from(data).toString("base64"),
      safe: typeof guard?.safe === "function" ? guard.safe() : null,
      intact: typeof guard?.intact === "function" ? guard.intact() : null,
    });
  };
  process.stdin.on("data", observeInput);
  pi.on("session_start", (_event, ctx) => {
    record("session_start", {
      version: VERSION,
      session_format: CURRENT_SESSION_VERSION,
      node: process.versions.node,
      executable: realpathSync(process.execPath),
      cli: realpathSync(process.argv[1]),
      tty: process.stdin.isTTY === true,
      session_id: ctx.sessionManager.getSessionId(),
      leaf_id: ctx.sessionManager.getLeafId(),
      cwd: ctx.cwd,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinking: pi.getThinkingLevel(),
    });
  });
  pi.on("tool_call", () => {
    record("tool_call");
  });
  pi.on("agent_end", () => {
    record("agent_end");
  });
  pi.registerCommand("runtime-probe-async", {
    description: "Fixed isolated compatibility probe",
    handler: async () => {
      record("async_start");
      await waitRelease("release-async");
      record("async_complete");
    },
  });
  pi.registerCommand("runtime-probe-reload", {
    description: "Fixed isolated compatibility reload probe",
    handler: async (_args, ctx) => {
      record("reload_requested");
      await ctx.reload();
      // No captured ctx access after reload.
    },
  });
  pi.on("session_shutdown", () => {
    record("session_shutdown");
    process.stdin.removeListener("data", observeInput);
    faux.unregister();
    pi.unregisterProvider(selection.provider);
  });
}
