import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { portalManagementJs } from "../hub/portal.ts";

class Element {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  href = "";
  className = "";
  children: Element[] = [];
  handlers = new Map<string, (...args: any[]) => unknown>();
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  addEventListener(type: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(type, handler);
  }
  async fire(type: string) {
    await this.handlers.get(type)?.({ preventDefault() {} });
  }
}
const settled = async () => {
  await new Promise((r) => setImmediate(r));
};
function fixture() {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const calls: { route: string; options: any }[] = [];
  let authorized = false;
  let available = true;
  let target = {
    managed: true,
    reason: undefined as string | undefined,
    idle: true,
    pending: false,
    busy: false,
    mode: "auto",
    version: "1.0.0",
    runtime_id: "old",
    session_id: "saved",
    leaf_id: "leaf",
  };
  let failSubmit = false;
  let operation = { status: "running", stage: "starting" } as Record<string, unknown>;
  const confirmations: string[] = [];
  let confirm = true;
  const window: any = {
    addEventListener() {},
    dispatchEvent() {},
    confirm: (text: string) => {
      confirmations.push(text);
      return confirm;
    },
  };
  const intervals: (() => Promise<void>)[] = [];
  runInNewContext(portalManagementJs, {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelector: () => ({ content: "https://chat.example/" }),
    },
    URL,
    window,
    Event: class {},
    AbortSignal,
    Uint8Array,
    Date,
    crypto: {
      getRandomValues: (a: Uint8Array) => {
        a.fill(0xab);
        return a;
      },
    },
    setInterval: (fn: () => Promise<void>) => {
      intervals.push(fn);
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (route: string, options: any) => {
      calls.push({ route, options });
      let result: unknown;
      if (route.endsWith("status")) result = { available, authorized, ...(authorized ? { csrf: "csrf-value" } : {}) };
      else if (route.endsWith("unlock")) {
        authorized = true;
        result = { authorized, csrf: "csrf-value" };
      } else if (route.includes("/targets/")) result = target;
      else if (options.method === "POST" && route.endsWith("restarts")) {
        if (failSubmit) throw new Error();
        result = { id: "ab".repeat(16), ...operation };
      } else if (route.includes("/restarts/")) result = { id: "ab".repeat(16), ...operation };
      else if (route.endsWith("logout")) {
        authorized = false;
        result = { authorized };
      }
      return { ok: true, status: 200, json: async () => result };
    },
  });
  const session = {
    generation: "1".repeat(32),
    label: "Project A",
    sessionName: "Saved work",
    path: `/s/${"1".repeat(32)}/`,
  };
  const card = new Element();
  const attach = () => {
    card.replaceChildren();
    window.piHubManagement.attach(card, session);
    return card.children[0];
  };
  const unlock = async () => {
    get("management-code").value = "f".repeat(32);
    await get("management-unlock").fire("submit");
  };
  return {
    get,
    calls,
    confirmations,
    attach,
    unlock,
    intervals,
    setConfirm: (v: boolean) => {
      confirm = v;
    },
    setBusy: () => {
      target = { ...target, busy: true };
    },
    setMissingEvidence: () => {
      target = { ...target, managed: false, reason: "source_evidence_unavailable" };
    },
    setAvailable: (v: boolean) => {
      available = v;
    },
    failSubmit: () => {
      failSubmit = true;
    },
    setOperation: (v: Record<string, unknown>) => {
      operation = v;
    },
  };
}

test("portal keeps restart locked until pairing, erases the code and confirms the exact selected target", async () => {
  const f = fixture();
  await settled();
  assert.equal(f.attach().disabled, true);
  await f.unlock();
  assert.equal(f.get("management-code").value, "");
  const button = f.attach();
  assert.equal(button.disabled, false);
  f.setConfirm(false);
  await button.fire("click");
  assert.match(f.confirmations[0], /Project A/);
  assert.match(f.confirmations[0], /Saved work/);
  assert.equal(
    f.calls.some((c) => c.options.method === "POST" && c.route.endsWith("restarts")),
    false,
  );
  f.setConfirm(true);
  await button.fire("click");
  const call = f.calls.find((c) => c.options.method === "POST" && c.route.endsWith("restarts"))!;
  assert.equal(call.options.headers["X-Pi-Hub-Csrf"], "csrf-value");
  assert.deepEqual(JSON.parse(call.options.body), {
    generation: "1".repeat(32),
    runtimeId: "old",
    sessionId: "saved",
    leafId: "leaf",
    idempotencyKey: "ab".repeat(16),
  });
  assert.equal(JSON.stringify(call).includes("f".repeat(32)), false);
});

test("missing source evidence explains validation instead of advising container recreation", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setMissingEvidence();
  await f.attach().fire("click");
  assert.match(f.get("management-notice").textContent, /兼容性.*证据|验证.*证据/);
  assert.match(f.get("management-notice").textContent, /运行时更新|验证/);
  assert.doesNotMatch(f.get("management-notice").textContent, /新镜像|重新启动一次/);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.filter((c) => c.options.method === "POST" && c.route.endsWith("restarts")).length, 0);
});

test("busy target cannot be confirmed and lost reply polls without resubmitting", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setBusy();
  await f.attach().fire("click");
  assert.equal(f.confirmations.length, 0);
  const g = fixture();
  await settled();
  await g.unlock();
  g.failSubmit();
  await g.attach().fire("click");
  for (const poll of g.intervals) await poll();
  assert.equal(g.calls.filter((c) => c.options.method === "POST" && c.route.endsWith("restarts")).length, 1);
  assert.equal(
    g.calls.some((c) => c.route.endsWith(`/restarts/${"ab".repeat(16)}`)),
    true,
  );
  g.setOperation({ status: "succeeded", stage: "complete", path: `/s/${"2".repeat(32)}/`, new_version: "1.1.0" });
  for (const poll of g.intervals) await poll();
  const result = g.get("management-results").children[0];
  assert.match(result.children[0].textContent, /1.1.0/);
  assert.equal(result.children[1].href, `https://chat.example/s/${"2".repeat(32)}/`);
});

test("historical success explains unavailable link and removes a previously returned path", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setOperation({ status: "succeeded", stage: "complete", path: `/s/${"2".repeat(32)}/` });
  await f.attach().fire("click");
  assert.equal(f.get("management-results").children[0].children[1].href, `https://chat.example/s/${"2".repeat(32)}/`);
  f.setOperation({ status: "succeeded", stage: "complete" });
  for (const poll of f.intervals) await poll();
  const row = f.get("management-results").children[0];
  assert.match(row.children[0].textContent, /已恢复原会话/);
  assert.equal(
    row.children.some((child) => !!child.href),
    false,
    "omitted path must clear cached link",
  );
  assert.ok(row.children.some((child) => /当前.*链接.*不可用/.test(child.textContent)));
  assert.equal(f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("restarts")).length, 1);
});

test("bounded successor links remain usable without broadening operation IDs", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  const generation = `b2-${"a".repeat(32)}-0000000000000001-${"b".repeat(32)}`;
  f.setOperation({ status: "succeeded", stage: "complete", path: `/s/${generation}/` });
  await f.attach().fire("click");
  assert.equal(f.get("management-results").children[0].children[1].href, `https://chat.example/s/${generation}/`);
  const submission = f.calls.find((c) => c.options.method === "POST" && c.route.endsWith("restarts"))!;
  assert.match(JSON.parse(submission.options.body).idempotencyKey, /^[a-f0-9]{32}$/);
});
