import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { launchPortalJs } from "../hub/launch-portal.ts";

class Element {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  href = "";
  className = "";
  type = "";
  children: Element[] = [];
  handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => unknown) {
    this.handlers.set(type, callback);
  }
  async fire(type = "click") {
    if (!this.disabled) await this.handlers.get(type)?.({ preventDefault() {} });
  }
}
function fixture(
  options: {
    lose?: boolean;
    storageFails?: boolean;
    confirm?: boolean;
    storage?: Map<string, string>;
    now?: () => number;
  } = {},
) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id) as Element;
  };
  const calls: { route: string; body?: Record<string, unknown> }[] = [];
  const storage = options.storage ?? new Map<string, string>();
  let randomByte = 7;
  let job: Record<string, unknown> | undefined;
  let delayed: (() => Promise<void>) | undefined;
  let failNextStorageSet = false;
  const context = {
    get,
    URL,
    URLSearchParams,
    Uint8Array,
    Date: options.now ? { now: options.now } : Date,
    document: { createElement: () => new Element(), querySelector: () => ({ content: "https://chat.example/" }) },
    auth: { authorized: true, gateManagementAvailable: true },
    authGeneration: 0,
    authTransition: false,
    window: { confirm: () => options.confirm !== false },
    crypto: { getRandomValues: (a: Uint8Array) => a.fill(randomByte++) },
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => {
        if (options.storageFails || failNextStorageSet) {
          failNextStorageSet = false;
          throw new Error();
        }
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    api: async (route: string, body?: Record<string, unknown>) => {
      calls.push({ route, body });
      if (delayed) await delayed();
      if (route === "gate/launch-config")
        return {
          enabled: true,
          rootLabel: "gitproject",
          defaultPath: "pi_projects",
          revision: "a".repeat(64),
          maxActive: 16,
        };
      if (route.startsWith("gate/workspaces?")) {
        const path = new URLSearchParams(route.split("?")[1]).get("path") ?? "";
        return {
          path,
          parent: path === "" ? null : path.split("/").slice(0, -1).join("/"),
          revision: "b".repeat(64),
          entries:
            path === ""
              ? [{ name: "pi_projects", path: "pi_projects" }]
              : [{ name: "project-a", path: `${path}/project-a` }],
          truncated: false,
        };
      }
      if (route === "gate/launches" && !body) return { jobs: job ? [job] : [] };
      if (route === "gate/launches" && body) {
        const persisted = [...storage.values()].map((raw) => JSON.parse(raw));
        assert.ok(persisted.some((value) => value.id === body.id && Object.keys(value).length === 1));
        assert.ok(
          persisted.some(
            (value) =>
              value.id === body.id &&
              value.path === body.path &&
              value.label === body.label &&
              value.policy_revision === body.policy_revision &&
              value.workspace_revision === body.workspace_revision,
          ),
        );
        job = {
          id: body.id,
          path: body.path,
          label: body.label,
          status: "running",
          stage: "running",
          created_at: 1,
          updated_at: 1,
        };
        if (options.lose) throw new Error("lost response after creating");
        return structuredClone(job);
      }
      if (route.startsWith("gate/launches/")) {
        if (!job) throw Object.assign(new Error(), { status: 404 });
        return structuredClone(job);
      }
      throw new Error(route);
    },
  };
  const module = runInNewContext(
    `${launchPortalJs}\n({ launchPi, lock() { authGeneration++; auth.authorized = false; launchPi.clearProtected(); }, unlock() { authGeneration++; auth.authorized = true; launchPi.updateAuth(); } })`,
    context,
  ) as { launchPi: { poll(): Promise<void>; updateAuth(): void }; lock(): void; unlock(): void };
  const button = (text: string) => {
    const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
    const found = [...elements.values()]
      .flatMap(all)
      .find((node) => node.textContent === text && node.handlers.has("click"));
    assert.ok(found, `missing ${text}`);
    return found;
  };
  return {
    ...module,
    get,
    calls,
    storage,
    context,
    setJob(value: Record<string, unknown>) {
      job = value;
    },
    button,
    defer(fn: () => Promise<void>) {
      delayed = fn;
    },
    failNextStorageSet() {
      failNextStorageSet = true;
    },
  };
}

test("new Pi defaults to pi_projects, browses children and stops at root", async () => {
  const f = fixture();
  await f.launchPi.poll();
  assert.match(f.get("launch-current").textContent, /gitproject\/pi_projects/);
  await f.button("打开 project-a").fire();
  assert.match(f.get("launch-current").textContent, /pi_projects\/project-a/);
  await f.get("launch-root").fire();
  assert.equal(f.get("launch-parent").disabled, true);
});

test("explicit launch persists exact request once and duplicate click stays blocked", async () => {
  const f = fixture();
  await f.launchPi.poll();
  f.get("launch-name").value = "手机开发";
  await f.get("launch-form").fire("submit");
  await f.get("launch-form").fire("submit");
  const writes = f.calls.filter((call) => call.body);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].body)), {
    id: "07".repeat(16),
    path: "pi_projects",
    label: "手机开发",
    policy_revision: "a".repeat(64),
    workspace_revision: "b".repeat(64),
  });
  assert.match(
    f
      .get("launch-jobs")
      .children.map((node) => JSON.stringify(node))
      .join(),
    /等待.*登记/,
  );
  assert.equal(f.get("launch-start").disabled, true);
});

test("lost response and reloaded page query original id without replaying POST", async () => {
  const f = fixture({ lose: true });
  await f.launchPi.poll();
  await f.get("launch-form").fire("submit");
  await f.launchPi.poll();
  assert.equal(f.calls.filter((call) => call.body).length, 1);
  assert.ok(f.calls.some((call) => call.route === `gate/launches/${"07".repeat(16)}` && !call.body));
  const reopened = fixture({ storage: f.storage });
  await reopened.launchPi.poll();
  await reopened.get("launch-form").fire("submit");
  assert.equal(reopened.calls.filter((call) => call.body).length, 0);
  assert.equal(reopened.get("launch-start").disabled, true);
});

test("locking redacts a pending launch to its recovery id without permitting a replay", async () => {
  const f = fixture({ lose: true });
  await f.launchPi.poll();
  f.get("launch-name").value = "私密项目名称";
  await f.get("launch-form").fire("submit");
  const id = "07".repeat(16);

  const restoredStorage = new Map(f.storage);
  const restored = fixture({ storage: restoredStorage });
  assert.deepEqual(
    [...restoredStorage.values()].map((raw) => JSON.parse(raw)),
    [{ id }],
  );
  await restored.launchPi.poll();
  await restored.get("launch-form").fire("submit");
  assert.ok(restored.calls.some((call) => call.route === `gate/launches/${id}` && !call.body));
  assert.equal(restored.calls.filter((call) => call.body).length, 0);

  f.lock();

  assert.equal(f.get("launch-current").textContent, "");
  assert.equal(f.get("launch-name").value, "");
  assert.equal(f.get("launch-jobs").children.length, 0);
  assert.deepEqual(
    [...f.storage.values()].map((raw) => JSON.parse(raw)),
    [{ id }],
  );

  f.unlock();
  await f.launchPi.poll();
  assert.ok(f.calls.some((call) => call.route === `gate/launches/${id}` && !call.body));
  await f.get("launch-form").fire("submit");
  assert.equal(f.calls.filter((call) => call.body).length, 1);

  const reopened = fixture({ storage: f.storage });
  await reopened.launchPi.poll();
  await reopened.get("launch-form").fire("submit");
  assert.ok(reopened.calls.some((call) => call.route === `gate/launches/${id}` && !call.body));
  assert.equal(reopened.calls.filter((call) => call.body).length, 0);
  assert.equal(reopened.get("launch-start").disabled, true);
});

test("failed lock redaction preserves a durable recovery id across reload", async () => {
  const f = fixture({ lose: true });
  await f.launchPi.poll();
  f.get("launch-name").value = "不能泄露的目录名称";
  await f.get("launch-form").fire("submit");
  const id = "07".repeat(16);

  f.failNextStorageSet();
  f.lock();

  const stored = [...f.storage.values()].map((raw) => JSON.parse(raw));
  assert.deepEqual(stored, [{ id }]);
  assert.equal(
    [...f.storage.values()].some((raw) => raw.includes("不能泄露") || raw.includes("pi_projects")),
    false,
  );

  const reopened = fixture({ storage: f.storage });
  await reopened.launchPi.poll();
  await reopened.get("launch-form").fire("submit");
  assert.ok(reopened.calls.some((call) => call.route === `gate/launches/${id}` && !call.body));
  assert.equal(reopened.calls.filter((call) => call.body).length, 0);
  assert.equal(reopened.get("launch-start").disabled, true);
});

test("storage failure or confirmation cancellation refuses to start a container", async () => {
  for (const options of [{ storageFails: true }, { confirm: false }]) {
    const f = fixture(options);
    await f.launchPi.poll();
    await f.get("launch-form").fire("submit");
    assert.equal(f.calls.filter((call) => call.body).length, 0);
  }
});

test("polling preserves name and selected directory and lock clears protected state", async () => {
  const f = fixture();
  await f.launchPi.poll();
  f.get("launch-name").value = "未保存的名称";
  await f.launchPi.poll();
  assert.equal(f.get("launch-name").value, "未保存的名称");
  assert.match(f.get("launch-current").textContent, /pi_projects/);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.defer(() => waiting);
  const poll = f.launchPi.poll();
  f.lock();
  release?.();
  await poll;
  assert.equal(f.get("launch-current").textContent, "");
  assert.equal(f.get("launch-name").value, "");
  assert.equal(f.get("launch-jobs").children.length, 0);
});

test("only an explicit New Another action permits a fresh independent launch", async () => {
  const f = fixture();
  await f.launchPi.poll();
  await f.get("launch-form").fire("submit");
  await f.get("launch-again").fire();
  await f.get("launch-form").fire("submit");
  const writes = f.calls.filter((call) => call.body);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].body?.id, writes[1].body?.id);
  assert.equal(writes[0].body?.path, writes[1].body?.path);
});

test("only exact chat-origin session routes become clickable launch links", async () => {
  const f = fixture();
  await f.launchPi.poll();
  const base = {
    id: "c".repeat(32),
    path: "pi_projects",
    label: "安全链接",
    status: "running",
    stage: "running",
    created_at: 1,
    updated_at: 1,
  };
  for (const sessionUrl of [
    `https://evil.invalid/s/${"a".repeat(32)}/`,
    `https://chat.example/s/${"a".repeat(32)}/?token=x`,
    "https://chat.example/admin/",
  ]) {
    f.setJob({ ...base, sessionUrl });
    await f.launchPi.poll();
    assert.equal(
      f.get("launch-jobs").children[0].children.some((node) => !!node.href),
      false,
    );
  }
  const sessionUrl = `https://chat.example/s/${"a".repeat(32)}/`;
  f.setJob({ ...base, sessionUrl });
  await f.launchPi.poll();
  assert.equal(f.get("launch-jobs").children[0].children.at(-1)?.href, sessionUrl);
});

test("repeated running observations age registration help and an exact registered link wins", async () => {
  let now = 1001000;
  const f = fixture({ now: () => now });
  const job = {
    id: "c".repeat(32),
    run_id: "d".repeat(32),
    path: "pi_projects",
    label: "等待登记",
    status: "running",
    stage: "running",
    created_at: 1000000,
    updated_at: 1001000,
  };
  const text = () =>
    f
      .get("launch-jobs")
      .children[0].children.map((node) => node.textContent)
      .join(" ");
  for (now = 1001000; now <= 1071000; now += 5000) {
    f.setJob({ ...job });
    await f.launchPi.poll();
    assert.equal(text().includes("登记等待较久"), now - job.updated_at > 60000);
    assert.ok(text().includes(job.id));
  }
  const sessionUrl = `https://chat.example/s/${"a".repeat(32)}/`;
  f.setJob({ ...job, sessionUrl });
  await f.launchPi.poll();
  assert.equal(text().includes("登记等待较久"), false);
  assert.match(text(), /会话已登记，可以进入/);
  assert.equal(f.get("launch-jobs").children[0].children.at(-1)?.href, sessionUrl);
  assert.equal(f.calls.filter((call) => call.body).length, 0);
});
