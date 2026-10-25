export const line = `LARGE_SINGLE_LINE_${"0123456789abcdef".repeat(18_750)}`;
export const multiline = Array.from(
  { length: 6_000 },
  (_, index) => `LARGE_MULTILINE_ROW_${index.toString().padStart(4, "0")}_${"abcdef0123456789".repeat(2)}`,
).join("\n");
