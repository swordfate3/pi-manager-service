import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { type HubConfig, readPrivateJson } from "./config.ts";
import { type LifecycleConfig, lifecycleConfig } from "./lifecycle.ts";
import type { HubManagement } from "./management.ts";
import { attachLaunchSessions, launchRequest, launchResponse, workspaceQuery } from "./pi-launches.ts";

type RecordValue = Record<string, unknown>;
export type GateTask = {
  kind: string;
  id: string;
  revision: string;
  status: string;
  stage: string;
  title: string;
  target: string;
  actions: string[];
  version?: string;
  commit?: string;
  image?: string;
  plan_hash?: string;
  created_at?: number;
  details?: RecordValue;
};
export type GatePolicy = {
  kind: string;
  id: string;
  revision: string;
  mode: string;
  paused?: boolean;
  images?: string[];
};
const kinds = ["deployment", "runtime", "restart", "intent"];
const policyKinds = ["service", "runtime", "restart"];
const actions = ["approve", "reject", "rollback"];
const modes = ["manual", "auto", "disabled"];
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const service = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const exact = (value: RecordValue, fields: string[]) =>
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");

export class GateManagementError extends Error {
  readonly status: number;
  constructor(status = 503) {
    super("Gate management unavailable or outcome unknown");
    this.status = status;
  }
}

function details(value: unknown, depth = 0): unknown {
  if (depth > 4) throw new GateManagementError();
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return value;
  if (typeof value === "string" && value.length <= 2000 && !/[\p{Cc}\p{Cs}]/u.test(value)) return value;
  if (Array.isArray(value) && value.length <= 128) return value.map((item) => details(item, depth + 1));
  if (object(value) && Object.keys(value).length <= 64) {
    const safe: RecordValue = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ||
        /token|password|secret|authorization|credential|environment|mount|template|private/i.test(key)
      )
        throw new GateManagementError();
      safe[key] = details(item, depth + 1);
    }
    return safe;
  }
  throw new GateManagementError();
}

function task(value: unknown): GateTask {
  if (
    !object(value) ||
    !kinds.includes(String(value.kind)) ||
    !hex(value.id, 32) ||
    !hex(value.revision, 64) ||
    !label(value.status, 64) ||
    !label(value.stage, 128) ||
    !label(value.title) ||
    !label(value.target) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 3 ||
    value.actions.some((v) => !actions.includes(String(v)))
  )
    throw new GateManagementError();
  const result: GateTask = {
    kind: String(value.kind),
    id: value.id,
    revision: value.revision,
    status: value.status,
    stage: value.stage,
    title: value.title,
    target: value.target,
    actions: value.actions as string[],
  };
  for (const key of ["version", "commit", "image", "plan_hash"] as const) {
    if (value[key] !== undefined) {
      if (!label(value[key], key === "image" ? 512 : 256)) throw new GateManagementError();
      result[key] = value[key];
    }
  }
  if (value.created_at !== undefined) {
    if (!Number.isSafeInteger(value.created_at) || Number(value.created_at) < 0) throw new GateManagementError();
    result.created_at = Number(value.created_at);
  }
  if (value.details !== undefined) {
    if (!object(value.details) || JSON.stringify(value.details).length > 16384) throw new GateManagementError();
    result.details = details(value.details) as RecordValue;
  }
  return result;
}

function policy(value: unknown): GatePolicy {
  if (
    !object(value) ||
    !policyKinds.includes(String(value.kind)) ||
    !service(value.id) ||
    !hex(value.revision, 64) ||
    !modes.includes(String(value.mode))
  )
    throw new GateManagementError();
  const result: GatePolicy = {
    kind: String(value.kind),
    id: value.id,
    revision: value.revision,
    mode: String(value.mode),
  };
  if (value.paused !== undefined) {
    if (typeof value.paused !== "boolean") throw new GateManagementError();
    result.paused = value.paused;
  }
  if (value.images !== undefined) {
    if (
      !Array.isArray(value.images) ||
      value.images.length > 64 ||
      value.images.some((v) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v))
    )
      throw new GateManagementError();
    result.images = value.images as string[];
  }
  return result;
}

function receipt(value: unknown) {
  if (!object(value) || !hex(value.decision_id, 32) || !["recorded", "delivery_unknown"].includes(String(value.status)))
    throw new GateManagementError();
  return {
    decision_id: value.decision_id,
    status: value.status,
    ...(value.task !== undefined ? { task: task(value.task) } : {}),
    ...(value.policy !== undefined ? { policy: policy(value.policy) } : {}),
  };
}

/** The only forwarding capability is the fixed restricted management protocol. */
export class GateManagementProvider {
  private readonly config: LifecycleConfig;
  constructor(config: LifecycleConfig) {
    this.config = lifecycleConfig(config);
  }
  async request(method: "GET" | "POST", suffix: string, value?: RecordValue): Promise<unknown> {
    let credential: unknown;
    try {
      credential = readPrivateJson(this.config.credentialFile);
    } catch {
      throw new GateManagementError();
    }
    if (!object(credential) || !exact(credential, ["token"]) || !hex(credential.token, 64))
      throw new GateManagementError();
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const data = await new Promise<unknown>((resolve, reject) => {
      let done = false;
      const finish = (error?: GateManagementError, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const request = http.request(
        new URL(`/v1/hub-management${suffix}`, this.config.endpoint),
        {
          method,
          agent: false,
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (response) => {
          const code = response.statusCode ?? 503;
          if (code < 200 || code >= 300) {
            finish(new GateManagementError([400, 404, 409].includes(code) ? code : 503));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              finish(new GateManagementError());
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (done) return;
            try {
              finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              finish(new GateManagementError());
            }
          });
          response.on("error", () => finish(new GateManagementError()));
          response.on("aborted", () => finish(new GateManagementError()));
        },
      );
      const timer = setTimeout(() => finish(new GateManagementError()), 5000);
      request.on("error", () => finish(new GateManagementError()));
      request.end(payload);
    });
    if (
      suffix === "/launch-config" ||
      suffix.startsWith("/workspaces?") ||
      suffix === "/launches" ||
      suffix.startsWith("/launches/")
    ) {
      try {
        const safe = launchResponse(suffix, data, method);
        if (value && (safe as RecordValue).id !== value.id) throw new Error();
        return safe;
      } catch {
        throw new GateManagementError();
      }
    }
    if (suffix === "") {
      if (
        !object(data) ||
        !Array.isArray(data.tasks) ||
        data.tasks.length > 512 ||
        !Array.isArray(data.policies) ||
        data.policies.length > 128
      )
        throw new GateManagementError();
      return { tasks: data.tasks.map(task), policies: data.policies.map(policy) };
    }
    if (suffix.startsWith("/tasks/")) {
      const safe = task(data);
      if (suffix !== `/tasks/${safe.kind}/${safe.id}`) throw new GateManagementError();
      return safe;
    }
    const safe = receipt(data);
    const expected = value?.decision_id ?? suffix.split("/").at(-1);
    if (safe.decision_id !== expected) throw new GateManagementError();
    return safe;
  }
}

async function body(request: IncomingMessage): Promise<RecordValue> {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
    request.headers["transfer-encoding"]
  )
    throw new Error("Invalid JSON body");
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", failed);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(parts));
    };
    const data = (part: Buffer) => {
      size += part.length;
      if (size > 4096) finish(new Error());
      else parts.push(part);
    };
    const end = () => finish();
    const failed = () => finish(new Error());
    const timer = setTimeout(failed, 5000);
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", failed);
  });
  const value = JSON.parse(raw.toString("utf8"));
  if (!object(value)) throw new Error();
  return value;
}

export function createGateManagementApi(
  config: HubConfig,
  management: HubManagement,
  resolveSession: (id: string) => string | undefined = () => undefined,
) {
  const provider = config.gateManagement ? new GateManagementProvider(config.gateManagement) : undefined;
  const prefix = "/api/management/gate";
  return {
    async handle(request: IncomingMessage, response: ServerResponse, sameOrigin: boolean): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://hub.invalid");
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
      const reply = (status: number, value: unknown) =>
        response
          .writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          })
          .end(JSON.stringify(value));
      let suffix = url.pathname.slice(prefix.length);
      const launchRead =
        suffix === "/launch-config" ||
        suffix === "/workspaces" ||
        suffix === "/launches" ||
        /^\/launches\/[a-f0-9]{32}$/.test(suffix);
      const read =
        launchRead ||
        suffix === "" ||
        /^\/tasks\/(deployment|runtime|restart|intent)\/[a-f0-9]{32}$/.test(suffix) ||
        /^\/decisions\/[a-f0-9]{32}$/.test(suffix);
      const write = ["/decisions", "/policies", "/resume", "/launches"].includes(suffix);
      if ((url.search && suffix !== "/workspaces") || (!read && !write)) {
        reply(404, { error: "Management route not found" });
        return true;
      }
      if ((request.method !== "GET" || !read) && (request.method !== "POST" || !write)) {
        reply(405, { error: "Method not allowed" });
        return true;
      }
      if (request.method === "POST" && !sameOrigin) {
        reply(403, { error: "Same-origin management request required" });
        return true;
      }
      let phase: "authorization" | "body" | "provider" = "authorization";
      try {
        const auth = management.authorize(request, request.method === "POST");
        const revalidate = () => {
          phase = "authorization";
          management.revalidate(request, auth, request.method === "POST");
          phase = "provider";
        };
        if (!provider) {
          reply(503, { error: "Hub approvals are not configured" });
          return true;
        }
        if (suffix === "/workspaces") {
          phase = "body";
          suffix += workspaceQuery(url.searchParams);
        }
        let value: RecordValue | undefined;
        if (request.method === "POST") {
          phase = "body";
          value = await body(request);
          revalidate();
          phase = "body";
          if (suffix === "/launches") {
            launchRequest(value);
          } else {
            if (!hex(value.decision_id, 32) || !hex(value.revision, 64)) throw new Error();
            if (suffix === "/decisions") {
              if (
                !exact(value, ["kind", "id", "revision", "action", "decision_id"]) ||
                !kinds.includes(String(value.kind)) ||
                !hex(value.id, 32) ||
                !actions.includes(String(value.action))
              )
                throw new Error();
            } else if (suffix === "/policies") {
              if (
                !exact(value, ["kind", "id", "revision", "mode", "decision_id"]) ||
                !policyKinds.includes(String(value.kind)) ||
                !service(value.id) ||
                !modes.includes(String(value.mode))
              )
                throw new Error();
            } else if (!exact(value, ["id", "revision", "decision_id"]) || !service(value.id)) throw new Error();
          }
        }
        revalidate();
        let result: unknown;
        try {
          result = await provider.request(request.method as "GET" | "POST", suffix, value);
        } catch (error) {
          revalidate();
          throw error;
        }
        revalidate();
        reply(200, launchRead ? attachLaunchSessions(result, resolveSession) : result);
      } catch (error) {
        const status =
          phase === "authorization"
            ? 401
            : phase === "body"
              ? 400
              : error instanceof GateManagementError
                ? error.status
                : 503;
        reply(status, {
          error:
            status === 401
              ? "Management login expired"
              : status === 400
                ? "Exact bounded management request required"
                : status === 409
                  ? "Task or policy changed; review current state"
                  : status === 404
                    ? "Original task or receipt not found"
                    : "Gate unavailable or outcome unknown; query the original decision before retrying",
        });
      }
      return true;
    },
  };
}
