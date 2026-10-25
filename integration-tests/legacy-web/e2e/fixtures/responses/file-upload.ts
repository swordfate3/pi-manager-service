import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

function readUploadedText(context: TranscriptContext) {
  const message = [...context.messages].reverse().find((entry) => entry.role === "user");
  const text =
    !message || message.role !== "user"
      ? ""
      : typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const file = text.match(/\.pi-uploads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/中文说明\.txt/);
  if (!file) return fauxAssistantMessage("UPLOAD_PATH_MISSING");
  return fauxAssistantMessage([fauxToolCall("read", { path: file[0] })], { stopReason: "toolUse" });
}

function respondToUpload(context: TranscriptContext) {
  if (context.messages.at(-1)?.role === "toolResult") {
    return fauxAssistantMessage("已通过真实 read 工具读取上传的中文说明文件。");
  }
  return readUploadedText(context);
}

// Integration exercises a legacy prompt before the v2 file-read prompt; do
// not consume the only read response on that earlier path-only submission.
export default [respondToUpload, respondToUpload, respondToUpload, respondToUpload];
