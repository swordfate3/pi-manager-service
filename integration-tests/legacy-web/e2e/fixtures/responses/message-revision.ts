import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";

type ContextMessage = TranscriptContext["messages"][number];

function textOf(message: ContextMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function transcript(context: TranscriptContext): string[] {
  return context.messages.map(textOf);
}

function lastUserText(context: TranscriptContext): string {
  const latest = [...context.messages].reverse().find((message) => message.role === "user");
  return latest ? textOf(latest) : "";
}

function contextLeak(reason: string) {
  return fauxAssistantMessage(`CONTEXT_LEAK: ${reason}`);
}

function originalAlpha(context: TranscriptContext) {
  const messages = transcript(context);
  if (
    lastUserText(context) !== "QUESTION_ALPHA" ||
    messages.some((text) => /QUESTION_BETA|ANSWER_BETA|QUESTION_ALPHA_EDITED|ANSWER_ALPHA_EDITED/.test(text))
  )
    return contextLeak("initial ALPHA context was not isolated");
  return fauxAssistantMessage("ANSWER_ALPHA_ORIGINAL");
}

function originalBeta(context: TranscriptContext) {
  const messages = transcript(context);
  if (
    lastUserText(context) !== "QUESTION_BETA" ||
    !messages.includes("ANSWER_ALPHA_ORIGINAL") ||
    messages.some((text) => /ANSWER_BETA|QUESTION_ALPHA_EDITED|ANSWER_ALPHA_EDITED/.test(text))
  )
    return contextLeak("initial BETA context did not contain only the prior ALPHA branch");
  return fauxAssistantMessage("ANSWER_BETA_ORIGINAL");
}

async function editedAlpha(context: TranscriptContext) {
  const messages = transcript(context);
  // Whitespace is intentionally significant: Pi must receive the complete revised question verbatim.
  if (
    lastUserText(context) !== "  QUESTION_ALPHA_EDITED  " ||
    messages.includes("QUESTION_ALPHA") ||
    messages.includes("ANSWER_ALPHA_ORIGINAL") ||
    messages.some((text) => /QUESTION_BETA|ANSWER_BETA|ANSWER_ALPHA_EDITED/.test(text))
  )
    return contextLeak("edited ALPHA included content from the source or later branch");

  // Keep a real Pi turn busy long enough for the browser to observe disabled message actions.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return fauxAssistantMessage(`ANSWER_ALPHA_EDITED\n${"slow-stream-".repeat(24)}`);
}

function regeneratedBeta(context: TranscriptContext) {
  const messages = transcript(context);
  if (
    lastUserText(context) !== "QUESTION_BETA" ||
    !messages.includes("ANSWER_ALPHA_ORIGINAL") ||
    messages.some((text) => /ANSWER_BETA_ORIGINAL|QUESTION_ALPHA_EDITED|ANSWER_ALPHA_EDITED/.test(text))
  )
    return contextLeak("regenerated BETA included its old answer or the edited ALPHA branch");
  return fauxAssistantMessage("ANSWER_BETA_REGENERATED");
}

export default [originalAlpha, originalBeta, editedAlpha, regeneratedBeta];
