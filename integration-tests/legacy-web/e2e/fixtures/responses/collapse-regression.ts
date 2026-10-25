import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

export default [
  fauxAssistantMessage(
    [
      fauxThinking(
        "COLLAPSE_REGRESSION_THINKING_BODY: I should write a concise Markdown note, then confirm it is done.",
      ),
      fauxToolCall("write", {
        path: "collapse-regression.md",
        content: "# Collapse regression\n\nThis small Markdown file was written by the real Pi write tool.\n",
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("Collapse regression write completed successfully."),
];
