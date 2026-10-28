import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BOUNDED_PROTOCOL, HUB_GENERATION_SOURCE, isBoundedGeneration } from "../protocol/hub-generation.ts";
import { type InteractionRegistration, readInteractionRegistration } from "../protocol/interactions/protocol.ts";
import { type RuntimeMetadata, readRuntimeMetadata } from "../protocol/runtime-metadata.ts";
import { readSoftwareMetadata, type SoftwareMetadata } from "../protocol/software-metadata.ts";
import { proxySessionResponse } from "./asset-transfer.ts";
import {
  boundedRecord,
  boundedTuple,
  hasBoundedRecord,
  issueBounded,
  RegistryError,
  saveBounded,
} from "./bounded-registry.ts";
import {
  type Grant,
  type HubConfig,
  managementConfig,
  privateDirectory,
  readGrant,
  readPrivateJson,
} from "./config.ts";
import { ForwardQueue } from "./forward-queue.ts";
import { createGateManagementApi } from "./gate-management.ts";
import { gatewayIdentity } from "./gateway-auth.ts";
import type { InteractionTarget } from "./interaction-control.ts";
import { interactionPageCss, interactionPageJs, renderInteractionPageHtml } from "./interaction-page.ts";
import { createInteractionApi } from "./interactions.ts";
import { HUB_LIMITS } from "./limits.ts";
import { HubManagement } from "./management.ts";
import { portalCss, portalJs, portalManagementCss, portalManagementJs, renderPortalHtml } from "./portal.ts";
import { createRestartApi } from "./restart-api.ts";
import { acquireStateLock, StateBudgetError, type StateWriter, withStateWriter } from "./state-budget.ts";
import { createVersionStatus, type VersionStatusOptions } from "./version-status.ts";

type Session = {
  grant: Grant;
  generation: string;
  port: number;
  expires: number;
  since: number;
  sessionName: string | null;
  runtime?: RuntimeMetadata;
  software?: SoftwareMetadata;
  interaction?: InteractionRegistration;
};
type Handoff = {
  grant: Grant;
  from: string;
  successor?: string;
  expires: number;
  restart?: { id: string; runtimeId: string; deadline?: number };
  originalRuntimeId?: string;
  client?: WebSocket;
};
const mac = (token: string, value: string) => createHmac("sha256", token).update(value).digest("hex");
function equal(value: unknown, expected: string) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function proveBackend(grant: Grant, generation: string, port: number) {
  const challenge = randomBytes(24).toString("hex");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(valid);
    };
    const request = http.get(
      {
        host: grant.backendHost,
        port,
        path: "/.pi-web-identity",
        agent: false,
        headers: {
          "x-pi-web-challenge": challenge,
          "x-pi-web-challenge-proof": mac(grant.token, challenge),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          finish(false);
          return;
        }
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) finish(false);
        });
        response.on("error", () => finish(false));
        response.on("end", () => {
          try {
            const value = JSON.parse(body);
            finish(
              value.generation === generation && equal(value.proof, mac(grant.token, `${challenge}:${generation}`)),
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    const timer = setTimeout(() => finish(false), 1500);
    request.on("error", () => finish(false));
  });
}

function backendHeaders(request: IncomingMessage, session: Session) {
  const headers: http.OutgoingHttpHeaders = {};
  const hop = new Set([
    "connection",
    "upgrade",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "authorization",
    "cookie",
    "host",
  ]);
  for (const field of (request.headers.connection ?? "").split(",")) hop.add(field.trim().toLowerCase());
  for (const [key, value] of Object.entries(request.headers)) {
    if (
      !hop.has(key) &&
      !key.startsWith("x-pi-web-") &&
      !key.startsWith("x-pi-hub-") &&
      !key.startsWith("x-forwarded-") &&
      key !== "forwarded"
    )
      headers[key] = value;
  }
  headers["x-pi-web-generation"] = session.generation;
  headers["x-pi-web-proof"] = mac(session.grant.token, session.generation);
  return headers;
}

// This is a conservative allowlist, not a general extension parser. Offers we
// cannot safely satisfy keep the pre-compression, unextended WebSocket path.
function boundedDeflateOffer(header: string | undefined) {
  if (!header) return false;
  const [extension, ...parameters] = header.split(";").map((value) => value.trim());
  if (extension !== "permessage-deflate") return false;
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const [name, value, ...extra] = parameter.split("=");
    if (seen.has(name) || extra.length) return false;
    seen.add(name);
    if (name === "client_no_context_takeover" || name === "server_no_context_takeover") {
      if (value !== undefined) return false;
    } else if (name === "client_max_window_bits") {
      if (value !== undefined && !/^1[2-5]$/.test(value)) return false;
    } else if (name === "server_max_window_bits") {
      if (value === undefined || !/^1[2-5]$/.test(value)) return false;
    } else return false;
  }
  return seen.has("client_max_window_bits");
}

/** Explicitly launched independent process; never imported as a Pi extension entry. */
export async function startHub(config: HubConfig, options: { versions?: VersionStatusOptions } = {}) {
  if (config.management) managementConfig(config.management, config.port, config.publicUrl);
  const serving = acquireStateLock(config, ".serving.lock");
  config = { ...config, stateDir: serving.root };
  try {
    privateDirectory(config.runtimeDir);
    // Exclusive acquisition precedes any asynchronous stale-socket recovery.
    // Fail closed after a crash: a trusted operator must confirm the old process
    // is gone before removing its lock. Never guess from a reused PID.
    const lock = path.join(config.runtimeDir, "hub.lock");
    mkdirSync(lock, { mode: 0o700 });
    const owner = path.join(lock, "owner.json");
    const release = () => {
      if (!existsSync(lock)) return;
      if (existsSync(owner)) unlinkSync(owner);
      rmdirSync(lock);
    };
    try {
      writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      const hub = await startLockedHub(config, options);
      let closing: Promise<void> | undefined;
      return {
        ...hub,
        close: () => {
          closing ??= hub.close().finally(() => {
            release();
            serving.release();
          });
          return closing;
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    serving.release();
    throw error;
  }
}

async function startLockedHub(config: HubConfig, options: { versions?: VersionStatusOptions }) {
  privateDirectory(config.stateDir);
  privateDirectory(config.runtimeDir);
  privateDirectory(path.join(config.stateDir, "grants"));
  privateDirectory(path.join(config.stateDir, "generations"));
  privateDirectory(path.join(config.stateDir, "bounded"));
  // Do not steal a live socket from another manager. A crashed hub can leave a stale inode.
  if (existsSync(config.socketPath)) {
    const stat = lstatSync(config.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe hub socket path");
    const stale = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(config.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 500);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(error.code === "ECONNREFUSED");
      });
    });
    if (!stale) throw new Error("Another hub is already running");
    unlinkSync(config.socketPath);
  }
  const boot = randomBytes(16).toString("hex");
  withStateWriter(config, (writer) => writer.write("registry.json", { schema: 2, boot }, { security: true }));
  const sessions = new Map<string, Session>();
  const peers = new Set<net.Socket>();
  const connections = new Set<net.Socket>();
  const webSockets = new Map<WebSocket, string>();
  const outbound = new Map<WebSocket, ForwardQueue>();
  const sendControl = (client: WebSocket, value: string) => outbound.get(client)?.enqueue(value);
  let activeProbes = 0;
  const proof = async (grant: Grant, generation: string, port: number) => {
    if (activeProbes >= HUB_LIMITS.backendProbes) throw new RegistryError("HUB_BUSY");
    activeProbes++;
    try {
      return await proveBackend(grant, generation, port);
    } finally {
      activeProbes--;
    }
  };
  // Browser-only, memory-only capabilities. A disconnected browser gets one
  // short opportunity to follow its exact successor, never an arbitrary Pi.
  const handoffs = new Map<string, Handoff>();
  const pruneHandoffs = () => {
    for (const [token, item] of handoffs) if (item.expires <= Date.now()) handoffs.delete(token);
  };
  let stopped = false;
  let pending = Promise.resolve();
  let admittedRegistrations = 0;
  const versionStatus = createVersionStatus(options.versions);
  let url = "";
  let managementUrl: string | undefined;
  let interactionApi: ReturnType<typeof createInteractionApi> | undefined;
  const restarting = new Map<string, { id: string; runtimeId: string; deadline?: number }>();
  const activateRestart = (generation: string) => {
    const restart = restarting.get(generation);
    if (!restart) return;
    restart.deadline ??= Date.now() + 210_000;
    for (const item of handoffs.values()) if (item.restart === restart) item.expires = restart.deadline;
  };
  const retire = (generation: string, writer?: StateWriter) => {
    activateRestart(generation);
    const session = sessions.get(generation);
    sessions.delete(generation);
    interactionApi?.retire(generation);
    for (const [ws, id] of webSockets) if (id === generation) ws.terminate();
    if (session && isBoundedGeneration(generation)) {
      const clear = (transaction: StateWriter) => {
        const record = boundedRecord(config, session.grant.run_id, boot);
        if (record.current?.generation === generation) {
          delete record.current;
          saveBounded(transaction, record, true);
        }
      };
      try {
        if (writer) clear(writer);
        else withStateWriter(config, clear);
      } catch {
        /* Inert without live memory; restart changes boot. Never restore from disk. */
      }
    }
  };
  const current = (generation: string) => {
    const session = sessions.get(generation);
    if (!session) return undefined;
    try {
      const grant = readGrant(config, session.grant.run_id);
      if (
        session.expires <= Date.now() ||
        grant.revoked ||
        !equal(grant.token, session.grant.token) ||
        grant.backendHost !== session.grant.backendHost
      ) {
        retire(generation);
        return undefined;
      }
    } catch {
      retire(generation);
      return undefined;
    }
    return session;
  };
  const granted = (runId: string) => {
    try {
      return !readGrant(config, runId).revoked;
    } catch {
      return false;
    }
  };
  const verified = async (generation: string) => {
    const session = current(generation);
    if (
      !session ||
      !(await proof(session.grant, generation, session.port)) ||
      stopped ||
      current(generation) !== session
    )
      return undefined;
    return session;
  };
  const management = new HubManagement(config);
  const gateManagementApi = createGateManagementApi(config, management, (runId) => {
    const matches = [...sessions.keys()].map(current).filter((session) => session?.grant.run_id === runId);
    if (matches.length !== 1 || !matches[0]) return undefined;
    return new URL(`/s/${matches[0].generation}/`, config.publicUrl ?? url).href;
  });
  const interactionTarget = (session: Session | undefined): InteractionTarget | undefined => {
    const descriptor = session?.interaction ?? session?.runtime;
    if (!session || !descriptor) return undefined;
    return {
      identity: {
        runId: session.grant.run_id,
        generation: session.generation,
        runtimeId: descriptor.runtimeId,
        sessionId: descriptor.sessionId,
      },
      backendHost: session.grant.backendHost,
      port: session.port,
      token: session.grant.token,
    };
  };
  interactionApi = createInteractionApi(config, management, {
    generations: () => [...sessions.keys()].filter((generation) => !!interactionTarget(current(generation))),
    lookup: async (generation) => interactionTarget(await verified(generation)),
    current: (target) => {
      const fresh = interactionTarget(current(target.identity.generation));
      return (
        !!fresh &&
        !stopped &&
        fresh.identity.runId === target.identity.runId &&
        fresh.identity.runtimeId === target.identity.runtimeId &&
        fresh.identity.sessionId === target.identity.sessionId &&
        fresh.backendHost === target.backendHost &&
        fresh.port === target.port &&
        fresh.token === target.token
      );
    },
  });
  const restartApi = createRestartApi(
    config,
    {
      clearHandoff: (id) => {
        for (const [generation, item] of restarting) if (item.id === id) restarting.delete(generation);
        for (const [token, item] of handoffs) {
          if (item.restart?.id !== id) continue;
          const original = current(item.from);
          if (
            item.client?.readyState !== WebSocket.OPEN ||
            webSockets.get(item.client) !== item.from ||
            original?.grant.run_id !== item.grant.run_id ||
            original.runtime?.runtimeId !== item.restart.runtimeId
          ) {
            handoffs.delete(token);
            continue;
          }
          // The old connection survived. Drop all managed authority but retain
          // ordinary recovery, pinned to this generation/runtime rather than any
          // later registration. Its existing close handler starts the normal lease.
          item.originalRuntimeId = item.restart.runtimeId;
          item.restart = undefined;
          item.successor = item.from;
          item.expires = Infinity;
          sendControl(
            item.client,
            JSON.stringify({
              type: "event",
              event: "hub_route",
              payload: { generation: item.from, token },
            }),
          );
        }
      },
      granted,
      lookup: async (generation) => {
        const session = await verified(generation);
        return session ? { runId: session.grant.run_id, generation, runtime: session.runtime } : undefined;
      },
      successor: async (runId, runtimeId, sessionId, leafId, version) => {
        for (const generation of sessions.keys()) {
          const session = current(generation);
          const runtime = session?.runtime;
          if (
            session?.grant.run_id !== runId ||
            !runtime?.managed ||
            runtime.runtimeId !== runtimeId ||
            runtime.sessionId !== sessionId ||
            runtime.leafId !== leafId ||
            runtime.version !== version
          )
            continue;
          const proved = await verified(generation);
          const fresh = proved?.runtime;
          if (
            proved?.grant.run_id === runId &&
            fresh?.managed &&
            fresh.runtimeId === runtimeId &&
            fresh.sessionId === sessionId &&
            fresh.leafId === leafId &&
            fresh.version === version
          )
            return `/s/${generation}/`;
        }
        return undefined;
      },
      prepareHandoff: (runId, receipt) => {
        const selected = current(receipt.generation);
        if (
          !selected ||
          selected.grant.run_id !== runId ||
          selected.runtime?.runtimeId !== receipt.runtimeId ||
          selected.runtime.sessionId !== receipt.sessionId ||
          selected.runtime.leafId !== receipt.leafId
        )
          throw new Error("Session changed");
        const restart: { id: string; runtimeId: string; deadline?: number } = {
          id: receipt.id,
          runtimeId: receipt.runtimeId,
        };
        restarting.set(receipt.generation, restart);
        for (const [token, item] of handoffs) {
          if (item.from !== receipt.generation || item.grant.run_id !== runId) continue;
          item.restart = restart;
          item.expires = Infinity;
          if (!item.client) activateRestart(receipt.generation);
          if (item.client?.readyState === WebSocket.OPEN)
            sendControl(
              item.client,
              JSON.stringify({
                type: "event",
                event: "hub_route",
                payload: { generation: item.from, token, restart: { id: receipt.id, timeoutMs: 120_000 } },
              }),
            );
        }
      },
    },
    management,
  );
  const register = async (value: Record<string, unknown>) => {
    const authenticate = () => {
      if (stopped || typeof value.run_id !== "string") throw new RegistryError("AUTH_FAILED");
      const grant = readGrant(config, value.run_id);
      if (grant.revoked || !equal(value.token, grant.token)) throw new RegistryError("AUTH_FAILED");
      return grant;
    };
    if (value.action === "registry_negotiate") {
      return withStateWriter(config, () => {
        const grant = authenticate();
        if (
          typeof value.nonce !== "string" ||
          !/^[a-f0-9]{32}$/.test(value.nonce) ||
          typeof value.protocol !== "string" ||
          !/^[a-z0-9-]{1,64}$/.test(value.protocol)
        )
          throw new RegistryError("PROTOCOL_REJECTED");
        if (value.protocol !== BOUNDED_PROTOCOL) {
          const legacy = hasBoundedRecord(config, grant.run_id) ? undefined : "legacy-v1";
          return {
            unsupported: true,
            protocol: value.protocol,
            nonce: value.nonce,
            ...(legacy ? { legacy } : {}),
            proof: mac(grant.token, `${value.nonce}:${value.protocol}:UNSUPPORTED_PROTOCOL:${legacy ?? ""}`),
          };
        }
        const record = boundedRecord(config, grant.run_id, boot);
        return {
          protocol: BOUNDED_PROTOCOL,
          nonce: value.nonce,
          boot,
          slot: record.slot,
          proof: mac(grant.token, `${value.nonce}:${BOUNDED_PROTOCOL}:${boot}:${record.slot}`),
        };
      });
    }
    const bounded = ["bounded_issue", "bounded_register", "bounded_unregister"].includes(String(value.action));
    if (bounded ? value.protocol !== BOUNDED_PROTOCOL || value.boot !== boot : value.protocol !== undefined)
      throw new RegistryError("PROTOCOL_REJECTED");
    if (value.action === "bounded_issue") {
      return withStateWriter(config, (writer) => {
        const grant = authenticate();
        writer.assertAdmission();
        return issueBounded(
          writer,
          boundedRecord(config, grant.run_id, boot),
          value,
          (generation) => !!current(generation),
        );
      });
    }
    if (
      typeof value.generation !== "string" ||
      !(bounded ? isBoundedGeneration(value.generation) : /^[a-f0-9]{32}$/.test(value.generation))
    )
      throw new RegistryError("PROTOCOL_REJECTED");
    const generation = value.generation;
    const ledger = path.join(config.stateDir, "generations", `${generation}.json`);
    const readOwner = () => (existsSync(ledger) ? readPrivateJson(ledger) : undefined);
    if (value.action === "unregister" || value.action === "bounded_unregister") {
      return withStateWriter(config, (writer) => {
        const grant = authenticate();
        const session = current(generation);
        if (bounded) {
          const record = boundedRecord(config, grant.run_id, boot);
          let changed = false;
          for (const key of ["current", "pending"] as const)
            if (record[key]?.generation === generation) {
              delete record[key];
              changed = true;
            }
          if (changed) saveBounded(writer, record, true);
        } else {
          if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
          const owner = readOwner();
          if ((session && session.grant.run_id !== grant.run_id) || (owner && owner.run_id !== grant.run_id))
            throw new RegistryError("AUTH_FAILED");
          if (!owner || (session && !owner.retired))
            writer.write(
              `generations/${generation}.json`,
              { boot, run_id: grant.run_id, retired: true },
              { exclusive: !owner, security: !!owner },
            );
        }
        if (session?.grant.run_id === grant.run_id) retire(generation, writer);
        return {};
      });
    }
    if (
      (value.action !== "register" && value.action !== "bounded_register") ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65535
    )
      throw new RegistryError("PROTOCOL_REJECTED");
    if (
      value.sessionName !== undefined &&
      value.sessionName !== null &&
      (typeof value.sessionName !== "string" || value.sessionName.length > 256)
    )
      throw new Error("Registration rejected");
    const sessionName =
      typeof value.sessionName === "string" ? value.sessionName.replace(/\p{Cc}/gu, " ").trim() || null : null;
    const runtime = value.runtime === undefined ? undefined : readRuntimeMetadata(value.runtime);
    const software = value.software === undefined ? undefined : readSoftwareMetadata(value.software);
    const interaction = readInteractionRegistration(value.interaction);
    const port = Number(value.port);
    const prepared = withStateWriter(config, (writer) => {
      const grant = authenticate();
      writer.assertAdmission();
      const session = current(generation);
      if (bounded) {
        const record = boundedRecord(config, grant.run_id, boot);
        boundedTuple(record, generation, port, !!session);
        return { grant, session, revision: record.revision, owner: undefined };
      }
      if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
      const owner = readOwner();
      if (
        owner &&
        (owner.retired || owner.boot !== boot || owner.run_id !== grant.run_id || !session || session.port !== port)
      )
        throw new RegistryError();
      return { grant, session, revision: undefined, owner: JSON.stringify(owner) };
    });
    const { grant, session } = prepared;
    if (!(await proof(grant, generation, port)) || stopped) throw new RegistryError("PROOF_FAILED");
    // The common writer stays held through final validation AND memory publication.
    return withStateWriter(config, (writer) => {
      const latestGrant = authenticate();
      writer.assertAdmission();
      if (latestGrant.token !== grant.token || latestGrant.backendHost !== grant.backendHost)
        throw new RegistryError("AUTH_FAILED");
      if (session && current(generation) !== session) throw new RegistryError();
      if (bounded) {
        const record = boundedRecord(config, grant.run_id, boot);
        if (record.revision !== prepared.revision) throw new RegistryError();
        const which = boundedTuple(record, generation, port, !!session && current(generation) === session);
        if (which === "pending") {
          record.current = record.pending;
          delete record.pending;
        }
        record.current!.expires = Date.now() + config.leaseMs;
        saveBounded(writer, record);
      } else {
        if (hasBoundedRecord(config, grant.run_id) || JSON.stringify(readOwner()) !== prepared.owner)
          throw new RegistryError();
        if (!readOwner())
          writer.write(`generations/${generation}.json`, { boot, run_id: grant.run_id }, { exclusive: true });
      }
      for (const other of sessions.values())
        if (other.grant.run_id === grant.run_id && other.generation !== generation) retire(other.generation, writer);
      if (session) {
        session.expires = Date.now() + config.leaseMs;
        session.sessionName = sessionName;
        session.runtime = runtime;
        session.software = software;
        session.interaction = interaction;
      } else
        sessions.set(generation, {
          grant,
          generation,
          port,
          expires: Date.now() + config.leaseMs,
          since: Date.now(),
          sessionName,
          runtime,
          software,
          interaction,
        });
      pruneHandoffs();
      if (!session) {
        for (const item of handoffs.values()) {
          if (!item.restart && item.grant.run_id === grant.run_id && item.from !== generation && !item.successor)
            item.successor = generation;
        }
      }
      return { url: `${config.publicUrl ?? url}s/${generation}/` };
    });
  };
  const registry = net.createServer((socket) => {
    if (peers.size >= HUB_LIMITS.registrationPeers) {
      socket.destroy();
      return;
    }
    peers.add(socket);
    let data = Buffer.alloc(0);
    let received = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      peers.delete(socket);
    });
    const reply = (ok: boolean, result?: unknown, error = "Registration rejected", code?: string) => {
      if (!socket.destroyed)
        socket.end(`${JSON.stringify(ok ? { ok, result } : { ok, error, ...(code ? { code } : {}) })}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      if (data.length + chunk.length > 8192) {
        received = true;
        reply(false);
        return;
      }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end < 0) return;
      received = true;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data.subarray(0, end).toString());
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      } catch {
        reply(false);
        return;
      }
      data = Buffer.alloc(0);
      // Count admitted operations until their queue slot actually completes,
      // even when the peer disconnects. Peer count alone does not bound this tail.
      if (admittedRegistrations >= HUB_LIMITS.registrationOperations) {
        reply(false, undefined, "Registration rejected", "HUB_BUSY");
        return;
      }
      admittedRegistrations++;
      pending = pending
        .then(async () => {
          if (socket.destroyed) return;
          try {
            const result = await register(value);
            if ("unsupported" in result) {
              const { unsupported: _unsupported, ...details } = result;
              if (!socket.destroyed)
                socket.end(
                  `${JSON.stringify({ ok: false, error: "Unsupported registration protocol", code: "UNSUPPORTED_PROTOCOL", ...details })}\n`,
                );
            } else reply(true, result);
          } catch (error) {
            reply(
              false,
              undefined,
              error instanceof Error && error.message === "ended generation"
                ? "ended generation"
                : "Registration rejected",
              error instanceof RegistryError
                ? error.code
                : error instanceof StateBudgetError
                  ? "STATE_QUOTA"
                  : undefined,
            );
          }
        })
        .finally(() => {
          admittedRegistrations--;
        });
    });
  });
  const allowedBrowser = (request: IncomingMessage, requireOrigin = false, admin = false) => {
    const local = admin ? managementUrl : url;
    const canonical = admin ? config.management?.publicUrl : config.publicUrl;
    if (!local) return false;
    const allowed = new Set([new URL(local).origin, ...(canonical ? [new URL(canonical).origin] : [])]);
    const hosts = new Set([...allowed].map((origin) => new URL(origin).host));
    const origin = request.headers.origin;
    return (
      hosts.has(request.headers.host ?? "") &&
      request.headers["sec-fetch-site"] !== "cross-site" &&
      (origin === undefined
        ? !requireOrigin
        : allowed.has(origin) && (!admin || new URL(origin).host === request.headers.host))
    );
  };
  const routePattern = new RegExp(`^/s/(${HUB_GENERATION_SOURCE})(/.*)?$`);
  const matchRoute = (request: IncomingMessage) => routePattern.exec(request.url ?? "");
  const fail = (response: ServerResponse, code: number) =>
    response.writeHead(code, { "Cache-Control": "no-store" }).end();
  const handle = async (request: IncomingMessage, response: ServerResponse, admin = false) => {
    try {
      if (!allowedBrowser(request, false, admin)) {
        fail(response, 403);
        return;
      }
      const pathname = request.url?.split("?")[0];
      if (admin) {
        if (config.management?.gateway && !gatewayIdentity(config, request)) {
          fail(response, 401);
          return;
        }
        if (await gateManagementApi.handle(request, response, allowedBrowser(request, true, true))) return;
        if (await interactionApi?.handle(request, response, allowedBrowser(request, request.method !== "GET", true)))
          return;
        if (await restartApi.handle(request, response, allowedBrowser(request, true, true))) return;
        if (
          (![
            "/",
            "/sessions/",
            "/api/sessions",
            "/hub.js",
            "/hub-management.js",
            "/hub.css",
            "/interaction-page.js",
            "/interaction-page.css",
          ].includes(pathname ?? "") &&
            !new RegExp(`^/interactions/${HUB_GENERATION_SOURCE}/[a-f0-9]{32}/$`).test(pathname ?? "")) ||
          request.headers["service-worker"] !== undefined
        ) {
          fail(response, 404);
          return;
        }
      } else if (pathname?.startsWith("/api/management/")) {
        if (request.method === "GET" && pathname === "/api/management/status") {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
            JSON.stringify({
              available: false,
              authorized: false,
              ...(managementUrl ? { managementUrl: config.management?.publicUrl ?? managementUrl } : {}),
            }),
          );
        } else fail(response, 404);
        return;
      }
      if (pathname === "/api/session-handoff") {
        if (request.method !== "POST") {
          fail(response, 405);
          return;
        }
        if (!allowedBrowser(request, true)) {
          fail(response, 403);
          return;
        }
        pruneHandoffs();
        const token = request.headers["x-pi-web-handoff"];
        const item = typeof token === "string" && /^[a-f0-9]{48}$/.test(token) ? handoffs.get(token) : undefined;
        if (!item) {
          fail(response, 410);
          return;
        }
        const grant = readGrant(config, item.grant.run_id);
        if (grant.revoked || !equal(grant.token, item.grant.token) || grant.backendHost !== item.grant.backendHost) {
          handoffs.delete(token as string);
          fail(response, 410);
          return;
        }
        if (item.restart) {
          try {
            const result = await restartApi.resolve(item.restart.id);
            if (item.expires <= Date.now() || !granted(item.grant.run_id)) throw new Error();
            if (result.status === "succeeded" && typeof result.path === "string") {
              response
                .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
                .end(JSON.stringify({ path: result.path }));
            } else if (["pending", "queued", "running"].includes(result.status as string)) {
              response
                .writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" })
                .end(JSON.stringify({ pending: true }));
            } else fail(response, 410);
          } catch {
            fail(response, 410);
          }
          return;
        }
        const targetGeneration = item.successor ?? item.from;
        const successor = current(targetGeneration);
        const proved = successor && (await proof(grant, successor.generation, successor.port));
        // Proof is asynchronous: revocation and the capability deadline must
        // still win over either kind of retryable registration gap below.
        const latestGrant = readGrant(config, grant.run_id);
        if (
          stopped ||
          handoffs.get(token as string) !== item ||
          item.expires <= Date.now() ||
          latestGrant.revoked ||
          !equal(latestGrant.token, grant.token) ||
          latestGrant.backendHost !== grant.backendHost
        ) {
          handoffs.delete(token as string);
          fail(response, 410);
          return;
        }
        // Before the first successor registers, the old backend may already
        // reject proof or retire. Keep waiting within the existing deadline.
        // Once bound, never skip a failed/retired successor for a later one.
        if (
          (!item.successor && (!proved || current(targetGeneration) !== successor)) ||
          (targetGeneration !== item.successor && item.successor && current(item.successor))
        ) {
          response
            .writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(JSON.stringify({ pending: true }));
          return;
        }
        if (
          !successor ||
          successor.grant.run_id !== grant.run_id ||
          !proved ||
          stopped ||
          current(targetGeneration) !== successor ||
          (item.originalRuntimeId !== undefined && successor.runtime?.runtimeId !== item.originalRuntimeId) ||
          item.expires <= Date.now()
        ) {
          fail(response, 410);
          return;
        }
        response
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ path: `/s/${successor.generation}/` }));
        return;
      }
      const route = matchRoute(request);
      if (route) {
        const session = current(route[1]);
        if (!session) {
          fail(response, 410);
          return;
        }
        if (!route[2]) {
          response.writeHead(308, { Location: `/s/${route[1]}/`, "Cache-Control": "no-store" }).end();
          return;
        }
        if (!(await proof(session.grant, session.generation, session.port))) {
          retire(session.generation);
          fail(response, 410);
          return;
        }
        if (stopped || current(session.generation) !== session || response.destroyed) {
          fail(response, 410);
          return;
        }
        const upstream = http.request(
          {
            host: session.grant.backendHost,
            port: session.port,
            path: route[2],
            method: request.method,
            headers: backendHeaders(request, session),
            agent: false,
          },
          (result) => {
            proxySessionResponse(request, response, result, route[2]);
          },
        );
        upstream.setTimeout(30000, () => upstream.destroy());
        upstream.on("error", () => {
          if (!response.headersSent) fail(response, 502);
          else response.destroy();
        });
        response.once("close", () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        fail(response, 405);
        return;
      }
      if (pathname === "/") {
        response.writeHead(302, { Location: "/sessions/", "Cache-Control": "no-store" }).end();
        return;
      }
      if (pathname === "/api/sessions") {
        versionStatus.ensureStarted();
        const items = [...sessions.keys()]
          .map(current)
          .filter((s): s is Session => Boolean(s))
          .map((s) => ({
            label: s.grant.label,
            sessionName: s.sessionName,
            generation: s.generation,
            path: admin ? `${config.publicUrl ?? url}s/${s.generation}/` : `/s/${s.generation}/`,
            since: s.since,
            ...(s.runtime ? { runtime: { version: s.runtime.version, managed: s.runtime.managed } } : {}),
            ...(s.software ? { software: s.software } : {}),
          }));
        response
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ sessions: items, versions: versionStatus.snapshot() }));
        return;
      }
      const asset =
        admin && new RegExp(`^/interactions/${HUB_GENERATION_SOURCE}/[a-f0-9]{32}/$`).test(pathname ?? "")
          ? ["text/html", renderInteractionPageHtml()]
          : admin && pathname === "/interaction-page.js"
            ? ["text/javascript", interactionPageJs]
            : admin && pathname === "/interaction-page.css"
              ? ["text/css", interactionPageCss]
              : pathname === "/sessions/"
                ? [
                    "text/html",
                    renderPortalHtml(admin, config.publicUrl ?? url, config.management?.publicUrl ?? managementUrl, config.managerLinks),
                  ]
                : pathname === "/hub.js"
                  ? ["text/javascript", portalJs]
                  : admin && pathname === "/hub-management.js"
                    ? ["text/javascript", portalManagementJs]
                    : pathname === "/hub.css"
                      ? ["text/css", portalCss + portalManagementCss]
                      : undefined;
      if (!asset) {
        fail(response, pathname?.startsWith("/s/") ? 410 : 404);
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": `${asset[0]}; charset=utf-8`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
        })
        .end(request.method === "HEAD" ? undefined : asset[1]);
    } catch (error) {
      if (!response.headersSent)
        fail(response, error instanceof RegistryError && error.code === "HUB_BUSY" ? 503 : 500);
      else response.destroy();
    }
  };
  const server = http.createServer((request, response) => void handle(request, response));
  const managementServer = config.management
    ? http.createServer((request, response) => void handle(request, response, true))
    : undefined;
  managementServer?.on("connection", (socket) => {
    if (connections.size >= HUB_LIMITS.connections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => connections.delete(socket));
  });
  managementServer?.on("clientError", (_error, socket) => socket.destroy());
  managementServer?.on("upgrade", (_request, socket) => socket.destroy());
  managementServer?.on("connect", (_request, socket) => socket.destroy());
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: HUB_LIMITS.inFlightBytes,
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 12,
      clientMaxWindowBits: 12,
      concurrencyLimit: HUB_LIMITS.websocketCompression,
      threshold: 1024,
      zlibDeflateOptions: { level: 3, memLevel: 7 },
    },
  });
  server.on("connection", (socket) => {
    if (connections.size >= HUB_LIMITS.connections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => connections.delete(socket));
  });
  const rejectUpgrade = (socket: Duplex, code: number) => {
    const timer = setTimeout(() => socket.destroy(), 500);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  let browserAdmissions = 0;
  server.on("upgrade", async (request, socket, head) => {
    let reserved = false;
    let upgradePending = true;
    let browserClosed = false;
    let upstreamSocket: WebSocket | undefined;
    let upstreamClosed = false;
    const release = () => {
      // A closed browser can still own an unfinished proof or upstream
      // handshake. Keep its credit until all that work has settled.
      if (reserved && !upgradePending && browserClosed && (!upstreamSocket || upstreamClosed)) {
        reserved = false;
        browserAdmissions--;
      }
    };
    try {
      if (!allowedBrowser(request, true)) {
        rejectUpgrade(socket, 403);
        return;
      }
      // Reserve before proof/handshake, not only once the browser opens.
      if (browserAdmissions >= HUB_LIMITS.browserPairs) {
        rejectUpgrade(socket, 503);
        return;
      }
      browserAdmissions++;
      reserved = true;
      socket.once("close", () => {
        browserClosed = true;
        upstreamSocket?.terminate();
        release();
      });
      const route = matchRoute(request);
      const session = route && route[2] === "/ws" ? current(route[1]) : undefined;
      if (
        !session ||
        !(await proof(session.grant, session.generation, session.port)) ||
        stopped ||
        current(session.generation) !== session
      ) {
        if (!socket.destroyed) rejectUpgrade(socket, 410);
        return;
      }
      // The browser may have closed while proof was in flight. A listener
      // installed after this await cannot observe that earlier cancellation.
      if (browserClosed || socket.destroyed || !reserved) return;
      const host =
        net.isIP(session.grant.backendHost) === 6 ? `[${session.grant.backendHost}]` : session.grant.backendHost;
      const headers = backendHeaders(request, session);
      delete headers["sec-websocket-extensions"];
      const upstream = new WebSocket(`ws://${host}:${session.port}/ws`, {
        headers,
        // Only the slow browser/tunnel leg needs compression. Keep Pi's local
        // hop unchanged and avoid creating a second compression context.
        perMessageDeflate: false,
        handshakeTimeout: 3000,
        maxPayload: HUB_LIMITS.inFlightBytes,
      });
      upstreamSocket = upstream;
      webSockets.set(upstream, session.generation);
      const handshakeError = () => {
        if (!socket.destroyed) rejectUpgrade(socket, 502);
      };
      upstream.once("error", handshakeError);
      upstream.once("close", () => {
        upstreamClosed = true;
        webSockets.delete(upstream);
        release();
      });
      upstream.once("open", () => {
        upstream.removeListener("error", handshakeError);
        upstream.on("error", () => socket.destroy());
        if (stopped || current(session.generation) !== session || socket.destroyed) {
          upstream.terminate();
          socket.destroy();
          return;
        }
        if (!boundedDeflateOffer(request.headers["sec-websocket-extensions"])) {
          delete request.headers["sec-websocket-extensions"];
        }
        wss.handleUpgrade(request, socket, head, (client) => {
          webSockets.set(client, session.generation);
          let slowClosing = false;
          const slowPair = () => {
            if (slowClosing) return;
            slowClosing = true;
            for (const peer of [client, upstream]) {
              if (peer.readyState === WebSocket.OPEN) peer.close(1013, "Slow consumer; reconnect");
              const timer = setTimeout(() => peer.terminate(), 250);
              timer.unref();
              peer.once("close", () => clearTimeout(timer));
            }
          };
          const clientQueue = new ForwardQueue(client, slowPair);
          const upstreamQueue = new ForwardQueue(upstream, slowPair);
          outbound.set(client, clientQueue);
          const forward = (from: WebSocket, to: WebSocket) => {
            const queue = to === client ? clientQueue : upstreamQueue;
            from.on("message", (data, binary) => {
              if (slowClosing) return;
              if (from === upstream && !binary) {
                try {
                  const value = JSON.parse(data.toString());
                  // Reserve this one Hub transport event. Ordinary Pi events
                  // still pass through byte-for-byte, including unknown ones.
                  if (value?.type === "event" && value.event === "hub_route") return;
                } catch {
                  // Non-JSON payloads retain their existing transport behavior.
                }
              }
              if (!queue.enqueue(data, binary)) slowPair();
            });
            from.once("close", () => {
              webSockets.delete(from);
              outbound.delete(from);
              clientQueue.dispose();
              upstreamQueue.dispose();
              if (!slowClosing) to.terminate();
            });
            from.on("error", () => to.terminate());
          };
          forward(client, upstream);
          forward(upstream, client);
          pruneHandoffs();
          if (handoffs.size < 512) {
            const token = randomBytes(24).toString("hex");
            const restart = restarting.get(session.generation);
            const activeRestart =
              restart && (restart.deadline === undefined || restart.deadline > Date.now()) ? restart : undefined;
            const item: Handoff = {
              grant: session.grant,
              from: session.generation,
              expires: activeRestart?.deadline ?? Infinity,
              client,
              restart: activeRestart,
            };
            handoffs.set(token, item);
            client.once("close", () => {
              item.client = undefined;
              activateRestart(item.from);
              item.expires = item.restart?.deadline ?? Date.now() + 45_000;
            });
            sendControl(
              client,
              JSON.stringify({
                type: "event",
                event: "hub_route",
                payload: {
                  generation: session.generation,
                  token,
                  ...(activeRestart ? { restart: { id: activeRestart.id, timeoutMs: 120_000 } } : {}),
                },
              }),
            );
          }
        });
      });
    } catch {
      upstreamSocket?.terminate();
      if (!socket.destroyed) rejectUpgrade(socket, 502);
    } finally {
      upgradePending = false;
      release();
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const listen = (target: http.Server | net.Server, address: number | string, host?: string) =>
    new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      const ready = () => {
        target.removeListener("error", reject);
        resolve();
      };
      if (typeof address === "string") target.listen(address, ready);
      else target.listen(address, host, ready);
    });
  try {
    await listen(registry, config.socketPath);
    chmodSync(config.socketPath, 0o600);
    await listen(server, config.port, config.host);
    const port = (server.address() as net.AddressInfo).port;
    url = `http://${config.host === "::1" ? "[::1]" : config.host}:${port}/`;
    if (managementServer && config.management) {
      await listen(managementServer, config.management.port, "127.0.0.1");
      managementUrl = `http://127.0.0.1:${(managementServer.address() as net.AddressInfo).port}/`;
      const chatOrigins = [new URL(url).origin, ...(config.publicUrl ? [new URL(config.publicUrl).origin] : [])];
      if (
        [managementUrl, config.management.publicUrl].some(
          (value) => value && chatOrigins.includes(new URL(value).origin),
        )
      )
        throw new Error("Management origin must differ from chat origin");
    }
  } catch (error) {
    stopped = true;
    interactionApi?.close();
    versionStatus.close();
    for (const peer of peers) peer.destroy();
    for (const connection of connections) connection.destroy();
    await Promise.all([
      new Promise<void>((resolve) => registry.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
      ...(managementServer ? [new Promise<void>((resolve) => managementServer.close(() => resolve()))] : []),
    ]);
    throw error;
  }
  const sweep = setInterval(
    () => {
      for (const id of sessions.keys()) current(id);
      pruneHandoffs();
      for (const [generation, item] of restarting)
        if (item.deadline !== undefined && item.deadline <= Date.now()) restarting.delete(generation);
    },
    Math.min(1000, config.leaseMs),
  );
  sweep.unref();
  let closing: Promise<void> | undefined;
  return {
    url,
    ...(managementUrl ? { managementUrl } : {}),
    socketPath: config.socketPath,
    /** Host-local launcher lookup only; never exposes a registration token. */
    sessionPath(runId: string): string | undefined {
      const matches = [...sessions.values()].filter(session => session.grant.run_id === runId && session.expires > Date.now());
      return !stopped && matches.length === 1 ? `/s/${matches[0].generation}/` : undefined;
    },
    /** Local readiness only; never exposed as a public control-plane endpoint. */
    async isRunReady(runId: string): Promise<boolean> {
      if (stopped || !/^[a-f0-9]{32}$/.test(runId)) return false;
      // Unlike current()/verified(), this observation must not retire sessions
      // or write bounded state. Normal registry/sweep lifecycle owns retirement.
      const matches = [...sessions.values()].filter(s => s.grant.run_id === runId);
      if (matches.length !== 1) return false;
      const session = matches[0];
      const live = () => {
        if (stopped || session.expires <= Date.now() || sessions.get(session.generation) !== session) return false;
        const grant = readGrant(config, runId);
        return !grant.revoked && equal(grant.token, session.grant.token) && grant.backendHost === session.grant.backendHost;
      };
      try { return live() && await proof(session.grant, session.generation, session.port) && live(); } catch { return false; }
    },
    close() {
      if (closing) return closing;
      stopped = true;
      interactionApi?.close();
      handoffs.clear();
      versionStatus.close();
      clearInterval(sweep);
      for (const id of sessions.keys()) retire(id);
      for (const peer of peers) peer.destroy();
      for (const connection of connections) connection.destroy();
      server.closeAllConnections();
      managementServer?.closeAllConnections();
      closing = Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => registry.close(() => resolve())),
        new Promise<void>((resolve) => wss.close(() => resolve())),
        ...(managementServer ? [new Promise<void>((resolve) => managementServer.close(() => resolve()))] : []),
        pending,
      ]).then(() => {});
      return closing;
    },
  };
}
