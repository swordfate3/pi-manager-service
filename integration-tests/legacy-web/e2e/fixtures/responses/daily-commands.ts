import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

function respond(context: TranscriptContext) {
  const latest = [...context.messages].reverse().find((message) => message.role === "user");
  const prompt =
    latest?.role === "user"
      ? typeof latest.content === "string"
        ? latest.content
        : latest.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
      : "";
  if (prompt.includes("DAILY_SESSION_ONE_MARKER")) return fauxAssistantMessage("Daily response one.");
  if (prompt.includes("DAILY_SESSION_TWO_MARKER")) return fauxAssistantMessage("Daily response two.");
  if (prompt.includes("DAILY_AFTER_RELOAD_MARKER")) return fauxAssistantMessage("Daily response after reload.");
  return fauxAssistantMessage("Daily response.");
}

export default [respond, respond, respond, respond, respond, respond];
