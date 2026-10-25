import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { transportContent } from "../transport-data.ts";
export default [
  fauxAssistantMessage([fauxToolCall("write", { path: "transport-large.txt", content: transportContent })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("TRANSPORT_RECOVERY_COMPLETE"),
];
