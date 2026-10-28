import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startChatService } from "../manager/chat-service.ts";
import { EnrollmentClient } from "../manager/enrollment/client.ts";
import { digest } from "../manager/validation.ts";

test("chat owns separate broker lifecycle; broker startup failure releases Hub locks/listeners", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-enrollment-")); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, "ipc/enroll.sock"); await mkdir(path.dirname(socketPath), { mode: 0o700 });
  const config = { port: 0, stateDir: path.join(root, "state"), runtimeDir: path.join(root, "runtime"),
    provisioning: { socketPath, exportDir: path.join(root, "exports"), tokenHash: digest("a".repeat(64)) } };
  const file = path.join(root, "chat.json"); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await writeFile(socketPath, "existing path");
  await assert.rejects(startChatService(file)); assert.equal(await readFile(socketPath, "utf8"), "existing path");
  await rm(socketPath);
  const chat = await startChatService(file);
  try {
    const authorityFile = path.join(root, "authority.json"); await writeFile(authorityFile, JSON.stringify({ token: "a".repeat(64) }), { mode: 0o600 });
    const client = new EnrollmentClient({ socketPath, authorityFile, registryHostDirectory: config.runtimeDir, exportHostDirectory: config.provisioning.exportDir });
    const key = "12345678-1234-1234-1234-123456789abc";
    await client.issue(key, "one"); assert.equal(await client.status(key, "one"), false);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: chat.port, path: "/issue", method: "POST" }, res => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end();
    }); assert.notEqual(status, 200);
    await chat.close(); await assert.rejects(client.issue(key, "one")); client.close();
  } finally { await chat.close(); }
  const restarted = await startChatService(file); await restarted.close();
});
