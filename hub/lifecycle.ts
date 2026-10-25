import http from "node:http";
import path from "node:path";
import { readPrivateJson } from "./config.ts";

export type LifecycleConfig = { endpoint: string; credentialFile: string };
export type RestartRequest = {
  run_id: string;
  runtime_id: string;
  session_id: string;
  leaf_id: string | null;
  idempotency_key: string;
};
export type RuntimeTarget = {
  managed: boolean;
  reason?: "source_evidence_unavailable";
  run_id?: string;
  runtime_id?: string;
  session_id?: string;
  leaf_id?: string | null;
  version?: string;
  idle?: boolean;
  pending?: boolean;
  busy?: boolean;
  mode?: "auto" | "manual" | "disabled";
};
export type LifecycleJob = {
  id: string;
  run_id: string;
  status: string;
  stage: string;
  started_at?: number;
  runtime_id?: string;
  session_id?: string;
  leaf_id?: string | null;
  old_runtime_id?: string;
  new_runtime_id?: string;
  old_version?: string;
  expected_version?: string;
  new_version?: string;
};
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
export function lifecycleConfig(value: unknown): LifecycleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lifecycle provider");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "credentialFile,endpoint" ||
    typeof v.endpoint !== "string" ||
    typeof v.credentialFile !== "string" ||
    !path.isAbsolute(v.credentialFile) ||
    v.credentialFile.includes("\0")
  )
    throw new Error("Invalid lifecycle provider");
  const endpoint = new URL(v.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port
  )
    throw new Error("Invalid lifecycle provider");
  return { endpoint: endpoint.origin, credentialFile: v.credentialFile };
}

export class GateLifecycle {
  private readonly config: LifecycleConfig;
  constructor(config: LifecycleConfig) {
    this.config = lifecycleConfig(config);
  }

  private async request(
    method: "GET" | "POST",
    route: string,
    value?: RestartRequest,
  ): Promise<Record<string, unknown>> {
    const credential = readPrivateJson(this.config.credentialFile);
    if (!credential || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token))
      throw new Error("Lifecycle provider unavailable");
    const body = value ? JSON.stringify(value) : undefined;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (result?: Record<string, unknown>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.destroy();
        if (result) resolve(result);
        else reject(new Error("Lifecycle provider rejected or unavailable"));
      };
      const request = http.request(
        new URL(route, this.config.endpoint),
        {
          method,
          agent: false,
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
            ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          },
        },
        (response) => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            finish();
            return;
          }
          let raw = Buffer.alloc(0);
          response.on("data", (chunk: Buffer) => {
            raw = Buffer.concat([raw, chunk]);
            if (raw.length > 16384) finish();
          });
          response.on("error", () => finish());
          response.on("end", () => {
            try {
              const result = JSON.parse(raw.toString("utf8"));
              if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
              finish(result);
            } catch {
              finish();
            }
          });
        },
      );
      const timer = setTimeout(() => finish(), 5000);
      request.on("error", () => finish());
      request.end(body);
    });
  }

  async target(runId: string): Promise<RuntimeTarget> {
    if (!hex(runId)) throw new Error("Invalid lifecycle identity");
    const value = await this.request("GET", `/v1/pi-lifecycle/runs/${runId}`);
    if (value.managed === false)
      return {
        managed: false,
        ...(value.reason === "source_evidence_unavailable" ? { reason: "source_evidence_unavailable" as const } : {}),
      };
    if (
      value.managed !== true ||
      value.run_id !== runId ||
      !text(value.runtime_id) ||
      !text(value.session_id) ||
      (value.leaf_id !== null && !text(value.leaf_id)) ||
      !text(value.version) ||
      typeof value.idle !== "boolean" ||
      typeof value.pending !== "boolean" ||
      typeof value.busy !== "boolean" ||
      !["auto", "manual", "disabled"].includes(value.mode as string)
    )
      throw new Error("Invalid lifecycle target");
    return {
      managed: true,
      run_id: runId,
      runtime_id: value.runtime_id,
      session_id: value.session_id,
      leaf_id: value.leaf_id as string | null,
      version: value.version,
      idle: value.idle,
      pending: value.pending,
      busy: value.busy,
      mode: value.mode as RuntimeTarget["mode"],
    };
  }

  private job(value: Record<string, unknown>): LifecycleJob {
    if (
      !hex(value.id) ||
      !hex(value.run_id) ||
      typeof value.status !== "string" ||
      !["pending", "queued", "running", "succeeded", "failed", "recovery_required", "rejected", "stale"].includes(
        value.status,
      ) ||
      typeof value.stage !== "string" ||
      !/^[a-z_]{1,64}$/.test(value.stage)
    )
      throw new Error("Invalid lifecycle result");
    const result: LifecycleJob = { id: value.id, run_id: value.run_id, status: value.status, stage: value.stage };
    if (value.started_at !== undefined) {
      if (
        !Number.isSafeInteger(value.started_at) ||
        Number(value.started_at) <= 0 ||
        Number(value.started_at) > Date.now() + 5000
      )
        throw new Error("Invalid lifecycle start time");
      result.started_at = Number(value.started_at);
    } else if (value.status === "running" || value.status === "succeeded")
      throw new Error("Missing lifecycle start time");
    for (const key of [
      "runtime_id",
      "session_id",
      "old_runtime_id",
      "new_runtime_id",
      "old_version",
      "expected_version",
      "new_version",
    ] as const) {
      if (value[key] !== undefined) {
        if (!text(value[key])) throw new Error("Invalid lifecycle result");
        result[key] = value[key];
      }
    }
    if (value.leaf_id !== undefined) {
      if (value.leaf_id !== null && !text(value.leaf_id)) throw new Error("Invalid lifecycle result");
      result.leaf_id = value.leaf_id as string | null;
    }
    return result;
  }

  async restart(value: RestartRequest) {
    if (
      Object.keys(value).sort().join(",") !== "idempotency_key,leaf_id,run_id,runtime_id,session_id" ||
      !hex(value.run_id) ||
      !hex(value.idempotency_key) ||
      !text(value.runtime_id) ||
      !text(value.session_id) ||
      (value.leaf_id !== null && !text(value.leaf_id))
    )
      throw new Error("Invalid lifecycle request");
    const result = this.job(await this.request("POST", "/v1/pi-lifecycle/restarts", value));
    if (result.run_id !== value.run_id) throw new Error("Lifecycle target changed");
    return result;
  }

  async operation(id: string) {
    if (!hex(id)) throw new Error("Invalid lifecycle identity");
    const job = this.job(await this.request("GET", `/v1/pi-lifecycle/restarts/${id}`));
    if (job.id !== id) throw new Error("Lifecycle operation changed");
    return job;
  }
}
