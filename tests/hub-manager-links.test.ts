import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readHubConfig } from "../hub/config.ts";
import { renderPortalHtml } from "../hub/portal.ts";
import { chatConfig } from "../manager/chat-service.ts";

function writeConfig(file: string, value: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

test("Hub managerLinks canonicalize separate root origins and reject hostile or overlapping URLs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hub-manager-links-"));
  const file = path.join(root, "hub.json");
  try {
    writeConfig(file, {
      port: 0,
      publicUrl: "https://chat.example",
      managerLinks: { requester: "https://requester.example", administrator: "https://administrator.example" },
    });
    assert.deepEqual(readHubConfig(file).managerLinks, {
      requester: "https://requester.example/",
      administrator: "https://administrator.example/",
    });

    for (const managerLinks of [
      { requester: "http://requester.example/" },
      { requester: "https://requester.example/not-the-root/" },
      { requester: "https://requester.example/?" },
      { requester: "https://requester.example/#" },
      { requester: "https://requester.example/", administrator: "https://administrator.example/?" },
      { requester: "https://requester.example/", administrator: "https://administrator.example/#" },
      { requester: "https://chat.example/" },
      { requester: "https://requester.example/", administrator: "https://requester.example/" },
      { requester: "https://requester.example/", administrator: "https://chat.example/" },
      { requester: "https://token@requester.example/" },
      { requester: "https://requester.example/", unexpected: "https://attacker.example/" },
      {},
    ]) {
      writeConfig(file, { port: 0, publicUrl: "https://chat.example/", managerLinks });
      assert.throws(() => readHubConfig(file));
    }

    writeConfig(file, {
      port: 0,
      publicUrl: "http://127.0.0.1:16180/",
      managerLinks: { requester: "http://localhost:16181", administrator: "http://[::1]:16182" },
    });
    assert.deepEqual(readHubConfig(file).managerLinks, {
      requester: "http://localhost:16181/",
      administrator: "http://[::1]:16182/",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat launcher strict config accepts managerLinks without widening its key surface", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chat-manager-links-"));
  try {
    const value = {
      port: 0,
      stateDir: path.join(root, "state"),
      runtimeDir: path.join(root, "runtime"),
      publicUrl: "https://chat.example/",
      managerLinks: { requester: "https://requester.example/", administrator: "https://administrator.example/" },
    };
    assert.deepEqual(chatConfig(value), value);
    assert.throws(() => chatConfig({ ...value, unexpected: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managerLinks navigation is escaped and legacy management navigation is unchanged when omitted", () => {
  const linked = renderPortalHtml(false, "https://chat.example/", "https://legacy-management.example/", {
    requester: "https://pi-admin.swordfate.cn/",
    administrator: "http://127.0.0.1:18302/",
  });
  assert.match(linked, /href="https:\/\/pi-admin\.swordfate\.cn\/"[^>]*>新建 Pi ↗<\/a>/);
  assert.match(linked, /href="http:\/\/127\.0\.0\.1:18302\/"[^>]*>打开管理员入口（仅本机可用） ↗<\/a>/);
  assert.doesNotMatch(linked, /https:\/\/pi-admin\.swordfate\.cn\/sessions\//);
  assert.doesNotMatch(linked, /token|credential|approval/i);

  const hostile = renderPortalHtml(
    false,
    "https://chat.example/",
    undefined,
    {
      requester: 'https://requester.example/\"><img src=x onerror=alert(1)>',
      administrator: 'https://administrator.example/\"><svg onload=alert(1)>',
    } as any,
  );
  assert.match(hostile, /href="https:\/\/requester\.example\/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(hostile, /href="https:\/\/administrator\.example\/&quot;&gt;&lt;svg onload=alert\(1\)&gt;"/);
  assert.doesNotMatch(hostile, /<img src=x|<svg onload=/);

  const legacy = renderPortalHtml(false, "https://chat.example/", "https://legacy-management.example/");
  assert.match(legacy, /href="https:\/\/legacy-management\.example\/sessions\/#new-pi"/);
  assert.match(legacy, /打开运行管理 ↗/);
});
