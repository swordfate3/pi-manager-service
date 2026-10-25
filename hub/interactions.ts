import type { IncomingMessage, ServerResponse } from "node:http";
import { HUB_GENERATION_SOURCE } from "../protocol/hub-generation.ts";
import {
  canonicalJson,
  contentDigest,
  exactKeys,
  INTERACTION_LIMITS,
  opaqueId,
  plainRecord,
  safeLabel,
} from "../protocol/interactions/protocol.ts";
import type { HubConfig } from "./config.ts";
import { type InteractionChannel, type InteractionTarget, openInteractionControl } from "./interaction-control.ts";
import { interactionSigning } from "./interaction-signing.ts";
import type { HubManagement } from "./management.ts";

type Hooks = {
  lookup: (generation: string) => Promise<InteractionTarget | undefined>;
  current: (target: InteractionTarget) => boolean;
  generations?: () => string[];
};
type ChannelRecord = {
  target: InteractionTarget;
  promise: Promise<InteractionChannel>;
  channel?: InteractionChannel;
  count: number;
};
const sameTarget = (a: InteractionTarget, b: InteractionTarget) =>
  canonicalJson(a.identity) === canonicalJson(b.identity) &&
  a.backendHost === b.backendHost &&
  a.port === b.port &&
  a.token === b.token;

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", errorHandler);
      request.off("aborted", errorHandler);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > INTERACTION_LIMITS.requestBytes) finish(new Error());
      else chunks.push(chunk);
    };
    const end = () => finish();
    const errorHandler = () => finish(new Error());
    const timer = setTimeout(errorHandler, 5000);
    request.on("data", data);
    request.once("end", end);
    request.once("error", errorHandler);
    request.once("aborted", errorHandler);
  });
  const value = JSON.parse(bytes.toString("utf8"));
  canonicalJson(value);
  if (!plainRecord(value)) throw new Error();
  return value;
}

/** Transient only: private bodies are never written to Hub state or session history. */
export function createInteractionApi(config: HubConfig, management: HubManagement, hooks: Hooks) {
  const signing = config.management ? interactionSigning(config) : undefined;
  const channels = new Map<string, ChannelRecord>();
  let closed = false;
  let enumerating = false;
  const retire = (generation: string) => {
    const record = channels.get(generation);
    if (!record) return;
    channels.delete(generation);
    record.channel?.close();
    void record.promise.then((channel) => channel.close()).catch(() => {});
  };
  const timer = setInterval(() => {
    for (const [generation, record] of channels)
      if (!hooks.current(record.target) || (record.channel && !record.channel.active())) retire(generation);
  }, 1000);
  timer.unref();
  const channelFor = async (generation: string, revalidate: () => void) => {
    if (!signing || closed) throw new Error();
    const target = await hooks.lookup(generation);
    revalidate();
    if (!target || !hooks.current(target)) throw new Error();
    let record = channels.get(generation);
    if (record && (!sameTarget(record.target, target) || (record.channel && !record.channel.active()))) {
      retire(generation);
      record = undefined;
    }
    if (!record) {
      if (channels.size >= 64) throw new Error();
      const created = { target, count: 0 } as ChannelRecord;
      channels.set(generation, created);
      created.promise = openInteractionControl(
        target,
        signing,
        () => !closed && channels.get(generation) === created && hooks.current(target),
        (items) => {
          for (const item of items) {
            if (!plainRecord(item)) return false;
            exactKeys(item, ["requestId", "adapterId", "action", "classification", "state", "deadline"]);
            if (
              !opaqueId(item.requestId) ||
              !safeLabel(item.adapterId, 64) ||
              !safeLabel(item.action, 64) ||
              !["session", "sensitive"].includes(String(item.classification)) ||
              item.state !== "pending" ||
              !Number.isSafeInteger(item.deadline)
            )
              return false;
          }
          const total = [...channels.values()].reduce(
            (sum, peer) => sum + (peer === created ? 0 : peer.count),
            items.length,
          );
          // Each source body <=64KiB, so this also caps aggregate pending payload
          // at 64 * 64KiB = 4MiB without retaining private previews in the pool.
          if (total > INTERACTION_LIMITS.pendingPerHub) return false;
          created.count = items.length;
          return true;
        },
      )
        .then((channel) => {
          if (closed || channels.get(generation) !== created || !hooks.current(target)) {
            channel.close();
            throw new Error();
          }
          created.channel = channel;
          return channel;
        })
        .catch(() => {
          if (channels.get(generation) === created) channels.delete(generation);
          throw new Error("Interaction channel unavailable");
        });
      record = created;
    }
    const channel = await record.promise;
    revalidate();
    if (!hooks.current(target)) throw new Error();
    return channel;
  };
  const pattern = new RegExp(`^/api/management/interactions/(${HUB_GENERATION_SOURCE})/([a-f0-9]{32})$`);
  return {
    retire,
    close() {
      closed = true;
      clearInterval(timer);
      for (const generation of [...channels.keys()]) retire(generation);
    },
    async handle(request: IncomingMessage, response: ServerResponse, sameOrigin: boolean): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://hub.invalid");
      const inbox = url.pathname === "/api/management/interactions";
      if (!inbox && !url.pathname.startsWith("/api/management/interactions/")) return false;
      const reply = (status: number, body: unknown) =>
        response
          .writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          })
          .end(JSON.stringify(body));
      const match = pattern.exec(url.pathname);
      if ((!match && !inbox) || url.search || !signing) {
        reply(404, { error: "Interaction route unavailable" });
        return true;
      }
      if ((request.method !== "GET" && request.method !== "POST") || (inbox && request.method !== "GET")) {
        reply(405, { error: "Method not allowed" });
        return true;
      }
      if (!sameOrigin) {
        reply(403, { error: "Trusted management origin required" });
        return true;
      }
      let authorized = false;
      try {
        const write = request.method === "POST";
        const auth = management.authorize(request, write);
        const revalidate = () => {
          authorized = false;
          management.revalidate(request, auth, write);
          authorized = true;
        };
        authorized = true;
        if (inbox) {
          if (enumerating) {
            reply(503, { error: "Interaction inbox already being checked" });
            return true;
          }
          enumerating = true;
          try {
            const deadline = Date.now() + 4500;
            const withinDeadline = <T>(operation: Promise<T>) =>
              new Promise<T>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Inbox deadline reached")),
                  Math.max(1, deadline - Date.now()),
                );
                operation.then(resolve, reject).finally(() => clearTimeout(timer));
              });
            const all = [...new Set(hooks.generations?.() ?? [])];
            const queue = all.slice(0, 64);
            const batches: {
              generation: string;
              record: ChannelRecord;
              channel: InteractionChannel;
              items: Record<string, unknown>[];
            }[] = [];
            let collected = 0;
            let unavailable = 0;
            let truncated = all.length > queue.length;
            let cursor = 0;
            await Promise.all(
              Array.from({ length: Math.min(4, queue.length) }, async () => {
                while (cursor < queue.length && Date.now() < deadline && !request.destroyed) {
                  const generation = queue[cursor++];
                  try {
                    const channel = await withinDeadline(channelFor(generation, revalidate));
                    const record = channels.get(generation);
                    if (!record || record.channel !== channel) throw new Error();
                    const status = await withinDeadline(channel.status());
                    revalidate();
                    if (!channel.active()) throw new Error();
                    if (
                      !plainRecord(status) ||
                      !Array.isArray(status.pending) ||
                      status.pending.length > INTERACTION_LIMITS.pendingPerHub
                    )
                      throw new Error();
                    const items: Record<string, unknown>[] = [];
                    for (const item of status.pending) {
                      if (
                        !plainRecord(item) ||
                        !opaqueId(item.requestId) ||
                        !safeLabel(item.adapterId, 64) ||
                        !safeLabel(item.action, 64) ||
                        !Number.isSafeInteger(item.deadline)
                      )
                        throw new Error();
                      if (Number(item.deadline) <= Date.now()) continue;
                      if (collected + items.length >= INTERACTION_LIMITS.pendingPerHub) {
                        truncated = true;
                        break;
                      }
                      items.push({
                        generation,
                        requestId: item.requestId,
                        adapterId: item.adapterId,
                        action: item.action,
                        deadline: item.deadline,
                        path: `/interactions/${generation}/${item.requestId}/`,
                      });
                    }
                    collected += items.length;
                    batches.push({ generation, record, channel, items });
                  } catch {
                    revalidate();
                    unavailable++;
                  }
                }
              }),
            );
            unavailable += queue.length - cursor;
            revalidate();
            // Other sources may have waited after this batch was collected.
            // Fence the exact original target/channel and deadlines at the final
            // response boundary; never look up a replacement or await here.
            const items: Record<string, unknown>[] = [];
            const now = Date.now();
            for (const batch of batches) {
              if (
                channels.get(batch.generation) !== batch.record ||
                batch.record.channel !== batch.channel ||
                !hooks.current(batch.record.target) ||
                !batch.channel.active()
              ) {
                unavailable++;
                continue;
              }
              for (const item of batch.items) if (Number(item.deadline) > now) items.push(item);
            }
            reply(200, { items, unavailable, truncated });
            return true;
          } finally {
            enumerating = false;
          }
        }
        if (!match) throw new Error();
        const channel = await channelFor(match[1], revalidate);
        if (!write) {
          const status = (await channel.status(match[2])) as { completed?: Record<string, unknown>[] };
          revalidate();
          const receipt = status.completed?.[0];
          if (receipt) {
            reply(200, { state: receipt.state, ...(receipt.outcome ? { outcome: receipt.outcome } : {}) });
            return true;
          }
          const live = await channel.read(match[2]);
          revalidate();
          reply(200, live);
          return true;
        }
        const value = await readBody(request);
        revalidate();
        exactKeys(value, ["decisionId", "digest", "revision", "answer"]);
        if (!opaqueId(value.decisionId) || !opaqueId(value.digest, 64) || !safeLabel(value.revision)) throw new Error();
        // A completed delivery can only be queried by its exact old decision.
        // Never turn a missing preview into a replacement operation.
        const status = (await channel.status(match[2])) as { completed?: Record<string, unknown>[] };
        revalidate();
        const receipt = status.completed?.[0];
        if (receipt) {
          if (
            receipt.decisionId !== value.decisionId ||
            receipt.digest !== value.digest ||
            receipt.revision !== value.revision ||
            receipt.responseDigest !== contentDigest(value.answer)
          )
            throw new Error();
          reply(200, { state: receipt.state, ...(receipt.outcome ? { outcome: receipt.outcome } : {}) });
          return true;
        }
        const live = await channel.read(match[2]);
        revalidate();
        if (live.digest !== value.digest || live.revision !== value.revision) throw new Error();
        // Revalidation immediately precedes signing/delivery; no await is hidden
        // between the human authorization check and the channel's send.
        const state = await channel.decide(live, value.answer, value.decisionId);
        revalidate();
        reply(200, { state });
      } catch {
        reply(authorized ? 409 : 401, {
          error: authorized
            ? "Interaction changed or delivery unknown; check the original operation before retrying"
            : "Management authorization required",
        });
      }
      return true;
    },
  };
}
