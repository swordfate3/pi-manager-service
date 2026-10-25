import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

function latestUserText(context: TranscriptContext): string {
  const message = [...context.messages].reverse().find((entry) => entry.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function respondToChat(context: TranscriptContext) {
  const prompt = latestUserText(context);
  if (prompt.includes("E2E_SKILL_MARKER")) return fauxAssistantMessage("Skill command expanded successfully.");
  if (prompt.includes("E2E_PROMPT_MARKER")) return fauxAssistantMessage("Prompt template expanded successfully.");
  if (prompt.includes("旧会话标记")) return fauxAssistantMessage("旧会话回复。");
  return fauxAssistantMessage("你好，Pi Web UI 已收到消息。");
}

export default [respondToChat, respondToChat, respondToChat, respondToChat];
