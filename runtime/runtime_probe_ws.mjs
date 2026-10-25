// Fixed loopback-only WebSocket client. Native Node WebSocket, no ambient modules.
let socket;
const finish = (value, code) => {
  socket?.close();
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code));
};
const timer = setTimeout(() => finish({ ok: false }, 1), 8000);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error("input limit");
  }
  const value = JSON.parse(input);
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "method,params,port" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !["prompt", "get_state"].includes(value.method) ||
    !value.params ||
    typeof value.params !== "object" ||
    Array.isArray(value.params)
  )
    throw new Error("request");
  socket = new WebSocket(`ws://127.0.0.1:${value.port}/ws`);
  let received = 0;
  let state;
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "req",
        id: "fixed-runtime-probe",
        method: value.method,
        params: value.params,
      }),
    );
  });
  socket.addEventListener("message", (message) => {
    try {
      const text = String(message.data);
      received += Buffer.byteLength(text);
      if (received > 8 * 1024 * 1024) throw new Error("output limit");
      const response = JSON.parse(text);
      if (response.type === "event" && response.event === "state_sync") {
        const payload = response.payload;
        state = {
          runtime_id: payload.runtimeId,
          session_id: payload.sessionId,
          leaf_id: payload.leafId,
          session_file: payload.sessionFile,
          provider: payload.model?.provider,
          model: payload.model?.id,
          thinking: payload.thinkingLevel,
        };
      }
      if (response.type !== "res" || response.id !== "fixed-runtime-probe")
        return;
      if (
        typeof response.ok !== "boolean" ||
        !state ||
        Buffer.byteLength(text) > 16384
      )
        throw new Error("response");
      clearTimeout(timer);
      finish({ ...response, state }, 0);
    } catch {
      finish({ ok: false }, 1);
    }
  });
  socket.addEventListener("error", () => finish({ ok: false }, 1));
} catch {
  finish({ ok: false }, 1);
}
