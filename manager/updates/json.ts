/** Strict bounded JSON, including escaped duplicate keys. No revivers or prototype setters. */
export function strictJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0, nodes = 0;
  const bad = (): never => { throw new Error("Invalid bounded JSON"); };
  const ws = () => { while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++; };
  function string(): string {
    if (text[at] !== '"') return bad();
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return JSON.parse(text.slice(start, at)) as string;
      if (char === "\\") at++;
    }
    return bad();
  }
  function value(depth: number): unknown {
    if (depth > 64 || ++nodes > 500_000) return bad();
    ws(); const char = text[at];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      at++; ws();
      const object = char === "{";
      const result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const end = object ? "}" : "]";
      if (text[at] === end) { at++; return result; }
      for (;;) {
        ws();
        if (object) {
          const key = string(); ws();
          if (Object.hasOwn(result, key) || text[at++] !== ":") return bad();
          (result as Record<string, unknown>)[key] = value(depth + 1);
        } else (result as unknown[]).push(value(depth + 1));
        ws();
        if (text[at] === end) { at++; return result; }
        if (text[at++] !== ",") return bad();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!match) return bad();
    at += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isFinite(result)) return bad();
    return result;
  }
  const result = value(0); ws(); if (at !== text.length) return bad(); return result;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
