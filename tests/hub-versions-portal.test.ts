import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { portalJs } from "../hub/portal.ts";

class Element {
  textContent = "";
  title = "";
  className = "";
  value = "";
  children: Element[] = [];
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
}
function text(node: Element): string {
  return [node.textContent, ...node.children.map(text)].join(" ");
}
async function fixture(sessions: unknown[], versions?: unknown) {
  const nodes = new Map<string, Element>();
  const get = (id: string): Element => {
    let node = nodes.get(id);
    if (!node) {
      node = new Element();
      nodes.set(id, node);
    }
    return node;
  };
  runInNewContext(portalJs, {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ sessions, versions }) }),
    setInterval() {},
    AbortSignal,
    Date,
  });
  await new Promise((r) => setImmediate(r));
  return get;
}
const build = "a".repeat(64);
const available = {
  status: "ok",
  checkedAt: 100,
  pi: { version: "1.3.0" },
  webUi: { version: "0.1.1", build },
  hub: { version: "0.1.1", build },
};
const session = (software?: unknown, runtime?: unknown) => ({
  label: "Project",
  sessionName: "A saved session",
  since: 0,
  path: "/s/fixture/",
  software,
  runtime,
});

test("Hub cards show nonmanaged running Pi version and Web build separately below session name", async () => {
  const get = await fixture([session({ piVersion: "1.2.0", webUi: { version: "0.1.1", build } })], available);
  const card = text(get("sessions"));
  assert.match(card, /A saved session/);
  assert.match(card, /Pi 1.2.0 可更新至 1.3.0/);
  assert.match(card, /Web 扩展 0.1.1 · aaaaaaaa 与发布版本一致/);
  assert.match(text(get("version-summary")), /1 个会话可更新/);
  assert.doesNotMatch(card, /不支持重启/);
});

test("same package version with different build is a difference, never a proven update", async () => {
  const get = await fixture(
    [session({ piVersion: "1.3.0", webUi: { version: "0.1.1", build: "b".repeat(64) } })],
    available,
  );
  assert.match(text(get("sessions")), /与发布构建不同/);
  assert.match(text(get("version-summary")), /1 个会话存在版本差异/);
  assert.doesNotMatch(text(get("version-summary")), /个会话可更新/);
});

test("legacy clients fall back to managed runtime and do not invent Web build or latest state", async () => {
  const get = await fixture([session(undefined, { version: "1.3.0", managed: true }), session()], available);
  assert.match(text(get("sessions")), /Pi 1.3.0 与发布版本一致/);
  assert.match(text(get("sessions")), /Web 扩展 未上报 版本未上报/);
  assert.match(text(get("sessions")), /Pi 未上报 版本未上报/);
  assert.match(text(get("sessions")), /受管运行 · 重启资格需另行检查/);
});

test("unavailable checks cannot turn retained targets into current or update claims", async () => {
  const get = await fixture([session({ piVersion: "1.0.0", webUi: { version: "0.1.1", build } })], {
    ...available,
    status: "unavailable",
  });
  assert.match(text(get("version-summary")), /不可用 · 更新状态未知/);
  assert.match(text(get("sessions")), /更新状态未知/);
  assert.doesNotMatch(text(get("sessions")), /可更新至|与发布版本一致/);
});

test("checking state and older Hub API keep running versions visible without a false current verdict", async () => {
  for (const versions of [undefined, { ...available, status: "checking" }]) {
    const get = await fixture([session({ piVersion: "1.0.0", webUi: { version: "0.1.1", build } })], versions);
    assert.match(text(get("sessions")), /Pi 1.0.0 更新状态未知/);
    assert.doesNotMatch(text(get("sessions")), /可更新至|与发布版本一致/);
  }
});

test("numeric semver comparison handles multi-digit versions and ahead without lexical ordering", async () => {
  const get = await fixture(
    [
      session({ piVersion: "1.10.0" }),
      session({ piVersion: "1.3.0+local.build.2" }),
      session({ piVersion: "1.3.0-preview" }),
      session({ piVersion: "99999999999999999999.0.0" }),
    ],
    available,
  );
  assert.match(text(get("sessions")), /1.10.0 高于发布版本/);
  assert.match(text(get("sessions")), /1.3.0\+local.build.2 与发布版本一致/);
  assert.match(text(get("sessions")), /1.3.0-preview 版本无法比较/);
  assert.match(text(get("sessions")), /99999999999999999999.0.0 版本无法比较/);
  assert.doesNotMatch(text(get("sessions")), /可更新至/);
});

test("partial checks show the known target only and same semver without a build remains unverified", async () => {
  const get = await fixture([session({ piVersion: "1.3.0", webUi: { version: "0.1.1" } })], {
    ...available,
    status: "partial",
    pi: undefined,
  });
  assert.match(text(get("sessions")), /Pi 1.3.0 更新状态未知/);
  assert.match(text(get("sessions")), /构建未上报 · 无法确认一致/);
  assert.match(text(get("version-summary")), /部分发布信息不可用/);
});

test("Manager identity is not compared with a Web extension release, and no version string is inserted as HTML", async () => {
  const get = await fixture([session({ piVersion: "<script>bad</script>", webUi: { version: "0.1.1", build } })], {
    ...available,
    hub: { version: "0.1.1", build: "c".repeat(64) },
  });
  assert.doesNotMatch(text(get("version-summary")), /Hub 存在版本差异/);
  assert.match(text(get("version-details")), /Manager 0.1.1 · cccccccc 发布源未配置/);
  assert.match(text(get("sessions")), /<script>bad<\/script> 版本无法比较/);
  assert.doesNotMatch(portalJs, /innerHTML/);
});
