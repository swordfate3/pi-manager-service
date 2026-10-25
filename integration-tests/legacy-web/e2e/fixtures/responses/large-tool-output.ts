import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { line, multiline } from "../large-tool-data.ts";

export default [
  fauxAssistantMessage([fauxToolCall("write", { path: "large-single.txt", content: line })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("read", { path: "large-single.txt" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("write", { path: "large-multiline.txt", content: multiline })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage([fauxToolCall("bash", { command: "cat large-multiline.txt" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Large output fixture completed with real write and read tools."),
];
