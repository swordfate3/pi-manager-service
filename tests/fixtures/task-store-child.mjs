import { createInterface } from "node:readline";
import { TaskStore } from "../../manager/task-store.ts";

const root = process.env.TASK_STORE_ROOT;
if (!root) throw new Error("TASK_STORE_ROOT is required");

let store;
try {
  store = await TaskStore.open(root, { recoverStaleLock: process.env.TASK_STORE_RECOVER === "1" });
  let taskId;
  if (process.env.TASK_STORE_MODE === "running") {
    const submitted = await store.submit({
      key: "crash-recovery",
      requester: "fixture-operator",
      target: "pi:fixture",
      action: "create",
      payload: { workspace: "fixture-workspace" },
    });
    const queued = await store.transition(submitted.id, "pending_approval", "queued", {
      expectedRevision: submitted.revision,
    });
    const running = await store.transition(submitted.id, "queued", "running", {
      expectedRevision: queued.revision,
    });
    taskId = running.id;
  }
  process.stdout.write(`${JSON.stringify({ status: "ready", taskId })}\n`);
  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    if (line === "close") break;
  }
  await store.close();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      status: "error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Task store child failed",
    })}\n`,
  );
  process.exitCode = 2;
}
