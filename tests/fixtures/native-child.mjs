// Executed as a real, isolated child; deliberately adversarial RPC peer, not a Pi substitute.
import { readFileSync, writeFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
writeFileSync("observed.json", JSON.stringify({ pid: process.pid, env: process.env, argv: process.argv.slice(2), cwd: process.cwd(),
  runtimeTransport: globalThis[Symbol.for("pi.runtime.stdin-guard.v1")]?.transport ?? null }));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const hold = setInterval(() => {}, 1000);
if (["hung", "stubborn"].includes(scenario)) process.on("SIGTERM", () => {});
process.stdin.on("end", () => {
  if (["hung", "stubborn"].includes(scenario)) return;
  writeFileSync("orderly-exit", "stdin closed");
  clearInterval(hold);
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (scenario === "early-exit") process.exit(7);
    if (scenario === "hung") continue;
    if (scenario === "oversize") { process.stdout.write("x".repeat(10000)); continue; }
    if (scenario === "invalid-utf8") { process.stdout.write(Buffer.from([0xff, 10])); continue; }
    if (scenario === "bad-json") { process.stdout.write("not json\n"); continue; }
    if (scenario === "stderr") process.stderr.write("e".repeat(100000));
    const response = { id: command.id, type: "response", command: command.type, success: true };
    if (command.type === "get_state") {
      if (scenario === "wrong-id") { send({ ...response, id: "forged" }); continue; }
      if (scenario === "wrong-command") { send({ ...response, command: "prompt" }); continue; }
      if (scenario === "failed-start") { send({ ...response, success: false, error: "fixture failure" }); continue; }
      send({ ...response, data: { isStreaming: false, isCompacting: false } });
    } else if (command.type === "prompt") {
      if (scenario === "rpc-timeout") continue;
      send({ ...response, data: { disposition: scenario === "handled" ? "handled" : "started" } });
      if (scenario === "handled") continue;
      send({ type: "agent_start" });
      if (["multi-turn", "multi-turn-retry"].includes(scenario)) {
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ACCEPTED_FIRST_TURN|" }], stopReason: "stop" } });
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_start" });
      }
      if (["retry", "multi-turn-retry"].includes(scenario)) {
        for (let attempt = 0; attempt < (scenario === "multi-turn-retry" ? 2 : 1); attempt++) {
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FAILED_PARTIAL|" }], stopReason: "error", errorMessage: "temporary provider failure" } });
          send({ type: "agent_end", messages: [], willRetry: true });
          send({ type: "agent_start" });
        }
      }
      if (scenario === "final-error") {
        send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "terminal provider failure" } });
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled", aborted: false });
        continue;
      }
      if (scenario === "prompt-overflow") { process.stdout.write("x".repeat(10000)); continue; }
      if (scenario === "output-overflow") {
        for (let i = 0; i < 3; i++) send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }], stopReason: "stop" } });
        continue;
      }
      send({ type: "agent_end", messages: [], willRetry: false });
      if (scenario === "end-only") continue;
      const event = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答复🙂\u2028line\u2029end" }], stopReason: "stop" } }) + "\n");
      const split = event.indexOf(Buffer.from("🙂")) + 1;
      process.stdout.write(event.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(event.subarray(split));
        send({ type: "agent_settled", aborted: false });
      }, 40);
    }
  }
});
