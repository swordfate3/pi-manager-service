/** Public launch projections only. Private Docker profiles never cross this boundary. */
export type LaunchJob = {
  id: string;
  path: string;
  label: string;
  status: string;
  stage: string;
  created_at: number;
  updated_at: number;
  run_id?: string;
  sessionUrl?: string;
};
const hex = (v: unknown, n: number): v is string => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, limit: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= limit && !/[\p{Cc}\p{Cs}]/u.test(v);
export const workspacePath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 1024 &&
  !/[\\\p{Cc}\p{Cs}]/u.test(v) &&
  (v === "" || v.split("/").every((part) => !!part && part !== "." && part !== ".."));
const basename = (v: unknown): v is string => text(v, 255) && v !== "." && v !== ".." && !/[\\/]/u.test(v);
export function workspaceQuery(query: URLSearchParams) {
  if (
    [...query.keys()].some((key) => !["path", "cursor"].includes(key)) ||
    query.getAll("path").length > 1 ||
    query.getAll("cursor").length > 1
  )
    throw new Error("Invalid workspace query");
  const path = query.get("path") ?? "";
  const cursor = query.get("cursor");
  if (!workspacePath(path) || (cursor !== null && !basename(cursor))) throw new Error("Invalid workspace path");
  const safe = new URLSearchParams({ path });
  if (cursor !== null) safe.set("cursor", cursor);
  return `?${safe}`;
}
export function launchRequest(value: Record<string, unknown>) {
  if (
    Object.keys(value).sort().join(",") !== "id,label,path,policy_revision,workspace_revision" ||
    !hex(value.id, 32) ||
    !hex(value.policy_revision, 64) ||
    !hex(value.workspace_revision, 64) ||
    !workspacePath(value.path) ||
    !text(value.label, 80) ||
    value.label.trim() !== value.label
  )
    throw new Error("Invalid exact launch request");
}
function job(value: unknown): LaunchJob {
  if (
    !object(value) ||
    !hex(value.id, 32) ||
    !workspacePath(value.path) ||
    !text(value.label, 80) ||
    !["queued", "starting", "running", "exited", "failed", "recovery_required"].includes(String(value.status)) ||
    typeof value.stage !== "string" ||
    !/^[a-z][a-z0-9_]{0,95}$/.test(value.stage) ||
    !Number.isSafeInteger(value.created_at) ||
    Number(value.created_at) < 0 ||
    !Number.isSafeInteger(value.updated_at) ||
    Number(value.updated_at) < 0 ||
    (value.run_id !== undefined && !hex(value.run_id, 32))
  )
    throw new Error("Invalid launch response");
  return {
    id: value.id,
    path: value.path,
    label: value.label,
    status: String(value.status),
    stage: value.stage,
    created_at: Number(value.created_at),
    updated_at: Number(value.updated_at),
    ...(value.run_id === undefined ? {} : { run_id: value.run_id as string }),
  };
}
// Match Gate/Python's Unicode code-point ordering, including non-BMP names.
function compareNames(a: string, b: string) {
  const left = Array.from(a, (char) => char.codePointAt(0) as number);
  const right = Array.from(b, (char) => char.codePointAt(0) as number);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}
export function launchResponse(suffix: string, value: unknown, method: "GET" | "POST" = "GET"): unknown {
  if (suffix === "/launch-config") {
    if (
      !object(value) ||
      typeof value.enabled !== "boolean" ||
      !text(value.rootLabel, 80) ||
      !workspacePath(value.defaultPath) ||
      !hex(value.revision, 64) ||
      !Number.isSafeInteger(value.maxActive) ||
      Number(value.maxActive) < 1 ||
      Number(value.maxActive) > 16
    )
      throw new Error("Invalid launch configuration");
    return {
      enabled: value.enabled,
      rootLabel: value.rootLabel,
      defaultPath: value.defaultPath,
      revision: value.revision,
      maxActive: value.maxActive,
    };
  }
  if (suffix.startsWith("/workspaces?")) {
    const query = new URLSearchParams(suffix.split("?")[1]);
    const selected = query.get("path") ?? "";
    const cursor = query.get("cursor");
    const expectedParent = selected === "" ? null : selected.split("/").slice(0, -1).join("/");
    if (
      !object(value) ||
      value.path !== selected ||
      value.parent !== expectedParent ||
      !hex(value.revision, 64) ||
      !Array.isArray(value.entries) ||
      value.entries.length > 200 ||
      typeof value.truncated !== "boolean" ||
      (value.nextCursor !== undefined && !basename(value.nextCursor))
    )
      throw new Error("Invalid workspace listing");
    const entries = value.entries.map((entry) => {
      if (!object(entry) || !basename(entry.name) || entry.path !== `${selected ? `${selected}/` : ""}${entry.name}`)
        throw new Error("Invalid directory child");
      return { name: entry.name, path: entry.path };
    });
    if (
      entries.some(
        (entry, index) =>
          (cursor !== null && compareNames(entry.name, cursor) <= 0) ||
          (index > 0 && compareNames(entry.name, entries[index - 1].name) <= 0),
      ) ||
      (value.truncated && (!entries.length || value.nextCursor !== entries.at(-1)?.name)) ||
      (!value.truncated && value.nextCursor !== undefined)
    )
      throw new Error("Invalid directory pagination");
    return {
      path: selected,
      parent: expectedParent,
      revision: value.revision,
      entries,
      truncated: value.truncated,
      ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    };
  }
  if (suffix === "/launches" && method === "GET") {
    if (!object(value) || !Array.isArray(value.jobs)) throw new Error("Invalid launch list");
    if (value.jobs.length > 256) throw new Error("Too many launch records");
    const jobs = value.jobs.map(job);
    if (new Set(jobs.map((row) => row.id)).size !== jobs.length) throw new Error("Duplicate launch record");
    return { jobs };
  }
  const result = job(value);
  if (suffix.startsWith("/launches/") && suffix !== `/launches/${result.id}`) throw new Error("Wrong launch identity");
  return result;
}

export function attachLaunchSessions(value: unknown, resolve: (id: string) => string | undefined): unknown {
  if (!object(value)) return value;
  if (Array.isArray(value.jobs)) return { jobs: value.jobs.map((row) => attachLaunchSessions(row, resolve)) };
  if (!hex(value.run_id, 32) || value.status !== "running") return value;
  const sessionUrl = resolve(value.run_id);
  return { ...value, ...(sessionUrl ? { sessionUrl } : {}) };
}
