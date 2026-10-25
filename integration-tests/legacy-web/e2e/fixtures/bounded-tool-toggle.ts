import type { SessionEntry } from "../../src/web/src/core/types";

export const toolToggleRange = { from: 1_700_000_000_000, to: 1_700_086_400_000 };

/** Valid compact server page whose pretty-printed tool rows nearly fill 512 KiB. */
export function toolToggleEntries(from = toolToggleRange.from): SessionEntry[] {
  return Array.from({ length: 16 }, (_, i) => {
    let nested: unknown = { rows: Array.from({ length: i < 15 ? 400 : 163 }, () => ({ value: "x" })), pad: "" };
    for (let depth = 0; depth < 20; depth++) nested = { nested };
    return {
      id: `e${i}`,
      type: "message",
      timestamp: new Date(from + i).toISOString(),
      message: { role: "toolResult", toolCallId: `t${i}`, toolName: "read", content: [{ type: "custom", nested }] },
    };
  });
}
