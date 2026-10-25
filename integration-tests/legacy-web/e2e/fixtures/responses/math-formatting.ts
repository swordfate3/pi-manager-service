import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { mathFormattingReply, mathFormattingThinking } from "../math-formatting-data";

export default [fauxAssistantMessage([fauxThinking(mathFormattingThinking), fauxText(mathFormattingReply)])];
