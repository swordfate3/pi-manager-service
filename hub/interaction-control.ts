import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { WebSocket } from "ws";
import { INTERACTION_CONTROL_PATH, INTERACTION_FRAME_BYTES } from "../protocol/interactions/control.ts";
import {
  canonicalJson,
  INTERACTION_LIMITS,
  type InteractionIdentity,
  type InteractionRequest,
  type InteractionState,
  type Json,
  opaqueId,
  plainRecord,
  validateAnswer,
  validateIdentity,
  validateInteractionRequest,
} from "../protocol/interactions/protocol.ts";
import type { InteractionSigning } from "./interaction-signing.ts";

export type InteractionTarget = { identity: InteractionIdentity; backendHost: string; port: number; token: string };
export type InteractionChannel = {
  active: () => boolean;
  read: (requestId: string) => Promise<InteractionRequest>;
  decide: (request: InteractionRequest, answer: unknown, decisionId: string) => Promise<InteractionState>;
  status: (requestId?: string) => Promise<unknown>;
  close: () => void;
};
const unavailable = () => new Error("Private interaction channel unavailable or changed");

export function openInteractionControl(
  target: InteractionTarget,
  signing: Pick<InteractionSigning, "sign">,
  isCurrent: () => boolean,
  onPending?: (items: unknown[]) => boolean,
): Promise<InteractionChannel> {
  validateIdentity(target.identity);
  return new Promise((resolve, reject) => {
    const host = isIP(target.backendHost) === 6 ? `[${target.backendHost}]` : target.backendHost;
    const socket = new WebSocket(`ws://${host}:${target.port}${INTERACTION_CONTROL_PATH}`, {
      headers: {
        "x-pi-web-generation": target.identity.generation,
        "x-pi-web-proof": createHmac("sha256", target.token).update(target.identity.generation).digest("hex"),
      },
      maxPayload: INTERACTION_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    });
    let challenge: string | undefined;
    let ready = false;
    let closed = false;
    const pending = new Map<
      string,
      { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    const fail = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshake);
      socket.terminate();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(unavailable());
      }
      pending.clear();
      reject(unavailable());
    };
    const handshake = setTimeout(fail, 5000);
    const send = (frame: unknown) => {
      if (!isCurrent() || closed || socket.readyState !== WebSocket.OPEN) {
        fail();
        throw unavailable();
      }
      const bytes = JSON.stringify(frame);
      if (Buffer.byteLength(bytes) > INTERACTION_FRAME_BYTES || socket.bufferedAmount > 256 * 1024) {
        fail();
        throw unavailable();
      }
      socket.send(bytes);
    };
    const rpc = (type: string, args: Record<string, unknown> = {}) =>
      new Promise<unknown>((done, failed) => {
        if (!ready || pending.size >= 8) {
          failed(unavailable());
          return;
        }
        const id = randomBytes(16).toString("hex");
        const timer = setTimeout(() => {
          pending.delete(id);
          failed(unavailable());
        }, 5000);
        pending.set(id, { resolve: done, reject: failed, timer });
        try {
          send({ type, id, ...args });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          failed(unavailable());
        }
      });
    const evidence = (
      kind: "control" | "read" | "decision",
      payload: Record<string, Json>,
      deadline = Date.now() + 10_000,
    ) => {
      if (!challenge || !isCurrent() || closed) throw unavailable();
      const now = Date.now();
      return signing.sign({
        kind,
        identity: target.identity,
        challenge,
        issuedAt: now,
        expiresAt: Math.min(now + 10_000, deadline),
        payload,
      });
    };
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("message", (raw, binary) => {
      try {
        if (binary || !isCurrent() || closed) throw unavailable();
        const frame = JSON.parse(raw.toString());
        if (!plainRecord(frame)) throw unavailable();
        if (!ready) {
          if (frame.type === "challenge" && !challenge) {
            if (!opaqueId(frame.challenge, 64) || canonicalJson(frame.identity) !== canonicalJson(target.identity))
              throw unavailable();
            challenge = frame.challenge;
            send({ type: "authenticate", evidence: evidence("control", {}) });
            return;
          }
          if (frame.type !== "ready" || !challenge) throw unavailable();
          ready = true;
          clearTimeout(handshake);
          resolve({
            active: () => !closed && isCurrent(),
            read: async (requestId) => {
              if (!opaqueId(requestId)) throw unavailable();
              const request = validateInteractionRequest(
                await rpc("read", { requestId, evidence: evidence("read", { requestId }) }),
              );
              if (
                !isCurrent() ||
                request.requestId !== requestId ||
                canonicalJson(request.identity) !== canonicalJson(target.identity) ||
                request.deadline <= Date.now()
              )
                throw unavailable();
              return request;
            },
            decide: async (request, answer, decisionId) => {
              if (!opaqueId(decisionId) || canonicalJson(request.identity) !== canonicalJson(target.identity))
                throw unavailable();
              const valid = validateInteractionRequest(request);
              const value = validateAnswer(valid.schema, answer);
              const result = await rpc("decision", {
                evidence: evidence(
                  "decision",
                  {
                    requestId: valid.requestId,
                    operationId: valid.operationId,
                    adapterId: valid.adapter.id,
                    adapterVersion: valid.adapter.version,
                    revision: valid.revision,
                    digest: valid.digest,
                    decisionId,
                    answer: value,
                  },
                  valid.deadline,
                ),
              });
              if (
                !isCurrent() ||
                !["allowed", "rejected", "cancelled", "expired", "stale", "delivery_unknown"].includes(String(result))
              )
                throw unavailable();
              return result as InteractionState;
            },
            status: (requestId) => rpc("status", requestId === undefined ? {} : { requestId }),
            close: fail,
          });
          return;
        }
        if (frame.type === "pending") {
          if (
            !Array.isArray(frame.items) ||
            frame.items.length > INTERACTION_LIMITS.pendingPerPi ||
            (!onPending?.(frame.items) && onPending !== undefined)
          )
            throw unavailable();
          return;
        }
        if (frame.type !== "result" || !opaqueId(frame.id)) throw unavailable();
        const request = pending.get(frame.id);
        if (!request) return; // A timed-out RPC must never be replayed.
        clearTimeout(request.timer);
        pending.delete(frame.id);
        if (frame.ok === true) request.resolve(frame.result);
        else request.reject(unavailable());
      } catch {
        fail();
      }
    });
  });
}
