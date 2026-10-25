import http from "node:http";
import { readPrivateJson } from "./config.ts";
import { type LifecycleConfig, lifecycleConfig } from "./lifecycle.ts";

export type RuntimeUpdateTarget = {
  run_id: string;
  status: string;
  old_version?: string;
  version?: string;
  wait_reason?: string;
};
export type RuntimeUpdateJob = {
  id: string;
  version: string;
  status: string;
  stage: string;
  targets: RuntimeUpdateTarget[];
  created_at?: number;
  resolved_at?: number;
  resolved?: boolean;
};
export type RuntimeVersionCatalog = {
  status: "fresh" | "stale" | "unavailable";
  checked_at?: number;
  versions: Array<{ version: string }>;
  next_cursor?: string;
};
export type RuntimeReadinessConsumer = {
  run_id: string;
  version?: string;
  ready: boolean;
  reason?: string;
};
export type RuntimeReadiness = {
  status: "ready" | "blocked" | "unavailable";
  consumers: RuntimeReadinessConsumer[];
  installed_version?: string;
};

export const runtimeVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  value.trim() === value &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
const hex = (value: unknown): value is string =>
  typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
const word = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && /^[a-z_]{1,64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const catalogQuery = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && /^[0-9.]*$/.test(value);
const catalogCursor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const states = ["pending", "queued", "running", "succeeded", "failed", "recovery_required", "rejected", "stale"];

/** A bounded error category, never the upstream response body or credential. */
export class RuntimeUpdateError extends Error {
  readonly status: number;
  constructor(status = 503) {
    super("Runtime update provider unavailable or outcome unknown");
    this.status = status;
  }
}

function job(value: unknown): RuntimeUpdateJob {
  if (
    !object(value) ||
    !hex(value.id) ||
    !runtimeVersion(value.version) ||
    !states.includes(value.status as string) ||
    !word(value.stage) ||
    !Array.isArray(value.targets)
  )
    throw new RuntimeUpdateError();
  const targets = value.targets.map((target): RuntimeUpdateTarget => {
    if (!object(target) || !hex(target.run_id) || !word(target.status)) throw new RuntimeUpdateError();
    const result: RuntimeUpdateTarget = { run_id: target.run_id, status: target.status };
    for (const key of ["old_version", "version"] as const) {
      if (target[key] !== undefined) {
        if (!runtimeVersion(target[key])) throw new RuntimeUpdateError();
        result[key] = target[key];
      }
    }
    if (target.wait_reason !== undefined) {
      if (!word(target.wait_reason)) throw new RuntimeUpdateError();
      result.wait_reason = target.wait_reason;
    }
    return result;
  });
  const result: RuntimeUpdateJob = {
    id: value.id,
    version: value.version,
    status: value.status as string,
    stage: value.stage,
    targets,
  };
  for (const key of ["created_at", "resolved_at"] as const) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) throw new RuntimeUpdateError();
      result[key] = Number(value[key]);
    }
  }
  if (value.resolved !== undefined) {
    if (typeof value.resolved !== "boolean") throw new RuntimeUpdateError();
    result.resolved = value.resolved;
  }
  return result;
}

function catalog(value: unknown): RuntimeVersionCatalog {
  if (
    !object(value) ||
    !["fresh", "stale", "unavailable"].includes(value.status as string) ||
    !Array.isArray(value.versions) ||
    value.versions.length > 50
  )
    throw new RuntimeUpdateError();
  const result: RuntimeVersionCatalog = {
    status: value.status as RuntimeVersionCatalog["status"],
    versions: value.versions.map((entry) => {
      if (!object(entry) || !runtimeVersion(entry.version)) throw new RuntimeUpdateError();
      return { version: entry.version };
    }),
  };
  if (value.checked_at !== undefined) {
    if (!Number.isSafeInteger(value.checked_at) || Number(value.checked_at) <= 0) throw new RuntimeUpdateError();
    result.checked_at = Number(value.checked_at);
  }
  if (value.next_cursor !== undefined) {
    if (!catalogCursor(value.next_cursor) || value.next_cursor.length === 0) throw new RuntimeUpdateError();
    result.next_cursor = value.next_cursor;
  }
  return result;
}

function readiness(value: unknown): RuntimeReadiness {
  if (
    !object(value) ||
    !["ready", "blocked", "unavailable"].includes(value.status as string) ||
    !Array.isArray(value.consumers) ||
    value.consumers.length > 128
  )
    throw new RuntimeUpdateError();
  const result: RuntimeReadiness = {
    status: value.status as RuntimeReadiness["status"],
    consumers: value.consumers.map((consumer): RuntimeReadinessConsumer => {
      if (!object(consumer) || !hex(consumer.run_id) || typeof consumer.ready !== "boolean")
        throw new RuntimeUpdateError();
      const projected: RuntimeReadinessConsumer = { run_id: consumer.run_id, ready: consumer.ready };
      if (consumer.version !== undefined) {
        if (!runtimeVersion(consumer.version)) throw new RuntimeUpdateError();
        projected.version = consumer.version;
      }
      if (consumer.reason !== undefined) {
        if (!word(consumer.reason)) throw new RuntimeUpdateError();
        projected.reason = consumer.reason;
      }
      return projected;
    }),
  };
  if (value.installed_version !== undefined) {
    if (!runtimeVersion(value.installed_version)) throw new RuntimeUpdateError();
    result.installed_version = value.installed_version;
  }
  return result;
}

/** Request-only Gate capability; no policy, approval, Docker or shell operations. */
export class GateRuntimeUpdates {
  private readonly config: LifecycleConfig;
  constructor(config: LifecycleConfig) {
    this.config = lifecycleConfig(config);
  }

  private request(
    method: "GET" | "POST",
    route: string,
    value?: { version: string; idempotency_key: string },
    maxBytes = 16 * 1024 * 1024,
  ): Promise<unknown> {
    let credential: unknown;
    try {
      credential = readPrivateJson(this.config.credentialFile);
    } catch {
      throw new RuntimeUpdateError();
    }
    if (
      !object(credential) ||
      Object.keys(credential).join(",") !== "token" ||
      typeof credential.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(credential.token)
    )
      throw new RuntimeUpdateError();
    const token = credential.token;
    const payload = value ? JSON.stringify(value) : undefined;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: RuntimeUpdateError, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const request = http.request(
        new URL(route, this.config.endpoint),
        {
          method,
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 503;
          if (status < 200 || status >= 300) {
            finish(new RuntimeUpdateError([400, 404, 409].includes(status) ? status : 503));
            return;
          }
          // Gate returns up to 100 full jobs. Targets include exited consumers,
          // so neither history size nor target count matches the live inventory.
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              finish(new RuntimeUpdateError());
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", () => finish(new RuntimeUpdateError()));
          response.on("aborted", () => finish(new RuntimeUpdateError()));
          response.on("end", () => {
            try {
              finish(undefined, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
            } catch {
              finish(new RuntimeUpdateError());
            }
          });
        },
      );
      const timer = setTimeout(() => finish(new RuntimeUpdateError()), 5000);
      request.on("error", () => finish(new RuntimeUpdateError()));
      request.end(payload);
    });
  }

  async status() {
    const value = await this.request("GET", "/v1/runtime-updates");
    if (
      !object(value) ||
      !object(value.policy) ||
      !["manual", "auto", "disabled"].includes(value.policy.mode as string) ||
      !Array.isArray(value.jobs) ||
      value.jobs.length > 100 ||
      !Array.isArray(value.active) ||
      value.active.length > 100
    )
      throw new RuntimeUpdateError();
    return {
      policy: { mode: value.policy.mode as "manual" | "auto" | "disabled" },
      jobs: value.jobs.map(job),
      active: value.active.map(job),
    };
  }

  async catalog(options: { query?: string; cursor?: string } = {}) {
    if (
      !object(options) ||
      Object.keys(options).some((key) => key !== "query" && key !== "cursor") ||
      (options.query !== undefined && !catalogQuery(options.query)) ||
      (options.cursor !== undefined && !catalogCursor(options.cursor))
    )
      throw new RuntimeUpdateError(400);
    const search = new URLSearchParams({ query: options.query ?? "", cursor: options.cursor ?? "" });
    return catalog(await this.request("GET", `/v1/runtime-versions?${search}`, undefined, 128 * 1024));
  }

  async readiness() {
    return readiness(await this.request("GET", "/v1/runtime-readiness", undefined, 128 * 1024));
  }

  async submit(version: string, id: string) {
    if (!runtimeVersion(version) || !hex(id)) throw new RuntimeUpdateError(400);
    const result = job(await this.request("POST", "/v1/runtime-updates", { version, idempotency_key: id }));
    if (result.id !== id || result.version !== version) throw new RuntimeUpdateError();
    return result;
  }

  async operation(id: string) {
    if (!hex(id)) throw new RuntimeUpdateError(400);
    const result = job(await this.request("GET", `/v1/runtime-updates/${id}`));
    if (result.id !== id) throw new RuntimeUpdateError();
    return result;
  }
}
