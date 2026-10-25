import { type KeyObject, randomBytes } from "node:crypto";
import { type InteractionClaim, verifyInteractionEvidence } from "./proof.ts";
import {
  type AdapterIdentity,
  canonicalJson,
  contentDigest,
  createInteractionRequest,
  exactKeys,
  INTERACTION_LIMITS,
  type InteractionAnswer,
  type InteractionIdentity,
  type InteractionRequest,
  type InteractionSpec,
  type InteractionState,
  invalidInteraction,
  opaqueId,
  plainRecord,
  publicInteraction,
  validateAdapter,
  validateAnswer,
  validateIdentity,
} from "./protocol.ts";

export type AdapterManifest = AdapterIdentity & {
  actions: Record<string, { classification: InteractionSpec["classification"]; method: InteractionSpec["method"] }>;
};
export type InteractionResult = {
  state: InteractionState;
  winner?: "local" | "web";
  answer?: InteractionAnswer;
};
export type SourceRequestOptions = {
  isCurrent: () => boolean;
  signal?: AbortSignal;
  local?: (signal: AbortSignal) => Promise<InteractionAnswer | undefined>;
  operationId?: string;
};
export type SourceRequestHandle = {
  request: InteractionRequest;
  result: Promise<InteractionResult>;
  cancel: () => void;
  reportOutcome: (outcome: "succeeded" | "failed" | "cancelled") => void;
};
export type SourceAdapter = {
  active: () => boolean;
  request: (spec: InteractionSpec, options: SourceRequestOptions) => SourceRequestHandle;
  dispose: () => void;
};
export type BrokerControl = {
  active: () => boolean;
  read: (requestId: string, proof: unknown) => InteractionRequest;
  decide: (proof: unknown) => InteractionState;
  close: () => void;
};
type Completed = {
  requestId: string;
  operationId: string;
  adapterId: string;
  adapterVersion: string;
  classification: InteractionSpec["classification"];
  revision: string;
  digest: string;
  state: InteractionState;
  expiresAt: number;
  decisionId?: string;
  responseDigest?: string;
  outcome?: "succeeded" | "failed" | "cancelled";
};
type Entry = {
  request: InteractionRequest;
  adapter: symbol;
  options: SourceRequestOptions;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: InteractionResult) => void;
  abort?: () => void;
};

/** Source-owned operations only; this class never executes a tool or writes a source store. */
export class InteractionBroker {
  private identity: InteractionIdentity;
  private readonly now: () => number;
  private readonly pin?: { issuer: string; publicKey: KeyObject | string };
  private readonly onChange?: () => void;
  private readonly adapters = new Map<string, { token: symbol; manifest: AdapterManifest }>();
  private readonly entries = new Map<string, Entry>();
  private readonly completed = new Map<string, Completed>();
  private challenge?: { value: string; expiresAt: number };
  private channel?: { token: symbol; challenge: string; epoch: string };
  private closed = false;

  constructor(
    identity: InteractionIdentity,
    options: {
      pin?: { issuer: string; publicKey: KeyObject | string };
      now?: () => number;
      onChange?: () => void;
    } = {},
  ) {
    validateIdentity(identity);
    this.identity = structuredClone(identity);
    this.now = options.now ?? Date.now;
    this.pin = options.pin;
    this.onChange = options.onChange;
  }

  private changed() {
    // Consumers may notify UI; an observer cannot undo an already settled operation.
    try {
      this.onChange?.();
    } catch {
      /* No raw extension error text on public transport. */
    }
  }

  registerAdapter(manifest: AdapterManifest): SourceAdapter {
    canonicalJson(manifest);
    const { actions, ...identity } = manifest;
    validateAdapter(identity);
    if (
      this.closed ||
      this.adapters.has(identity.id) ||
      this.adapters.size >= 32 ||
      !plainRecord(actions) ||
      Object.keys(actions).length === 0 ||
      Object.keys(actions).length > 32
    )
      invalidInteraction();
    for (const [action, policy] of Object.entries(actions)) {
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(action) || !plainRecord(policy)) invalidInteraction();
      exactKeys(policy, ["classification", "method"]);
      if (
        !["session", "sensitive"].includes(policy.classification) ||
        !["confirm", "select", "input", "editor"].includes(policy.method)
      )
        invalidInteraction();
    }
    const registered = { token: Symbol(identity.id), manifest: structuredClone(manifest) };
    this.adapters.set(identity.id, registered);
    this.changed();
    return {
      active: () => !this.closed && this.adapters.get(identity.id) === registered,
      request: (spec, options) => {
        if (this.adapters.get(identity.id) !== registered) invalidInteraction();
        const policy = registered.manifest.actions[spec.action];
        if (!policy || policy.classification !== spec.classification || policy.method !== spec.method)
          invalidInteraction();
        return this.start(identity, registered.token, spec, options);
      },
      dispose: () => {
        if (this.adapters.get(identity.id) !== registered) return;
        this.adapters.delete(identity.id);
        for (const entry of [...this.entries.values()])
          if (entry.adapter === registered.token) this.settle(entry, { state: "stale" });
        this.changed();
      },
    };
  }

  private start(
    adapter: AdapterIdentity,
    token: symbol,
    spec: InteractionSpec,
    options: SourceRequestOptions,
  ): SourceRequestHandle {
    this.sweep();
    if (this.closed || this.entries.size >= INTERACTION_LIMITS.pendingPerPi || typeof options.isCurrent !== "function")
      invalidInteraction();
    const request = createInteractionRequest(this.identity, adapter, spec, this.now(), options.operationId);
    if (
      [...this.entries.values()].some((entry) => entry.request.operationId === request.operationId) ||
      [...this.completed.values()].some((entry) => entry.operationId === request.operationId)
    )
      invalidInteraction();
    let resolve: (result: InteractionResult) => void = () => {};
    const result = new Promise<InteractionResult>((done) => {
      resolve = done;
    });
    const controller = new AbortController();
    const entry: Entry = {
      request,
      adapter: token,
      options,
      controller,
      resolve,
      timer: setTimeout(() => this.settle(entry, { state: "expired" }), Math.max(1, request.deadline - this.now())),
    };
    entry.timer.unref();
    this.entries.set(request.requestId, entry);
    if (options.signal) {
      entry.abort = () => this.settle(entry, { state: "cancelled" });
      options.signal.addEventListener("abort", entry.abort, { once: true });
    }
    if (options.signal?.aborted) this.settle(entry, { state: "cancelled" });
    else if (!this.current(entry)) this.settle(entry, { state: "stale" });
    else {
      this.changed();
      if (options.local)
        void Promise.resolve().then(async () => {
          if (!this.entries.has(request.requestId) || controller.signal.aborted) return;
          try {
            const answer = await options.local?.(controller.signal);
            if (!this.entries.has(request.requestId)) return;
            if (answer === undefined) this.settle(entry, { state: "cancelled" });
            else {
              const valid = validateAnswer(request.schema, answer);
              this.settle(entry, { state: valid === false ? "rejected" : "allowed", winner: "local", answer: valid });
            }
          } catch {
            this.settle(entry, { state: "cancelled" });
          }
        });
    }
    return {
      request: structuredClone(request),
      result,
      cancel: () => this.settle(entry, { state: "cancelled" }),
      reportOutcome: (outcome) => {
        this.sweep();
        if (!["succeeded", "failed", "cancelled"].includes(outcome)) invalidInteraction();
        const receipt = this.completed.get(request.requestId);
        if (!receipt || receipt.state !== "allowed" || receipt.outcome) invalidInteraction();
        receipt.outcome = outcome;
        this.changed();
      },
    };
  }

  private current(entry: Entry) {
    try {
      return entry.options.isCurrent() === true;
    } catch {
      return false;
    }
  }

  private settle(entry: Entry, result: InteractionResult, decision?: { id: string; responseDigest: string }) {
    if (this.entries.get(entry.request.requestId) !== entry) return;
    if ((result.state === "allowed" || result.state === "rejected") && !this.current(entry))
      result = { state: "stale" };
    else if (entry.request.deadline <= this.now()) result = { state: "expired" };
    // Delete before aborting: a synchronous local abort handler cannot win a second time.
    this.entries.delete(entry.request.requestId);
    clearTimeout(entry.timer);
    if (entry.abort) entry.options.signal?.removeEventListener("abort", entry.abort);
    const request = entry.request;
    this.completed.set(request.requestId, {
      requestId: request.requestId,
      operationId: request.operationId,
      adapterId: request.adapter.id,
      adapterVersion: request.adapter.version,
      classification: request.classification,
      revision: request.revision,
      digest: request.digest,
      state: result.state,
      expiresAt: this.now() + INTERACTION_LIMITS.completedMs,
      ...(decision ? { decisionId: decision.id, responseDigest: decision.responseDigest } : {}),
    });
    this.trimCompleted();
    entry.controller.abort();
    entry.resolve(result);
    this.changed();
  }

  private trimCompleted() {
    const now = this.now();
    for (const [id, entry] of this.completed) if (entry.expiresAt <= now) this.completed.delete(id);
    const bytes = () => Buffer.byteLength(JSON.stringify([...this.completed.values()]));
    while (this.completed.size > INTERACTION_LIMITS.completedCount || bytes() > INTERACTION_LIMITS.completedBytes) {
      const first = this.completed.keys().next().value;
      if (first === undefined) break;
      this.completed.delete(first);
    }
  }

  private sweep() {
    for (const entry of [...this.entries.values()]) {
      if (entry.request.deadline <= this.now()) this.settle(entry, { state: "expired" });
      else if (!this.current(entry)) this.settle(entry, { state: "stale" });
    }
    this.trimCompleted();
  }

  pending() {
    this.sweep();
    return [...this.entries.values()].map((entry) => publicInteraction(entry.request, "pending"));
  }

  capabilities() {
    return [...this.adapters.values()].map(({ manifest }) => structuredClone(manifest));
  }

  getIdentity() {
    return structuredClone(this.identity);
  }

  invalidatePending() {
    for (const entry of [...this.entries.values()]) this.settle(entry, { state: "stale" });
    this.channel = undefined;
    this.challenge = undefined;
    this.changed();
  }

  completions() {
    this.sweep();
    return structuredClone([...this.completed.values()]);
  }

  /** Chat transport can answer only explicitly source-classified ordinary choices. */
  decideSession(value: unknown): InteractionState {
    canonicalJson(value);
    if (!plainRecord(value) || this.closed) invalidInteraction();
    exactKeys(value, [
      "identity",
      "requestId",
      "operationId",
      "adapterId",
      "adapterVersion",
      "revision",
      "digest",
      "decisionId",
      "answer",
    ]);
    validateIdentity(value.identity);
    if (
      canonicalJson(value.identity) !== canonicalJson(this.identity) ||
      !opaqueId(value.requestId) ||
      !opaqueId(value.decisionId)
    )
      invalidInteraction();
    this.sweep();
    const entry = this.entries.get(value.requestId);
    const receipt = this.completed.get(value.requestId);
    const binding = entry
      ? {
          classification: entry.request.classification,
          operationId: entry.request.operationId,
          adapterId: entry.request.adapter.id,
          adapterVersion: entry.request.adapter.version,
          revision: entry.request.revision,
          digest: entry.request.digest,
        }
      : receipt;
    if (
      !binding ||
      binding.classification !== "session" ||
      (["operationId", "adapterId", "adapterVersion", "revision", "digest"] as const).some(
        (key) => binding[key] !== value[key],
      )
    )
      invalidInteraction();
    const responseDigest = contentDigest(value.answer);
    if (receipt) {
      if (["stale", "cancelled", "expired"].includes(receipt.state)) return receipt.state;
      if (receipt.decisionId !== value.decisionId || receipt.responseDigest !== responseDigest) invalidInteraction();
      return receipt.state;
    }
    if (!entry || [...this.completed.values()].some((item) => item.decisionId === value.decisionId))
      invalidInteraction();
    const answer = validateAnswer(entry.request.schema, value.answer);
    this.settle(
      entry,
      { state: answer === false ? "rejected" : "allowed", winner: "web", answer },
      { id: value.decisionId, responseDigest },
    );
    return this.completed.get(value.requestId)?.state ?? "delivery_unknown";
  }

  issueControlChallenge() {
    if (this.closed) invalidInteraction();
    const value = randomBytes(32).toString("hex");
    // A proposed channel cannot invalidate the established channel until it proves trust.
    this.challenge = { value, expiresAt: this.now() + 10_000 };
    return value;
  }

  private evidence(evidence: unknown, kind: InteractionClaim["kind"], challenge: string, epoch?: string) {
    if (!this.pin || this.closed) invalidInteraction();
    return verifyInteractionEvidence(evidence, {
      ...this.pin,
      identity: this.identity,
      kind,
      challenge,
      epoch,
      now: this.now(),
    });
  }

  connectControl(challenge: string, evidence: unknown): BrokerControl {
    if (!this.challenge || this.challenge.value !== challenge || this.challenge.expiresAt <= this.now())
      invalidInteraction();
    const claim = this.evidence(evidence, "control", challenge);
    exactKeys(claim.payload, []);
    this.challenge = undefined;
    if (this.channel) this.endChannel(this.channel.token);
    const channel = { token: Symbol("hub-control"), challenge, epoch: claim.epoch };
    this.channel = channel;
    const checked = (proof: unknown, kind: InteractionClaim["kind"]) => {
      if (this.channel !== channel) invalidInteraction();
      this.sweep();
      return this.evidence(proof, kind, channel.challenge, channel.epoch);
    };
    return {
      active: () => this.channel === channel && !this.closed,
      read: (requestId, proof) => {
        const read = checked(proof, "read");
        exactKeys(read.payload, ["requestId"]);
        if (!opaqueId(requestId) || read.payload.requestId !== requestId) invalidInteraction();
        const entry = this.entries.get(requestId);
        if (!entry) invalidInteraction();
        return structuredClone(entry.request);
      },
      decide: (proof) => {
        const decision = checked(proof, "decision");
        const value = decision.payload;
        exactKeys(value, [
          "requestId",
          "operationId",
          "adapterId",
          "adapterVersion",
          "revision",
          "digest",
          "decisionId",
          "answer",
        ]);
        if (!opaqueId(value.requestId) || !opaqueId(value.decisionId)) invalidInteraction();
        const entry = this.entries.get(value.requestId);
        const receipt = this.completed.get(value.requestId);
        const binding = entry
          ? {
              operationId: entry.request.operationId,
              adapterId: entry.request.adapter.id,
              adapterVersion: entry.request.adapter.version,
              revision: entry.request.revision,
              digest: entry.request.digest,
            }
          : receipt;
        if (
          !binding ||
          (["operationId", "adapterId", "adapterVersion", "revision", "digest"] as const).some(
            (key) => value[key] !== binding[key],
          )
        )
          invalidInteraction();
        const responseDigest = contentDigest(value.answer);
        if (receipt) {
          // A lifecycle/expiry winner may precede delivery. Report that terminal
          // state without treating the late signed decision as a consumed grant.
          if (["stale", "cancelled", "expired"].includes(receipt.state)) return receipt.state;
          if (receipt.decisionId !== value.decisionId || receipt.responseDigest !== responseDigest)
            invalidInteraction();
          return receipt.state;
        }
        if (!entry || [...this.completed.values()].some((completed) => completed.decisionId === value.decisionId))
          invalidInteraction();
        const answer = validateAnswer(entry.request.schema, value.answer);
        this.settle(
          entry,
          { state: answer === false ? "rejected" : "allowed", winner: "web", answer },
          { id: value.decisionId, responseDigest },
        );
        return this.completed.get(value.requestId)?.state ?? "delivery_unknown";
      },
      close: () => this.endChannel(channel.token),
    };
  }

  private endChannel(token: symbol) {
    if (this.channel?.token !== token) return;
    this.channel = undefined;
    this.challenge = undefined;
    for (const entry of [...this.entries.values()]) this.settle(entry, { state: "cancelled" });
  }

  replaceIdentity(identity: InteractionIdentity) {
    validateIdentity(identity);
    if (canonicalJson(identity) === canonicalJson(this.identity)) return;
    for (const entry of [...this.entries.values()]) this.settle(entry, { state: "stale" });
    this.channel = undefined;
    this.challenge = undefined;
    this.completed.clear();
    if (this.identity.runtimeId !== identity.runtimeId || this.identity.runId !== identity.runId) this.adapters.clear();
    this.identity = structuredClone(identity);
    this.changed();
  }

  close() {
    this.closed = true;
    this.channel = undefined;
    this.challenge = undefined;
    this.adapters.clear();
    for (const entry of [...this.entries.values()]) this.settle(entry, { state: "cancelled" });
    this.completed.clear();
  }
}
