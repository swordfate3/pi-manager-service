import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { HUB_GENERATION_SOURCE, isHubGeneration, isHubSessionPath } from "../protocol/hub-generation.ts";
import type { RuntimeMetadata } from "../protocol/runtime-metadata.ts";
import { type HubConfig, privateDirectory, readPrivateJson } from "./config.ts";
import { gatewayIdentity } from "./gateway-auth.ts";
import { GateLifecycle, type LifecycleJob, type RestartRequest } from "./lifecycle.ts";
import { HubManagement } from "./management.ts";
import { GateRuntimeUpdates, RuntimeUpdateError, runtimeVersion } from "./runtime-updates.ts";
import { storageDiagnostics, withStateWriter } from "./state-budget.ts";

type RouteIdentity = { runId: string; generation: string; runtime?: RuntimeMetadata };
type Receipt = RestartRequest & { id: string; generation: string; requestedAt: number };
type Hooks = {
  clearHandoff: (id: string) => void;
  lookup: (generation: string) => Promise<RouteIdentity | undefined>;
  granted: (runId: string) => boolean;
  successor: (
    runId: string,
    runtimeId: string,
    sessionId: string,
    leafId: string | null,
    version: string,
  ) => Promise<string | undefined>;
  prepareHandoff: (
    runId: string,
    receipt: { id: string; generation: string; runtimeId: string; sessionId: string; leafId: string | null },
  ) => void;
};
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
  const data = await new Promise<Buffer>((resolve, reject) => {
    let data = Buffer.alloc(0);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
      if (error) reject(error);
      else resolve(data);
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 8192) {
        request.resume();
        finish(new Error());
      }
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error());
    const timer = setTimeout(onError, 5000);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
  });
  const value = JSON.parse(data.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value;
}

export function createRestartApi(config: HubConfig, hooks: Hooks, management = new HubManagement(config)) {
  const provider = config.lifecycle ? new GateLifecycle(config.lifecycle) : undefined;
  const runtimeProvider = config.runtimeUpdates ? new GateRuntimeUpdates(config.runtimeUpdates) : undefined;
  const receipts = path.join(config.stateDir, "restarts");
  if (provider) privateDirectory(receipts);
  const file = (id: string) => {
    if (!hex(id)) throw new Error();
    return path.join(receipts, `${id}.json`);
  };
  const read = (id: string): Receipt => {
    const value = readPrivateJson(file(id));
    if (
      value.id !== id ||
      !hex(value.run_id) ||
      !isHubGeneration(value.generation) ||
      value.idempotency_key !== id ||
      !text(value.runtime_id) ||
      !text(value.session_id) ||
      (value.leaf_id !== null && !text(value.leaf_id))
    )
      throw new Error();
    return value;
  };
  const save = (value: Receipt, publish: () => void) =>
    withStateWriter(config, (writer) => {
      if (!hooks.granted(value.run_id)) throw new Error();
      if (readdirSync(receipts).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).length >= 1000) throw new Error();
      writer.write(`restarts/${value.id}.json`, value, { exclusive: true });
      publish();
    });
  const resolve = async (id: string, submitted?: LifecycleJob): Promise<Record<string, unknown>> => {
    if (!provider) throw new Error();
    const receipt = read(id);
    if (!hooks.granted(receipt.run_id)) throw new Error();
    const job = submitted ?? (await provider.operation(id));
    if (job.run_id !== receipt.run_id || !hooks.granted(receipt.run_id)) throw new Error();
    // Persist the first trusted execution timestamp. Later queries, including
    // after a Hub restart, cannot replace it with a fresh lease.
    const clockFile = path.join(receipts, `${id}.started.json`);
    if (job.started_at !== undefined)
      withStateWriter(config, (writer) => {
        if (!hooks.granted(receipt.run_id)) throw new Error();
        if (!existsSync(clockFile))
          writer.write(`restarts/${id}.started.json`, { started_at: job.started_at }, { exclusive: true });
      });
    if (existsSync(clockFile) && readPrivateJson(clockFile).started_at !== job.started_at) throw new Error();
    const result: Record<string, unknown> = { id, status: job.status, stage: job.stage };
    const failed = (stage: string) => {
      hooks.clearHandoff(id);
      return { ...result, status: "failed", stage };
    };
    if (["failed", "recovery_required", "rejected", "stale"].includes(job.status)) hooks.clearHandoff(id);
    for (const key of ["old_version", "expected_version", "new_version"] as const) if (job[key]) result[key] = job[key];
    if (job.status === "succeeded") {
      if (
        job.old_runtime_id !== receipt.runtime_id ||
        job.session_id !== receipt.session_id ||
        job.leaf_id !== receipt.leaf_id ||
        !job.new_runtime_id ||
        job.new_runtime_id === receipt.runtime_id ||
        !job.new_version ||
        job.new_version !== job.expected_version
      )
        return failed("restored_identity_mismatch");
      if (job.started_at === undefined) throw new Error();
      const deadline = job.started_at + 210_000;
      const verifiedFile = path.join(receipts, `${id}.verified.json`);
      const completed = existsSync(verifiedFile) ? readPrivateJson(verifiedFile) : undefined;
      if (
        completed &&
        (completed.id !== id ||
          completed.run_id !== receipt.run_id ||
          completed.generation !== receipt.generation ||
          completed.old_runtime_id !== receipt.runtime_id ||
          completed.session_id !== receipt.session_id ||
          completed.leaf_id !== receipt.leaf_id ||
          completed.started_at !== job.started_at ||
          !Number.isSafeInteger(completed.at) ||
          completed.at >= deadline ||
          completed.at < job.started_at ||
          completed.at > Date.now() ||
          completed.runtimeId !== job.new_runtime_id ||
          completed.version !== job.new_version ||
          !isHubSessionPath(completed.path))
      )
        throw new Error();
      if (!completed && Date.now() >= deadline) return failed("registration_timeout");
      let route: string | undefined;
      try {
        route = await hooks.successor(
          receipt.run_id,
          job.new_runtime_id,
          receipt.session_id,
          receipt.leaf_id,
          job.new_version,
        );
      } catch (error) {
        if (!completed) throw error;
        // Failure to prove current availability cannot undo validated history.
        // Grant revocation still wins below; no path is issued without proof.
      }
      if (!hooks.granted(receipt.run_id)) throw new Error();
      if (completed) {
        // A persisted in-budget result is historical. Progress, quit or a new
        // generation may remove its link, but never turn it into a failed job.
        if (route === completed.path) result.path = route;
        return result;
      }
      if (Date.now() >= deadline) return failed("registration_timeout");
      if (route) {
        if (!isHubSessionPath(route)) throw new Error();
        withStateWriter(config, (writer) => {
          if (!hooks.granted(receipt.run_id) || Date.now() >= deadline) throw new Error();
          if (!existsSync(verifiedFile))
            writer.write(
              `restarts/${id}.verified.json`,
              {
                id,
                run_id: receipt.run_id,
                generation: receipt.generation,
                old_runtime_id: receipt.runtime_id,
                session_id: receipt.session_id,
                leaf_id: receipt.leaf_id,
                started_at: job.started_at,
                at: Date.now(),
                path: route,
                runtimeId: job.new_runtime_id,
                version: job.new_version,
              },
              { exclusive: true },
            );
        });
        result.path = route;
      } else {
        result.status = "running";
        result.stage = "waiting_for_registration";
      }
    }
    return result;
  };
  return {
    resolve,
    async handle(request: IncomingMessage, response: ServerResponse, sameOrigin: boolean): Promise<boolean> {
      const requestUrl = new URL(request.url ?? "/", "http://hub.invalid");
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith("/api/management/")) return false;
      const reply = (status: number, value: unknown, cookie?: string) => {
        response
          .writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            ...(cookie ? { "Set-Cookie": cookie } : {}),
          })
          .end(JSON.stringify(value));
      };
      let phase = "authorization";
      try {
        if (config.management?.gateway && !gatewayIdentity(config, request)) {
          reply(401, { error: "Verified gateway login required" });
          return true;
        }
        if (request.method === "GET" && pathname === "/api/management/status") {
          reply(200, {
            available: !!provider || !!runtimeProvider || !!config.gateManagement || !!config.management,
            ...(config.gateManagement ? { gateManagementAvailable: true } : {}),
            ...(config.management ? { interactionsAvailable: true } : {}),
            restartAvailable: !!provider,
            ...(config.management?.gateway ? { authMode: "gateway" } : {}),
            ...(runtimeProvider ? { runtimeUpdatesAvailable: true } : {}),
            ...management.status(request),
          });
          return true;
        }
        if (request.method === "POST" && !sameOrigin) {
          reply(403, { error: "Same-origin management request required" });
          return true;
        }
        if (request.method === "POST" && pathname === "/api/management/unlock") {
          if (config.management?.gateway) {
            reply(404, { error: "Pairing is not enabled" });
            return true;
          }
          const value = await body(request);
          if (Object.keys(value).join(",") !== "code") throw new Error();
          const result = management.unlock(value.code);
          reply(200, { authorized: true, csrf: result.csrf, expiresAt: result.expiresAt }, result.cookie);
          return true;
        }
        if (request.method === "POST" && pathname === "/api/management/gateway") {
          if (!config.management?.gateway) {
            reply(404, { error: "Gateway login is not configured" });
            return true;
          }
          try {
            if (Object.keys(await body(request)).length !== 0) throw new Error();
          } catch {
            reply(400, { error: "Empty gateway session request required" });
            return true;
          }
          const result = management.unlockGateway(request);
          reply(200, { authorized: true, csrf: result.csrf, expiresAt: result.expiresAt }, result.cookie);
          return true;
        }
        const authorization = management.authorize(request, request.method !== "GET");
        const revalidate = () => {
          phase = "authorization";
          management.revalidate(request, authorization, request.method !== "GET");
          phase = "provider";
        };
        if (request.method === "POST" && pathname === "/api/management/logout") {
          reply(200, { authorized: false }, management.logout(request));
          return true;
        }
        if (request.method === "GET" && pathname === "/api/management/storage") {
          reply(200, storageDiagnostics(config));
          return true;
        }
        phase = "provider";
        if (pathname === "/api/management/runtime-versions" || pathname === "/api/management/runtime-readiness") {
          if (!runtimeProvider) {
            reply(503, { error: "Global Pi updates are not configured" });
            return true;
          }
          if (request.method !== "GET") {
            reply(405, { error: "Method not allowed" });
            return true;
          }
          if (pathname === "/api/management/runtime-readiness" && requestUrl.searchParams.size !== 0) {
            reply(404, { error: "Management route not found" });
            return true;
          }
          const keys = [...requestUrl.searchParams.keys()];
          if (
            pathname === "/api/management/runtime-versions" &&
            (keys.some((key) => key !== "query" && key !== "cursor") ||
              requestUrl.searchParams.getAll("query").length > 1 ||
              requestUrl.searchParams.getAll("cursor").length > 1)
          ) {
            reply(404, { error: "Management route not found" });
            return true;
          }
          try {
            const result =
              pathname === "/api/management/runtime-versions"
                ? await runtimeProvider.catalog({
                    ...(requestUrl.searchParams.has("query")
                      ? { query: requestUrl.searchParams.get("query") ?? "" }
                      : {}),
                    ...(requestUrl.searchParams.has("cursor")
                      ? { cursor: requestUrl.searchParams.get("cursor") ?? "" }
                      : {}),
                  })
                : await runtimeProvider.readiness();
            revalidate();
            reply(200, result);
          } catch (error) {
            if (!(error instanceof RuntimeUpdateError)) throw error;
            revalidate();
            reply(error.status, {
              error:
                error.status === 400
                  ? "Invalid bounded runtime catalog query"
                  : "Runtime provider unavailable; catalog or readiness could not be verified",
            });
          }
          return true;
        }
        if (
          pathname.startsWith("/api/management/runtime-versions") ||
          pathname.startsWith("/api/management/runtime-readiness")
        ) {
          reply(404, { error: "Management route not found" });
          return true;
        }
        if (
          pathname === "/api/management/runtime-updates" ||
          /^\/api\/management\/runtime-updates\/[a-f0-9]{32}$/.test(pathname)
        ) {
          if (!runtimeProvider) {
            reply(503, { error: "Global Pi updates are not configured" });
            return true;
          }
          let result: unknown;
          let status = 200;
          try {
            if (request.method === "GET") {
              result =
                pathname === "/api/management/runtime-updates"
                  ? await runtimeProvider.status()
                  : await runtimeProvider.operation(pathname.slice("/api/management/runtime-updates/".length));
            } else if (request.method === "POST" && pathname === "/api/management/runtime-updates") {
              let value: Record<string, unknown>;
              try {
                value = await body(request);
              } catch {
                revalidate();
                reply(400, { error: "Invalid runtime update request" });
                return true;
              }
              revalidate();
              if (
                Object.keys(value).sort().join(",") !== "idempotencyKey,version" ||
                !runtimeVersion(value.version) ||
                !hex(value.idempotencyKey)
              ) {
                reply(400, { error: "Exact stable Pi version and idempotency identity required" });
                return true;
              }
              result = await runtimeProvider.submit(value.version, value.idempotencyKey);
              status = 202;
            } else {
              reply(405, { error: "Method not allowed" });
              return true;
            }
          } catch (error) {
            if (!(error instanceof RuntimeUpdateError)) throw error;
            // Do not relay upstream response bodies, credentials or private paths.
            revalidate();
            reply(error.status, {
              error:
                error.status === 400
                  ? "Pi version rejected; use an audited exact stable version"
                  : error.status === 409
                    ? "Gate is busy or global updates are disabled"
                    : error.status === 404
                      ? "Runtime update not found; verify the original task ID"
                      : "Runtime provider unavailable or outcome unknown; query the original task ID before retrying",
            });
            return true;
          }
          revalidate();
          reply(status, result);
          return true;
        }
        if (pathname.startsWith("/api/management/runtime-updates")) {
          reply(404, { error: "Management route not found" });
          return true;
        }
        if (!provider) {
          reply(503, { error: "Managed restart is not configured" });
          return true;
        }
        const targetMatch = new RegExp(`^/api/management/targets/(${HUB_GENERATION_SOURCE})$`).exec(pathname);
        if (request.method === "GET" && targetMatch) {
          const selected = await hooks.lookup(targetMatch[1]);
          if (!selected) {
            reply(410, { error: "Session changed" });
            return true;
          }
          if (!selected.runtime?.managed) {
            reply(200, { managed: false });
            return true;
          }
          const target = await provider.target(selected.runId);
          if (!hooks.granted(selected.runId)) throw new Error();
          const { run_id: _runId, ...safe } = target;
          if (
            target.managed &&
            (target.runtime_id !== selected.runtime.runtimeId ||
              target.session_id !== selected.runtime.sessionId ||
              target.leaf_id !== selected.runtime.leafId)
          ) {
            reply(409, { error: "Session identity changed; refresh before restarting" });
            return true;
          }
          reply(200, safe);
          return true;
        }
        if (request.method === "POST" && pathname === "/api/management/restarts") {
          const value = await body(request);
          revalidate();
          if (
            Object.keys(value).sort().join(",") !== "generation,idempotencyKey,leafId,runtimeId,sessionId" ||
            !isHubGeneration(value.generation) ||
            !hex(value.idempotencyKey) ||
            !text(value.runtimeId) ||
            !text(value.sessionId) ||
            (value.leafId !== null && !text(value.leafId))
          ) {
            reply(400, { error: "Invalid restart request" });
            return true;
          }
          const id = value.idempotencyKey;
          let receipt: Receipt;
          if (existsSync(file(id))) {
            receipt = read(id);
            if (
              receipt.generation !== value.generation ||
              receipt.runtime_id !== value.runtimeId ||
              receipt.session_id !== value.sessionId ||
              receipt.leaf_id !== value.leafId
            )
              throw new Error();
            // A retry is a query, never a second execution or a fresh target selection.
            reply(200, await resolve(id));
            return true;
          }
          const selected = await hooks.lookup(value.generation);
          revalidate();
          if (
            !selected?.runtime?.managed ||
            selected.runtime.runtimeId !== value.runtimeId ||
            selected.runtime.sessionId !== value.sessionId ||
            selected.runtime.leafId !== value.leafId
          ) {
            reply(409, { error: "Session changed or needs a managed image" });
            return true;
          }
          receipt = {
            id,
            generation: value.generation,
            requestedAt: Date.now(),
            run_id: selected.runId,
            runtime_id: value.runtimeId,
            session_id: value.sessionId,
            leaf_id: value.leafId as string | null,
            idempotency_key: id,
          };
          revalidate();
          save(receipt, () => {
            revalidate();
            hooks.prepareHandoff(selected.runId, {
              id,
              generation: receipt.generation,
              runtimeId: receipt.runtime_id,
              sessionId: receipt.session_id,
              leafId: receipt.leaf_id,
            });
          });
          revalidate();
          const job = await provider.restart({
            run_id: receipt.run_id,
            runtime_id: receipt.runtime_id,
            session_id: receipt.session_id,
            leaf_id: receipt.leaf_id,
            idempotency_key: id,
          });
          if (job.id !== id || !hooks.granted(receipt.run_id)) throw new Error();
          reply(202, await resolve(id, job));
          return true;
        }
        const match = /^\/api\/management\/restarts\/([a-f0-9]{32})$/.exec(pathname);
        if (request.method === "GET" && match) {
          reply(200, await resolve(match[1]));
          return true;
        }
        reply(404, { error: "Management route not found" });
      } catch {
        // Preserve admitted receipts even on uncertain pre-submit failure.
        // A retry is a query, never permission to replay an old operation.
        reply(phase === "authorization" ? 401 : 409, {
          error:
            phase === "authorization"
              ? "Management authorization required"
              : "Restart unavailable or outcome unknown; refresh status before retrying",
        });
      }
      return true;
    },
  };
}
