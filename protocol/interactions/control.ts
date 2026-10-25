import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BrokerControl, InteractionBroker } from "./broker.ts";
import { canonicalJson, exactKeys, opaqueId, plainRecord } from "./protocol.ts";

export const INTERACTION_CONTROL_PATH = "/.pi-web-interactions";
export const INTERACTION_FRAME_BYTES = 72 * 1024;

/** Separate private transport. HTTP/run authentication never substitutes for the pinned signature. */
export function createInteractionControlServer(options: {
  broker: () => InteractionBroker | undefined;
  identity?: () => unknown;
  authorize: (request: IncomingMessage) => boolean;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: INTERACTION_FRAME_BYTES, perMessageDeflate: false });
  const peers = new Map<
    WebSocket,
    {
      broker: InteractionBroker;
      control?: BrokerControl;
      identity: unknown;
      timer?: ReturnType<typeof setTimeout>;
      alive: boolean;
    }
  >();
  const send = (socket: WebSocket, value: unknown) => {
    const bytes = JSON.stringify(value);
    if (
      socket.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(bytes) > INTERACTION_FRAME_BYTES ||
      socket.bufferedAmount > 256 * 1024
    ) {
      socket.terminate();
      return;
    }
    socket.send(bytes);
  };
  const notices = (broker: InteractionBroker) =>
    broker.pending().map((entry) => ({
      requestId: entry.requestId,
      adapterId: entry.adapterId,
      action: entry.action,
      classification: entry.classification,
      state: entry.state,
      deadline: entry.deadline,
    }));
  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) {
      if (!peer.alive) {
        socket.terminate();
        continue;
      }
      peer.alive = false;
      socket.ping();
    }
  }, 20_000);
  heartbeat.unref();
  wss.on("connection", (socket) => {
    const broker = options.broker();
    if (!broker) {
      socket.terminate();
      return;
    }
    const identity = broker.getIdentity();
    const challenge = broker.issueControlChallenge();
    const peer = { broker, identity, alive: true } as typeof peers extends Map<WebSocket, infer T> ? T : never;
    peer.timer = setTimeout(() => socket.terminate(), 5000);
    peers.set(socket, peer);
    send(socket, { type: "challenge", identity, challenge });
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.once("close", () => {
      clearTimeout(peer.timer);
      peers.delete(socket);
      peer.control?.close();
    });
    socket.on("message", (raw, binary) => {
      if (binary || options.broker() !== broker || canonicalJson(broker.getIdentity()) !== canonicalJson(identity)) {
        socket.terminate();
        return;
      }
      let id: string | undefined;
      try {
        const frame = JSON.parse(raw.toString());
        if (!plainRecord(frame)) throw new Error();
        if (!peer.control) {
          exactKeys(frame, ["type", "evidence"]);
          if (frame.type !== "authenticate") throw new Error();
          peer.control = broker.connectControl(challenge, frame.evidence);
          clearTimeout(peer.timer);
          peer.timer = undefined;
          send(socket, { type: "ready" });
          send(socket, { type: "pending", items: notices(broker) });
          return;
        }
        if (!opaqueId(frame.id)) throw new Error();
        id = frame.id;
        let result: unknown;
        if (frame.type === "read") {
          exactKeys(frame, ["type", "id", "requestId", "evidence"]);
          if (!opaqueId(frame.requestId)) throw new Error();
          result = peer.control.read(frame.requestId, frame.evidence);
        } else if (frame.type === "decision") {
          exactKeys(frame, ["type", "id", "evidence"]);
          result = peer.control.decide(frame.evidence);
        } else if (frame.type === "status") {
          exactKeys(frame, ["type", "id"], ["requestId"]);
          if (frame.requestId !== undefined && !opaqueId(frame.requestId)) throw new Error();
          result = {
            pending: notices(broker),
            completed:
              frame.requestId === undefined
                ? []
                : broker.completions().filter((entry) => entry.requestId === frame.requestId),
          };
        } else throw new Error();
        send(socket, { type: "result", id, ok: true, result });
      } catch {
        if (!peer.control || !id) socket.terminate();
        else send(socket, { type: "result", id, ok: false, error: "Interaction unavailable or changed" });
      }
    });
  });
  return {
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      if (request.url !== INTERACTION_CONTROL_PATH) return false;
      if (!options.broker() || request.headers.origin !== undefined || !options.authorize(request) || peers.size >= 2) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
      return true;
    },
    notify() {
      for (const [socket, peer] of peers) {
        if (
          options.broker() !== peer.broker ||
          canonicalJson(peer.broker.getIdentity()) !== canonicalJson(peer.identity) ||
          (peer.control && !peer.control.active())
        ) {
          socket.terminate();
          continue;
        }
        if (peer.control) send(socket, { type: "pending", items: notices(peer.broker) });
      }
    },
    close() {
      clearInterval(heartbeat);
      for (const [socket, peer] of peers) {
        clearTimeout(peer.timer);
        peer.control?.close();
        socket.terminate();
      }
      peers.clear();
      wss.close();
    },
  };
}
