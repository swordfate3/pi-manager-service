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
  handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  addEventListener(type: string, handler: (event: { preventDefault(): void }) => unknown) {
    this.handlers.set(type, handler);
  }
  async fire(type: string) {
    await this.handlers.get(type)?.({ preventDefault() {} });
  }
}

const settled = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

function nodeText(node: Element): string {
  return [node.textContent, ...node.children.map(nodeText)].join(" ");
}

function storedJson(storage: Map<string, string>, key: string): unknown {
  const value = storage.get(key);
  if (value === undefined) throw new Error(`missing stored value: ${key}`);
  return JSON.parse(value);
}

type RuntimeJob = {
  id: string;
  version: string;
  status: string;
  stage: string;
  targets: Array<{
    run_id: string;
    status: string;
    old_version?: string;
    version?: string;
    wait_reason?: string;
  }>;
  resolved?: boolean;
  resolved_at?: string;
  created_at?: string;
};

type RuntimeCatalog = {
  status: "fresh" | "stale" | "unavailable";
  checked_at?: number;
  versions: Array<{ version: string }>;
  next_cursor?: string;
};

type RuntimeReadiness = {
  status: "ready" | "blocked" | "unavailable";
  installed_version?: string;
  consumers: Array<{ run_id: string; version?: string; ready: boolean; reason?: string }>;
};

const taskId = "cd".repeat(16);
const savedTaskId = "ef".repeat(16);

function job(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    id: taskId,
    version: "1.3.0",
    status: "pending",
    stage: "awaiting_approval",
    targets: [],
    created_at: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(
  options: {
    authorized?: boolean;
    runtimeUpdatesAvailable?: boolean;
    restartAvailable?: boolean;
    policy?: "manual" | "auto" | "disabled";
    jobs?: RuntimeJob[];
    active?: RuntimeJob[];
    stored?: { id: string; version: string };
    storageThrows?: boolean;
    cookieJar?: boolean;
    gateway?: boolean;
    catalog?: RuntimeCatalog;
    readiness?: RuntimeReadiness;
    catalogFor?: (query: string, cursor: string) => RuntimeCatalog;
  } = {},
) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new Element();
      elements.set(id, element);
    }
    return element;
  };
  let authorized = options.authorized ?? false;
  let cookie = authorized ? "initial" : "";
  let cookieSequence = 0;
  const sessions = new Set(authorized ? [cookie] : []);
  const runtimeUpdatesAvailable = options.runtimeUpdatesAvailable ?? true;
  const restartAvailable = options.restartAvailable ?? true;
  const policy = options.policy ?? "manual";
  let jobs = options.jobs ?? [];
  let active = options.active ?? [];
  const initialJob = job();
  let postResult: unknown = initialJob;
  let postStatus = 202;
  let postFailure: "network" | undefined;
  let detailStatus = 200;
  let detailJob: RuntimeJob = initialJob;
  let catalog: RuntimeCatalog =
    options.catalog ??
    ({ status: "fresh", checked_at: 1792630800000, versions: [{ version: "1.3.0" }, { version: "1.2.0" }] } as const);
  let readiness: RuntimeReadiness = options.readiness ?? { status: "ready", installed_version: "1.3.0", consumers: [] };
  let confirmResult = true;
  const confirmations: string[] = [];
  type FetchOptions = { method: string; headers: Record<string, string>; body?: string };
  const calls: Array<{ route: string; options: FetchOptions }> = [];
  let nextHold: { route: string; method: string; status?: number; captured(): void; wait: Promise<void> } | undefined;
  const intervals: Array<() => Promise<void>> = [];
  const storage = new Map<string, string>();
  if (options.stored) storage.set("pi-hub-runtime-update", JSON.stringify(options.stored));
  let storedBeforePost: string | null = null;
  const window: {
    addEventListener(): void;
    dispatchEvent(): void;
    confirm(message: string): boolean;
    piHubManagement?: {
      attach(card: Element, session: { generation: string; label: string; sessionName: string; path: string }): void;
    };
  } = {
    addEventListener() {},
    dispatchEvent() {},
    confirm: (message: string) => {
      confirmations.push(message);
      return confirmResult;
    },
  };
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
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xcd);
        return array;
      },
    },
    setInterval: (callback: () => Promise<void>) => {
      intervals.push(callback);
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.storageThrows) throw new Error("storage unavailable");
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (route: string, fetchOptions: FetchOptions) => {
      calls.push({ route, options: fetchOptions });
      const cookieValid = sessions.has(cookie);
      let cookieUpdate: string | undefined;
      let result: unknown;
      let status = 200;
      if (route.endsWith("/status")) {
        result = {
          available: runtimeUpdatesAvailable || restartAvailable,
          authorized,
          runtimeUpdatesAvailable,
          restartAvailable,
          ...(options.gateway ? { authMode: "gateway" } : {}),
          ...(authorized ? { csrf: "csrf-value" } : {}),
        };
      } else if (route.endsWith("/unlock") || route.endsWith("/gateway")) {
        authorized = true;
        cookieUpdate = `paired-${++cookieSequence}`;
        sessions.add(cookieUpdate);
        result = { authorized, csrf: "csrf-value" };
      } else if (route.endsWith("/logout")) {
        authorized = false;
        sessions.delete(cookie);
        cookieUpdate = "";
        result = { authorized };
      } else if (route.includes("/runtime-versions") && fetchOptions.method === "GET") {
        const url = new URL(route, "https://hub.example");
        result =
          options.catalogFor?.(url.searchParams.get("query") ?? "", url.searchParams.get("cursor") ?? "") ?? catalog;
      } else if (route.endsWith("/runtime-readiness") && fetchOptions.method === "GET") {
        result = readiness;
      } else if (route.endsWith("/runtime-updates") && fetchOptions.method === "GET") {
        result = { policy: { mode: policy }, jobs, active };
      } else if (route.endsWith("/runtime-updates") && fetchOptions.method === "POST") {
        storedBeforePost = storage.get("pi-hub-runtime-update") ?? null;
        if (postFailure === "network") throw new Error("lost response");
        result = postResult;
        status = postStatus;
      } else if (route.includes("/runtime-updates/")) {
        status = detailStatus;
        result = detailJob;
      }
      if (
        options.cookieJar &&
        !cookieValid &&
        !route.endsWith("/unlock") &&
        !route.endsWith("/gateway") &&
        !route.endsWith("/status")
      ) {
        status = 401;
        result = {};
      }
      if (nextHold && route.endsWith(nextHold.route) && fetchOptions.method === nextHold.method) {
        const held = nextHold;
        nextHold = undefined;
        status = held.status ?? status;
        held.captured();
        await held.wait;
      }
      // Browsers apply Set-Cookie before application JavaScript sees a response.
      if (options.cookieJar && cookieUpdate !== undefined) cookie = cookieUpdate;
      return { ok: status >= 200 && status < 300, status, json: async () => result };
    },
  });
  const unlock = async () => {
    get("management-code").value = "f".repeat(32);
    await get("management-unlock").fire("submit");
    await settled();
  };
  const submit = async (version: string) => {
    get("runtime-update-version").value = version;
    await get("runtime-update-form").fire("submit");
    await settled();
  };
  return {
    window,
    get,
    calls,
    intervals,
    confirmations,
    storage,
    unlock,
    submit,
    text: (id: string) => nodeText(get(id)),
    setConfirm: (value: boolean) => {
      confirmResult = value;
    },
    setPostFailure: () => {
      postFailure = "network";
    },
    setDetail: (status: number, value: RuntimeJob = detailJob) => {
      detailStatus = status;
      detailJob = value;
    },
    setSubmitted: (value: RuntimeJob) => {
      postResult = value;
      detailJob = value;
    },
    setPostResult: (status: number, value: unknown) => {
      postStatus = status;
      postResult = value;
    },
    setJobs: (value: RuntimeJob[], activeValue: RuntimeJob[] = []) => {
      jobs = value;
      active = activeValue;
    },
    setCatalog: (value: RuntimeCatalog) => {
      catalog = value;
    },
    setReadiness: (value: RuntimeReadiness) => {
      readiness = value;
    },
    storedBeforePost: () => storedBeforePost,
    holdNextResponse: (route: string, status?: number, method = "GET") => {
      let markCaptured = () => {};
      let release = () => {};
      const captured = new Promise<void>((resolve) => {
        markCaptured = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextHold = { route, method, status, captured: markCaptured, wait };
      return { captured, release };
    },
  };
}

test("published versions are selectable without claiming compatibility and readiness blockers are visible", async () => {
  const blockedRun = "9".repeat(32);
  const f = fixture({
    authorized: true,
    catalog: {
      status: "fresh",
      checked_at: 1792630800000,
      versions: [{ version: "1.4.0" }, { version: "1.3.0" }],
    },
    readiness: {
      status: "blocked",
      installed_version: "1.3.0",
      consumers: [{ run_id: blockedRun, version: "1.1.0", ready: false, reason: "protocol_unavailable" }],
    },
  });
  await settled();

  assert.match(f.text("runtime-version-list"), /1\.4\.0.*已发布.*未验证/);
  assert.match(f.text("runtime-version-selected"), /1\.4\.0.*已发布.*未验证/);
  assert.doesNotMatch(f.text("runtime-version-selected"), /兼容(?:$|[；。])/);
  assert.equal(f.get("runtime-update-version").value, "1.4.0");
  assert.match(f.text("runtime-readiness"), /已安装.*1\.3\.0/);
  assert.match(f.text("runtime-readiness"), new RegExp(blockedRun));
  assert.match(f.text("runtime-readiness"), /刷新协议不可用|protocol unavailable/);
  assert.match(f.text("runtime-readiness"), /阻止|未就绪/);

  await f.get("runtime-version-list").children[1].fire("click");
  assert.equal(f.get("runtime-update-version").value, "1.3.0");
  assert.match(f.text("runtime-version-selected"), /1\.3\.0.*兼容性.*未知|1\.3\.0.*尚未.*验证/);
});

for (const [installed, selected, direction] of [
  ["1.9.0", "1.10.0", /升级/],
  ["1.10.0", "1.9.0", /降级/],
  ["1.9.0", "1.9.0", /同版本/],
  [undefined, "1.9.0", /方向未知|无法判断.*方向/],
] as const) {
  for (const surface of ["selection", "confirmation"] as const) {
    test(`version direction ${installed ?? "unknown"} -> ${selected} in ${surface} uses shared installed metadata`, async () => {
      const f = fixture({
        authorized: true,
        catalog: { status: "fresh", versions: [{ version: selected }] },
        readiness: {
          status: "ready",
          installed_version: installed,
          consumers: [{ run_id: "1".repeat(32), version: "99.0.0", ready: true }],
        },
      });
      await settled();
      f.setConfirm(false);
      await f.submit(selected);
      const rendered = surface === "selection" ? f.text("runtime-version-selected") : f.confirmations[0];
      assert.match(rendered, direction);
      if (installed === "1.10.0") assert.match(rendered, /停止.*前.*会话.*兼容|会话.*兼容.*停止/);
      assert.equal(f.calls.filter((call) => call.options.method === "POST").length, 0);
    });
  }
}

test("catalog search and opaque paging stay bounded to the fixed management route", async () => {
  const f = fixture({
    authorized: true,
    catalogFor: (query, cursor) => {
      if (query === "1.4") return { status: "fresh", versions: [{ version: "1.4.0" }] };
      if (cursor === "older+stable") return { status: "fresh", versions: [{ version: "1.1.0" }] };
      return {
        status: "fresh",
        versions: [{ version: "1.3.0" }, { version: "1.2.0" }],
        next_cursor: "older+stable",
      };
    },
  });
  await settled();
  assert.equal(f.get("runtime-version-more").hidden, false);
  await f.get("runtime-version-more").fire("click");
  await settled();
  assert.match(f.text("runtime-version-list"), /1\.3\.0/);
  assert.match(f.text("runtime-version-list"), /1\.1\.0/);
  assert.ok(f.calls.some((call) => call.route.includes("runtime-versions?query=&cursor=older%2Bstable")));

  f.get("runtime-version-search").value = "1.4";
  await f.get("runtime-version-search").fire("input");
  await settled();
  assert.match(f.text("runtime-version-list"), /1\.4\.0/);
  assert.doesNotMatch(f.text("runtime-version-list"), /1\.3\.0/);
  assert.ok(f.calls.some((call) => call.route.endsWith("runtime-versions?query=1.4&cursor=")));
  assert.ok(f.calls.every((call) => !call.route.includes("registry=")));
});

test("a third catalog page stays selectable while the bounded window drops only the oldest visible row", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ version: `3.0.${index}` }));
  const secondPage = Array.from({ length: 50 }, (_, index) => ({ version: `2.0.${index}` }));
  const f = fixture({
    authorized: true,
    catalogFor: (_query, cursor) => {
      if (cursor === "page-2") return { status: "fresh", versions: secondPage, next_cursor: "page-3" };
      if (cursor === "page-3") return { status: "fresh", versions: [{ version: "1.0.0" }] };
      return { status: "fresh", versions: firstPage, next_cursor: "page-2" };
    },
  });
  await settled();
  assert.equal(f.get("runtime-update-version").value, "3.0.0");
  await f.get("runtime-version-more").fire("click");
  await settled();
  await f.get("runtime-version-more").fire("click");
  await settled();

  assert.equal(f.get("runtime-version-list").children.length, 100);
  assert.doesNotMatch(f.text("runtime-version-list"), /Pi 3\.0\.0 /);
  assert.match(f.text("runtime-version-list"), /Pi 1\.0\.0 /);
  assert.equal(f.get("runtime-update-version").value, "3.0.0");
  assert.match(f.text("runtime-version-selected"), /3\.0\.0/);

  const thirdPageOption = f.get("runtime-version-list").children.find((child) => /Pi 1\.0\.0 /.test(child.textContent));
  assert.ok(thirdPageOption);
  await thirdPageOption.fire("click");
  assert.equal(f.get("runtime-update-version").value, "1.0.0");
});

test("stale and unavailable catalog states remain distinct from Gate policy", async () => {
  const stale = fixture({
    authorized: true,
    policy: "auto",
    catalog: { status: "stale", checked_at: 1792630800000, versions: [{ version: "1.4.0" }] },
  });
  await settled();
  assert.match(stale.text("runtime-version-catalog-status"), /陈旧|缓存/);
  assert.match(stale.text("runtime-version-selected"), /已发布.*未验证/);
  assert.doesNotMatch(stale.text("runtime-update-status"), /策略已禁用/);

  const unavailable = fixture({
    authorized: true,
    policy: "auto",
    catalog: { status: "unavailable", versions: [] },
  });
  await settled();
  assert.match(unavailable.text("runtime-version-catalog-status"), /目录.*不可用|发布版本.*不可用/);
  assert.match(unavailable.text("runtime-version-catalog-status"), /不同|区别/);
  assert.doesNotMatch(unavailable.text("runtime-update-status"), /策略已禁用/);
  assert.equal(unavailable.get("runtime-update-submit").disabled, true);
});

test("known readiness blockers disable submission before confirmation", async () => {
  const blockedRun = "8".repeat(32);
  const f = fixture({
    readiness: {
      status: "blocked",
      installed_version: "1.3.0",
      consumers: [{ run_id: blockedRun, ready: false, reason: "legacy_supervisor" }],
    },
  });
  await settled();
  await f.unlock();
  assert.equal(f.get("runtime-update-submit").disabled, true);
  assert.match(f.text("runtime-readiness"), new RegExp(blockedRun));
  await f.submit("1.3.0");
  assert.equal(f.confirmations.length, 0);
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    0,
  );
});

test("unavailable readiness disables submission until Gate can report trusted consumers", async () => {
  const f = fixture({ readiness: { status: "unavailable", consumers: [] } });
  await settled();
  await f.unlock();
  assert.equal(f.get("runtime-update-submit").disabled, true);
  assert.match(f.text("runtime-readiness"), /就绪状态不可用/);
});

test("a trusted busy consumer remains submission-eligible and waits for idle without becoming a blocker", async () => {
  const busyRun = "7".repeat(32);
  const f = fixture({
    readiness: {
      status: "ready",
      installed_version: "1.3.0",
      consumers: [{ run_id: busyRun, version: "1.3.0", ready: true, reason: "busy_waits_for_idle" }],
    },
  });
  await settled();
  await f.unlock();
  assert.equal(f.get("runtime-update-submit").disabled, false);
  assert.match(f.text("runtime-readiness"), /正在生成.*允许提交.*等待空闲/);
  f.setConfirm(false);
  await f.submit("1.3.0");
  assert.doesNotMatch(f.confirmations[0], new RegExp(busyRun));
});

for (const newerStatus of ["blocked", "unavailable"] as const) {
  test(`an older ready response cannot overwrite newer ${newerStatus} readiness`, async () => {
    const f = fixture({ authorized: true });
    await settled();
    f.setReadiness({ status: "ready", installed_version: "1.3.0", consumers: [] });
    const held = f.holdNextResponse("/runtime-readiness");
    const oldPoll = f.intervals[0]();
    await held.captured;

    f.setReadiness({
      status: newerStatus,
      installed_version: "1.3.0",
      consumers:
        newerStatus === "blocked"
          ? [{ run_id: "6".repeat(32), version: "1.1.0", ready: false, reason: "legacy_supervisor" }]
          : [],
    });
    await f.get("runtime-version-refresh").fire("click");
    assert.equal(f.get("runtime-update-submit").disabled, true);

    held.release();
    await oldPoll;
    assert.equal(f.get("runtime-update-submit").disabled, true);
    assert.match(
      f.text("runtime-readiness"),
      newerStatus === "blocked" ? /存在阻止项|阻止 \/ 未就绪/ : /就绪状态不可用/,
    );
  });
}

test("an older failed readiness request cannot erase a newer ready result", async () => {
  const currentRun = "5".repeat(32);
  const f = fixture({ authorized: true });
  await settled();
  const held = f.holdNextResponse("/runtime-readiness", 503);
  const oldPoll = f.intervals[0]();
  await held.captured;

  f.setReadiness({
    status: "ready",
    installed_version: "1.3.0",
    consumers: [{ run_id: currentRun, version: "1.3.0", ready: true, reason: "busy_waits_for_idle" }],
  });
  await f.get("runtime-version-refresh").fire("click");
  assert.equal(f.get("runtime-update-submit").disabled, false);
  assert.match(f.text("runtime-readiness"), new RegExp(currentRun));

  held.release();
  await oldPoll;
  assert.equal(f.get("runtime-update-submit").disabled, false);
  assert.match(f.text("runtime-readiness"), new RegExp(currentRun));
  assert.doesNotMatch(f.text("runtime-readiness"), /就绪状态不可用/);
});

test("gateway mode automatically uses the verified web login without pairing and respects explicit logout", async () => {
  const f = fixture({ gateway: true, cookieJar: true, restartAvailable: false });
  await settled();
  assert.equal(f.get("management-unlock").hidden, true);
  assert.equal(f.get("runtime-update-submit").disabled, false);
  assert.match(f.text("management-help"), /网页登录/);
  assert.equal(f.calls.filter((c) => c.route.endsWith("/gateway")).length, 1);
  assert.equal(
    f.calls.some((c) => c.route.endsWith("/unlock")),
    false,
  );
  await f.submit("1.3.0");
  assert.equal(f.calls.filter((c) => c.route.endsWith("/runtime-updates") && c.options.method === "POST").length, 1);
  await f.get("management-logout").fire("click");
  await f.intervals[0]();
  assert.equal(f.get("runtime-update-submit").disabled, true);
  assert.equal(f.get("management-gateway").hidden, false);
  assert.equal(f.calls.filter((c) => c.route.endsWith("/gateway")).length, 1);
  await f.get("management-gateway").fire("click");
  await settled();
  assert.match(f.text("management-status"), /已解锁/);
  assert.equal(
    f.get("runtime-update-submit").disabled,
    true,
    "the original pending update must still prevent duplicate submission",
  );
  assert.equal(f.calls.filter((c) => c.route.endsWith("/gateway")).length, 2);
  assert.equal(f.calls.filter((c) => c.route.endsWith("/runtime-updates") && c.options.method === "POST").length, 1);
});

test("gateway re-entry cannot overlap logout or automatically replay an expired update submission", async () => {
  const f = fixture({ gateway: true, cookieJar: true });
  await settled();
  const held = f.holdNextResponse("/logout", undefined, "POST");
  const loggingOut = f.get("management-logout").fire("click");
  await held.captured;
  await f.get("management-gateway").fire("click");
  assert.equal(f.calls.filter((c) => c.route.endsWith("/gateway")).length, 1);
  held.release();
  await loggingOut;
  await f.get("management-gateway").fire("click");
  await settled();
  f.setPostResult(401, {});
  await f.submit("1.3.0");
  assert.equal(f.get("runtime-update-submit").disabled, true);
  assert.equal(f.get("management-unlock").hidden, true);
  assert.equal(f.get("management-gateway").hidden, false);
  await f.intervals[0]();
  assert.equal(f.calls.filter((c) => c.route.endsWith("/gateway")).length, 2);
  assert.equal(f.calls.filter((c) => c.route.endsWith("/runtime-updates") && c.options.method === "POST").length, 1);
});

test("runtime update controls stay disabled while locked or unconfigured, and runtime-only management does not enable restart", async () => {
  const unconfigured = fixture({ runtimeUpdatesAvailable: false, restartAvailable: true });
  await settled();
  assert.equal(unconfigured.get("runtime-update-submit").disabled, true);
  assert.match(unconfigured.text("runtime-update-status"), /未配置/);
  assert.equal(
    unconfigured.calls.some((call) => call.route.endsWith("/runtime-updates")),
    false,
  );

  const locked = fixture({ runtimeUpdatesAvailable: true, restartAvailable: false });
  await settled();
  assert.equal(locked.get("runtime-update-submit").disabled, true);
  assert.match(locked.text("runtime-update-status"), /解锁/);
  const card = new Element();
  assert.ok(locked.window.piHubManagement);
  locked.window.piHubManagement.attach(card, {
    generation: "1".repeat(32),
    label: "Project A",
    sessionName: "Saved work",
    path: `/s/${"1".repeat(32)}/`,
  });
  assert.equal(card.children[0].disabled, true);
});

for (const status of [200, 401]) {
  test(`a delayed ${status} from the old authorization cannot affect a newly paired management session`, async () => {
    const f = fixture({ authorized: true, jobs: [] });
    await settled();
    const oldJob = job({ id: "a".repeat(32), status: "recovery_required", stage: "refresh_requires_inspection" });
    f.setJobs([oldJob]);
    const held = f.holdNextResponse("/runtime-updates", status);
    const oldPoll = f.intervals[0]();
    await held.captured;
    await f.get("management-logout").fire("click");
    const newJob = job({ id: "b".repeat(32), status: "succeeded", stage: "complete" });
    f.setJobs([newJob]);
    await f.unlock();
    const beforeRelease = f.text("runtime-update-results");
    held.release();
    await oldPoll;
    assert.match(beforeRelease, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.doesNotMatch(beforeRelease, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(f.text("management-status"), /已解锁/);
    assert.match(f.text("runtime-update-results"), /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.doesNotMatch(f.text("runtime-update-results"), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.equal(f.get("runtime-update-submit").disabled, false);
  });
}

test("logout and re-pair during a submission retains its original identity without another POST", async () => {
  const f = fixture({ authorized: true });
  await settled();
  const held = f.holdNextResponse("/runtime-updates", undefined, "POST");
  const submitting = f.submit("1.3.0");
  await held.captured;
  await f.get("management-logout").fire("click");
  await f.unlock();
  held.release();
  await submitting;
  assert.match(f.text("management-status"), /已解锁/);
  assert.match(f.text("runtime-update-results"), new RegExp(taskId));
  assert.deepEqual(storedJson(f.storage, "pi-hub-runtime-update"), { id: taskId, version: "1.3.0" });
  assert.equal(
    f.calls.filter((call) => call.route.endsWith("/runtime-updates") && call.options.method === "POST").length,
    1,
  );
});

test("pairing cannot overlap a pending logout whose late Set-Cookie would erase the new session", async () => {
  const f = fixture({ authorized: true, cookieJar: true });
  await settled();
  const held = f.holdNextResponse("/logout", undefined, "POST");
  const loggingOut = f.get("management-logout").fire("click");
  await held.captured;
  const submitDisabledDuringLogout = f.get("runtime-update-submit").disabled;
  await f.intervals[0](); // Old cookie is already revoked server-side; poll returns401.
  const disabledDuringLogout = f.get("management-code").disabled && f.get("management-unlock").hidden;
  await f.unlock(); // Also simulate an attempted form submission while disabled.
  const overlapping = f.calls.filter((call) => call.route.endsWith("/unlock")).length;
  held.release();
  await loggingOut;
  assert.equal(disabledDuringLogout, true);
  assert.equal(submitDisabledDuringLogout, true);
  assert.equal(overlapping, 0);
  await f.unlock();
  await f.intervals[0]();
  assert.match(f.text("management-status"), /已解锁/);
  assert.equal(f.get("runtime-update-submit").disabled, false);
});

test("only an exact stable version reaches confirmation, and cancellation never submits", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  for (const invalid of ["latest", "^1.3.0", "1.3", "1.3.0-beta.1", "1.3.0+local"]) await f.submit(invalid);
  assert.equal(f.confirmations.length, 0);
  assert.match(f.text("management-notice"), /稳定版本|1\.3\.0/);
  f.setConfirm(false);
  await f.submit("1.3.0");
  assert.match(f.confirmations[0], /1\.3\.0/);
  assert.match(f.confirmations[0], /所有共享运行时使用者|全部共享运行时使用者/);
  assert.match(f.confirmations[0], /忙碌.*等待|空闲/);
  assert.match(f.confirmations[0], /旧镜像.*迁移/);
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    0,
  );
});

test("manual policy submission stores the public task identity before POST and renders pending approval separately", async () => {
  const f = fixture({ policy: "manual" });
  await settled();
  await f.unlock();
  await f.submit("1.3.0");
  const post = f.calls.find((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates"));
  assert.ok(post, "an exact version should submit one runtime-update task");
  assert.equal(post.options.headers["X-Pi-Hub-Csrf"], "csrf-value");
  if (post.options.body === undefined) throw new Error("runtime update POST body missing");
  assert.deepEqual(JSON.parse(post.options.body), { version: "1.3.0", idempotencyKey: taskId });
  const savedBeforePost = f.storedBeforePost();
  if (savedBeforePost === null) throw new Error("runtime update identity was not stored before POST");
  assert.deepEqual(JSON.parse(savedBeforePost), { id: taskId, version: "1.3.0" });
  assert.match(f.text("runtime-update-policy"), /手动|manual/i);
  assert.match(f.text("runtime-update-results"), new RegExp(taskId));
  assert.match(f.text("runtime-update-results"), /1\.3\.0/);
  assert.match(f.text("runtime-update-results"), /等待.*审批|runtime-approve/);
  assert.doesNotMatch(f.text("runtime-update-results"), /安装成功/);
  assert.equal(f.get("runtime-update-submit").disabled, true);
});

test("submission aborts before POST when the stable task identity cannot be persisted", async () => {
  const f = fixture({ storageThrows: true });
  await settled();
  await f.unlock();
  await f.submit("1.3.0");
  assert.equal(
    f.calls.some((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")),
    false,
  );
  assert.equal(f.storage.has("pi-hub-runtime-update"), false);
  assert.match(f.text("management-notice"), /未提交|保存.*任务编号|会话存储/);
  assert.equal(f.get("runtime-update-submit").disabled, false);
  assert.equal(f.text("runtime-update-results").trim(), "");
});

test("a lost POST response queries the preserved task id, treats 404 as uncertain, and never posts again", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setPostFailure();
  f.setDetail(404);
  await f.submit("1.3.0");
  for (const poll of f.intervals) await poll();
  await settled();
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    1,
  );
  assert.equal(
    f.calls.some((call) => call.route.endsWith(`/runtime-updates/${taskId}`)),
    true,
  );
  assert.deepEqual(storedJson(f.storage, "pi-hub-runtime-update"), { id: taskId, version: "1.3.0" });
  assert.match(f.text("runtime-update-results"), /结果不确定|尚未找到/);
  assert.match(f.text("runtime-update-results"), new RegExp(taskId));
  const query = f.get("runtime-update-query");
  assert.equal(query.hidden, false);
  await query.fire("click");
  await settled();
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    1,
  );
  assert.ok(f.calls.filter((call) => call.route.endsWith(`/runtime-updates/${taskId}`)).length >= 2);
  assert.equal(f.get("runtime-update-submit").disabled, true);
});

test("HTTP 400 is an explicit rejection that clears the pending identity and allows a corrected submission", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setPostResult(400, { error: "not-audited" });
  await f.submit("1.3.0");
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    1,
  );
  assert.equal(
    f.calls.some((call) => call.route.endsWith(`/runtime-updates/${taskId}`)),
    false,
  );
  assert.equal(f.storage.has("pi-hub-runtime-update"), false);
  const notice = f.text("management-notice");
  assert.doesNotMatch(notice, /已审计|固定.*列表/);
  assert.match(notice, /精确稳定版本.*无效|请求参数被拒绝/);
  assert.match(notice, /官方发布目录.*重新选择/);
  assert.equal(f.get("runtime-update-submit").disabled, false);
});

test("a malformed accepted response remains ambiguous and is queried by the original id without another POST", async () => {
  const f = fixture();
  await settled();
  await f.unlock();
  f.setPostResult(202, { id: taskId, version: "1.3.0" });
  f.setDetail(404);
  await f.submit("1.3.0");
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")).length,
    1,
  );
  assert.equal(
    f.calls.some((call) => call.route.endsWith(`/runtime-updates/${taskId}`)),
    true,
  );
  assert.deepEqual(storedJson(f.storage, "pi-hub-runtime-update"), { id: taskId, version: "1.3.0" });
  assert.match(f.text("runtime-update-results"), /结果不确定|尚未找到/);
  assert.equal(f.get("runtime-update-query").hidden, false);
  assert.equal(f.get("runtime-update-submit").disabled, true);
});

test("running task progress distinguishes idle deferral, refresh, exit, and unavailable consumers", async () => {
  const active = job({
    status: "running",
    stage: "waiting_for_idle",
    targets: [
      {
        run_id: "1".repeat(32),
        status: "waiting_for_idle",
        old_version: "1.2.0",
        wait_reason: "consumer_not_ready",
      },
      {
        run_id: "2".repeat(32),
        status: "refreshing",
        old_version: "1.2.1",
        version: "1.3.0",
      },
      { run_id: "3".repeat(32), status: "succeeded", old_version: "1.2.2", version: "1.3.0" },
      { run_id: "4".repeat(32), status: "exited", old_version: "1.2.3" },
      { run_id: "6".repeat(32), status: "waiting_for_idle", wait_reason: "awaiting_state_change" },
    ],
  });
  const unavailable = job({
    id: "5".repeat(32),
    status: "running",
    stage: "unmanaged_or_unavailable_consumer",
    targets: [],
  });
  const f = fixture({ authorized: true, policy: "auto", jobs: [active, unavailable], active: [active, unavailable] });
  await settled();
  const rendered = f.text("runtime-update-results");
  assert.match(rendered, /任务进行中/);
  assert.doesNotMatch(rendered, /Pi 1\.3\.0 · 正在安装/);
  assert.match(rendered, /等待.*空闲/);
  assert.match(rendered, /共享运行时使用者.*未就绪/);
  assert.match(rendered, /正在刷新.*Pi/);
  assert.match(rendered, /等待.*状态变化/);
  assert.match(rendered, /已加载新版本/);
  assert.match(rendered, /已退出/);
  assert.match(rendered, /1\.2\.0/);
  assert.match(rendered, /未受管.*不可用|不可用.*未受管/);
  assert.equal(f.get("runtime-update-submit").disabled, true);
});

test("all actual Gate stages have specific operator-facing descriptions", async () => {
  const stages = [
    ["awaiting_approval", "等待宿主机审批"],
    ["queued_by_policy", "按策略排队"],
    ["approved_by_host", "宿主机已批准"],
    ["policy_changed", "策略已变更"],
    ["resolving", "解析已发布候选版本"],
    ["validating", "隔离验证"],
    ["preparing", "准备安装"],
    ["prepared", "安装准备完成"],
    ["activating", "激活新版本"],
    ["refreshing", "刷新受管 Pi 进程"],
    ["waiting_for_idle", "等待忙碌目标空闲"],
    ["waiting_for_consumer_readiness", "等待共享运行时使用者就绪"],
    ["unmanaged_or_unavailable_consumer", "未受管或不可用"],
    ["install_failed", "安装失败"],
    ["installation_outcome_unknown", "安装结果不确定"],
    ["refresh_requires_inspection", "刷新结果需要管理员检查"],
    ["restore_pre_stop_failed", "会话恢复验证未通过；原进程未停止"],
    ["incompatible_candidate", "候选版本不兼容"],
    ["incompatible_session", "当前会话不兼容"],
    ["candidate_changed", "候选包内容已变化"],
    ["protocol_unavailable", "刷新协议不可用"],
    ["complete", "任务已完成"],
  ] as const;
  const jobs = stages.map(([stage], index) =>
    job({
      id: index.toString(16).padStart(32, "0"),
      status: stage === "complete" ? "succeeded" : stage.includes("unknown") ? "recovery_required" : "running",
      stage,
    }),
  );
  const f = fixture({ authorized: true, policy: "auto", jobs });
  await settled();
  const rendered = f.text("runtime-update-results");
  for (const [, expected] of stages) assert.match(rendered, new RegExp(expected));
});

test("source revalidation and pre-stop restoration refusal remain explicit target states", async () => {
  const f = fixture({
    authorized: true,
    jobs: [
      job({
        status: "running",
        stage: "refreshing",
        targets: [
          { run_id: "a".repeat(32), status: "validating_source", wait_reason: "target_source_validation" },
          { run_id: "b".repeat(32), status: "blocked", wait_reason: "restore_pre_stop_failed" },
        ],
      }),
    ],
  });
  await settled();
  const rendered = f.text("runtime-update-results");
  assert.match(rendered, /正在核验新进程.*实际运行内容的兼容性验证/);
  assert.match(rendered, /已阻止刷新.*会话恢复验证未通过；原进程未停止/);
});

test("large cumulative target histories prioritize active records and visibly cap rendering at 128", async () => {
  const exited = Array.from({ length: 129 }, (_, index) => ({
    run_id: index.toString(16).padStart(32, "0"),
    status: "exited",
  }));
  const waiting = {
    run_id: "f".repeat(32),
    status: "waiting_for_idle",
    wait_reason: "busy_race",
  };
  const active = job({
    status: "running",
    stage: "waiting_for_idle",
    targets: [...exited, waiting],
  });
  const f = fixture({ authorized: true, jobs: [active], active: [active] });
  await settled();
  const row = f.get("runtime-update-results").children[0];
  const renderedTargets = row.children.filter((child) => child.className === "runtime-update-target");
  assert.equal(renderedTargets.length, 128);
  assert.match(nodeText(row), /Pi 1\.3\.0 · 任务进行中/);
  assert.match(nodeText(row), /阶段：等待忙碌目标空闲/);
  assert.match(nodeText(row), /共130个目标记录，仅显示前128条/);
  assert.match(nodeText(renderedTargets[0]), new RegExp(waiting.run_id));
  assert.match(nodeText(renderedTargets[0]), /等待目标空闲.*空闲确认期间再次忙碌/);
  assert.doesNotMatch(nodeText(row), new RegExp((127).toString(16).padStart(32, "0")));
  assert.doesNotMatch(nodeText(row), new RegExp((128).toString(16).padStart(32, "0")));
});

test("job and target success are distinct from an uncertain recovery-required outcome", async () => {
  const succeeded = job({
    id: "a".repeat(32),
    status: "succeeded",
    stage: "complete",
    resolved: true,
    targets: [
      {
        run_id: "1".repeat(32),
        status: "succeeded",
        old_version: "1.2.0",
        version: "1.3.0",
        wait_reason: "busy_race",
      },
      { run_id: "2".repeat(32), status: "exited", old_version: "1.2.0" },
    ],
  });
  const recovery = job({
    id: "b".repeat(32),
    status: "recovery_required",
    stage: "installation_outcome_unknown",
    resolved: true,
  });
  const f = fixture({ authorized: true, jobs: [succeeded, recovery] });
  await settled();
  const rows = f.get("runtime-update-results").children;
  assert.equal(rows.length, 2);
  assert.match(nodeText(rows[0]), /安装成功.*所有受管 Pi 进程.*刷新或退出/);
  assert.match(nodeText(rows[0]), /已加载新版本/);
  assert.match(nodeText(rows[0]), /已退出/);
  assert.doesNotMatch(nodeText(rows[0]), /空闲确认期间再次忙碌/);
  assert.doesNotMatch(nodeText(rows[0]), /结果不确定|管理员检查/);
  assert.match(nodeText(rows[1]), /结果不确定.*管理员检查/);
  assert.doesNotMatch(nodeText(rows[1]), /自动回滚|恢复未完成|安装成功/);
});

test("unresolved recovery-required remains active and blocks new submissions until the backend reports resolution", async () => {
  const unresolved = job({
    id: "b".repeat(32),
    status: "recovery_required",
    stage: "refresh_requires_inspection",
    resolved: false,
  });
  const blocked = fixture({ authorized: true, jobs: [unresolved], active: [unresolved] });
  await settled();
  assert.equal(blocked.get("runtime-update-submit").disabled, true);
  assert.match(blocked.text("runtime-update-results"), /尚未解决|阻止.*新.*任务|管理员.*解决/);
  assert.match(blocked.text("runtime-update-results"), /不会自动解决/);

  const resolved = { ...unresolved, resolved: true };
  const allowed = fixture({ authorized: true, jobs: [resolved], active: [] });
  await settled();
  assert.equal(allowed.get("runtime-update-submit").disabled, false);
});

test("a stored pending lookup resumes by id without POST and logout removes protected runtime results from the DOM", async () => {
  const resumed = job({ id: savedTaskId, version: "1.4.0", status: "queued", stage: "queued" });
  const f = fixture({ stored: { id: savedTaskId, version: "1.4.0" } });
  f.setDetail(200, resumed);
  await settled();
  assert.equal(f.text("runtime-update-results").trim(), "");
  await f.unlock();
  assert.equal(
    f.calls.some((call) => call.route.endsWith(`/runtime-updates/${savedTaskId}`)),
    true,
  );
  assert.equal(
    f.calls.some((call) => call.options.method === "POST" && call.route.endsWith("/runtime-updates")),
    false,
  );
  assert.match(f.text("runtime-update-results"), new RegExp(savedTaskId));
  assert.match(f.text("runtime-update-results"), /1\.4\.0/);
  assert.deepEqual(storedJson(f.storage, "pi-hub-runtime-update"), { id: savedTaskId, version: "1.4.0" });
  await f.get("management-logout").fire("click");
  await settled();
  assert.equal(f.text("runtime-update-results").trim(), "");
  assert.equal(f.text("management-results").trim(), "");
});
