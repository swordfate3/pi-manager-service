import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { ManagerError } from "./validation.ts";

export interface HostRpcDialog {
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  deadline: number;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

type JsonRecord = Record<string, unknown>;
type DialogMethod = HostRpcDialog["method"];

interface PendingDialog {
  dialog: HostRpcDialog;
  sessionId: string;
  timer: NodeJS.Timeout;
  decisionId?: string;
}

interface StateQuery {
  timer: NodeJS.Timeout;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
}

interface CompletedDialog {
  decisionId?: string;
  expires: number;
}

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_ANSWER_BYTES = 4096;
const MAX_PENDING = 8;
const MAX_TIMEOUT_MS = 120_000;
const STATE_TIMEOUT_MS = 1500;
const COMPLETED_LIMIT = 128;
const COMPLETED_TTL_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METHODS = new Set<DialogMethod>(["confirm", "select", "input", "editor"]);

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function managerError(status: 400 | 409): ManagerError {
  return new ManagerError(status);
}

function boundedDialog(dialog: HostRpcDialog): HostRpcDialog | null {
  return Buffer.byteLength(JSON.stringify(dialog), "utf8") <= MAX_REQUEST_BYTES ? dialog : null;
}

export class LocalRpcDialogs {
  readonly #output: Readable;
  readonly #input: Writable;
  readonly #pending = new Map<string, PendingDialog>();
  readonly #admitting = new Map<string, HostRpcDialog>();
  readonly #scopes = new Map<string, string>();
  readonly #queries = new Map<string, StateQuery>();
  readonly #completed = new Map<string, CompletedDialog>();
  #buffer = Buffer.alloc(0);
  #discarding = false;
  #closed = false;

  readonly #onData = (chunk: Buffer | string) => this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  readonly #onOutputStop = () => this.close();
  readonly #onInputError = () => this.close();

  constructor(output: Readable, input: Writable) {
    this.#output = output;
    this.#input = input;
    output.on("data", this.#onData);
    output.on("error", this.#onOutputStop);
    output.on("end", this.#onOutputStop);
    input.on("error", this.#onInputError);
  }

  async snapshot(sessionId: string): Promise<HostRpcDialog | null> {
    this.#validateSessionArgument(sessionId);
    await this.#ensureSession(sessionId);
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (pending.dialog.deadline <= now) {
        this.#cancelPending(id);
        continue;
      }
      return { ...pending.dialog, options: pending.dialog.options ? [...pending.dialog.options] : undefined };
    }
    return null;
  }

  async respond(sessionId: string, body: unknown, authorize?: () => void): Promise<{ state: "delivered" }> {
    this.#validateSessionArgument(sessionId);
    const answer = this.#answer(body);
    const pending = this.#pending.get(answer.id);
    if (!pending || pending.sessionId !== sessionId || pending.decisionId || this.#decisionUsed(answer.decisionId)) throw managerError(409);
    if (answer.kind === "confirmed" && pending.dialog.method !== "confirm") throw managerError(400);
    if (answer.kind === "value") {
      if (pending.dialog.method === "confirm") throw managerError(400);
      if (pending.dialog.method === "select" && !pending.dialog.options?.includes(answer.value)) throw managerError(400);
    }

    pending.decisionId = answer.decisionId;
    await this.#ensureSession(sessionId);
    if (this.#pending.get(answer.id) !== pending || pending.dialog.deadline <= Date.now()) {
      if (this.#pending.get(answer.id) === pending) this.#cancelPending(answer.id);
      throw managerError(409);
    }

    // Recheck the owner's HTTP login and generation after asynchronous state I/O.
    authorize?.();
    clearTimeout(pending.timer);
    this.#pending.delete(answer.id);
    this.#remember(answer.id, answer.decisionId);
    const response = answer.kind === "confirmed"
      ? { type: "extension_ui_response", id: answer.id, confirmed: answer.value }
      : answer.kind === "value"
        ? { type: "extension_ui_response", id: answer.id, value: answer.value }
        : { type: "extension_ui_response", id: answer.id, cancelled: true };
    try {
      await this.#write(response);
    } catch {
      throw managerError(409);
    }
    return { state: "delivered" };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#output.off("data", this.#onData);
    this.#output.off("error", this.#onOutputStop);
    this.#output.off("end", this.#onOutputStop);
    this.#input.off("error", this.#onInputError);

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      this.#sendCancellation(pending.dialog.id);
    }
    this.#pending.clear();
    this.#admitting.clear();
    this.#scopes.clear();
    for (const query of this.#queries.values()) {
      clearTimeout(query.timer);
      query.reject(managerError(409));
    }
    this.#queries.clear();
    this.#completed.clear();
    this.#buffer = Buffer.alloc(0);
    this.#discarding = false;
  }

  #consume(chunk: Buffer): void {
    if (this.#closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#discarding) {
        const newline = chunk.indexOf(10, offset);
        if (newline < 0) return;
        this.#discarding = false;
        offset = newline + 1;
        continue;
      }

      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.#buffer.length + part.length > MAX_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0);
        if (newline < 0) {
          this.#discarding = true;
          return;
        }
        offset = newline + 1;
        continue;
      }
      if (part.length) this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, part]) : Buffer.from(part);
      if (newline < 0) return;

      let frame = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      if (frame.at(-1) === 13) frame = frame.subarray(0, -1);
      if (frame.length) this.#frame(frame);
      offset = newline + 1;
    }
  }

  #frame(frame: Buffer): void {
    let record: unknown;
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!object(record)) return;

    if (record.type === "extension_ui_request" && record.method === "setStatus" && record.statusText === undefined) {
      this.#lifecycle(record.statusKey);
      return;
    }

    if (record.type === "response") {
      this.#stateResponse(record);
      return;
    }
    if (record.type !== "extension_ui_request" || !METHODS.has(record.method as DialogMethod)) return;
    void this.#admit(record, frame.length);
  }

  async #admit(record: JsonRecord, frameBytes: number): Promise<void> {
    const id = safeId(record.id) ? record.id : undefined;
    if (!id) return;
    this.#pruneCompleted();
    if (this.#closed || this.#pending.has(id) || this.#admitting.has(id) || this.#completed.has(id)) return;
    const dialog = this.#dialog(record, frameBytes);
    if (!dialog) {
      this.#rejectSource(id);
      return;
    }
    if (this.#pending.size + this.#admitting.size >= MAX_PENDING) {
      this.#rejectSource(id);
      return;
    }

    this.#admitting.set(id, dialog);
    try {
      const sessionId = await this.#querySession();
      if (this.#closed || !this.#admitting.has(id)) return;
      const existingSession = this.#pending.values().next().value?.sessionId as string | undefined;
      if (existingSession !== undefined && existingSession !== sessionId) this.#cancelAll();
      if (dialog.deadline <= Date.now()) {
        this.#rejectSource(id);
        return;
      }
      const timer = setTimeout(() => this.#cancelPending(id), Math.max(0, dialog.deadline - Date.now()));
      timer.unref?.();
      this.#pending.set(id, { dialog, sessionId, timer });
    } catch {
      if (!this.#closed) this.#rejectSource(id);
    } finally {
      this.#admitting.delete(id);
    }
  }

  #dialog(record: JsonRecord, frameBytes: number): HostRpcDialog | null {
    if (frameBytes > MAX_REQUEST_BYTES || !safeId(record.id) || typeof record.title !== "string" || !METHODS.has(record.method as DialogMethod)) return null;
    if (Object.hasOwn(record, "timeout") && (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0)) return null;
    const timeout = typeof record.timeout === "number" ? Math.min(record.timeout, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
    const base: HostRpcDialog = { id: record.id, method: record.method as DialogMethod, title: record.title, deadline: Date.now() + timeout };
    switch (base.method) {
      case "confirm":
        if (typeof record.message !== "string") return null;
        return boundedDialog({ ...base, message: record.message });
      case "select":
        if (!Array.isArray(record.options) || record.options.length < 1 || record.options.length > 1000 || !record.options.every(option => typeof option === "string")) return null;
        return boundedDialog({ ...base, options: [...record.options] as string[] });
      case "input":
        if (record.placeholder !== undefined && typeof record.placeholder !== "string") return null;
        return boundedDialog({ ...base, placeholder: record.placeholder as string | undefined });
      case "editor":
        if (record.prefill !== undefined && typeof record.prefill !== "string") return null;
        return boundedDialog({ ...base, prefill: record.prefill as string | undefined });
    }
  }

  /** Matched Web emits clear-only status keys: no prompt body, visible status or RPC patch. */
  #lifecycle(key: unknown): void {
    if (typeof key !== "string") return;
    const ended = /^pi-web-host-rpc-ui-v1:end:([a-f0-9]{32})$/.exec(key);
    if (ended) {
      const id = this.#scopes.get(ended[1]); this.#scopes.delete(ended[1]);
      if (!id) return;
      if (this.#pending.has(id)) this.#cancelPending(id);
      else if (this.#admitting.delete(id)) this.#rejectSource(id);
      return;
    }
    const start = /^pi-web-host-rpc-ui-v1:start:([a-f0-9]{32}):(confirm|select|input|editor):([a-f0-9]{64})$/.exec(key);
    if (!start || this.#scopes.has(start[1]) || this.#scopes.size >= MAX_PENDING) return;
    const candidates = [...this.#pending.values()].map(p => p.dialog).concat([...this.#admitting.values()]);
    const selected = candidates.find(d => ![...this.#scopes.values()].includes(d.id) && d.method === start[2] &&
      createHash("sha256").update(d.title).digest("hex") === start[3]);
    if (selected) this.#scopes.set(start[1], selected.id);
  }

  #answer(body: unknown):
    | { id: string; decisionId: string; kind: "confirmed"; value: boolean }
    | { id: string; decisionId: string; kind: "value"; value: string }
    | { id: string; decisionId: string; kind: "cancelled" } {
    if (!object(body) || !safeId(body.id) || !safeId(body.decisionId)) throw managerError(400);
    const answerKeys = ["confirmed", "value", "cancelled"].filter(key => Object.hasOwn(body, key));
    const allowed = new Set(["id", "decisionId", ...answerKeys]);
    if (answerKeys.length !== 1 || Object.keys(body).some(key => !allowed.has(key))) throw managerError(400);
    if (answerKeys[0] === "confirmed") {
      if (typeof body.confirmed !== "boolean") throw managerError(400);
      return { id: body.id, decisionId: body.decisionId, kind: "confirmed", value: body.confirmed };
    }
    if (answerKeys[0] === "value") {
      if (typeof body.value !== "string" || Buffer.byteLength(body.value, "utf8") > MAX_ANSWER_BYTES) throw managerError(400);
      return { id: body.id, decisionId: body.decisionId, kind: "value", value: body.value };
    }
    if (body.cancelled !== true) throw managerError(400);
    return { id: body.id, decisionId: body.decisionId, kind: "cancelled" };
  }

  async #ensureSession(expected: string): Promise<void> {
    if (this.#closed) throw managerError(409);
    let current: string;
    try {
      current = await this.#querySession();
    } catch {
      this.#cancelAll();
      throw managerError(409);
    }
    let sourceChanged = false;
    for (const [id, pending] of [...this.#pending]) {
      if (pending.sessionId === current) continue;
      sourceChanged = true;
      this.#cancelPending(id);
    }
    if (current !== expected || sourceChanged) throw managerError(409);
  }

  #querySession(): Promise<string> {
    if (this.#closed || !this.#writerUsable()) return Promise.reject(managerError(409));
    const id = `pi-host-ui-state-${randomUUID()}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const query = this.#queries.get(id);
        if (!query) return;
        this.#queries.delete(id);
        reject(managerError(409));
      }, STATE_TIMEOUT_MS);
      this.#queries.set(id, { timer, resolve, reject });
      void this.#write({ type: "get_state", id }).catch(() => {
        const query = this.#queries.get(id);
        if (!query) return;
        clearTimeout(query.timer);
        this.#queries.delete(id);
        query.reject(managerError(409));
      });
    });
  }

  #stateResponse(record: JsonRecord): void {
    if (typeof record.id !== "string") return;
    const query = this.#queries.get(record.id);
    if (!query) return;
    clearTimeout(query.timer);
    this.#queries.delete(record.id);
    if (record.command === "get_state" && record.success === true && object(record.data) && typeof record.data.sessionId === "string" && record.data.sessionId.length > 0) {
      query.resolve(record.data.sessionId);
    } else {
      query.reject(managerError(409));
    }
  }

  #cancelAll(): void {
    for (const id of [...this.#pending.keys()]) this.#cancelPending(id);
  }

  #cancelPending(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    this.#remember(id, pending.decisionId);
    this.#sendCancellation(id);
  }

  #rejectSource(id: string): void {
    if (this.#closed) return;
    this.#remember(id);
    this.#sendCancellation(id);
  }

  #sendCancellation(id: string): void {
    if (!this.#writerUsable()) return;
    try {
      this.#input.write(JSON.stringify({ type: "extension_ui_response", id, cancelled: true }) + "\n", () => undefined);
    } catch {
      // A disappearing child is already a safe rejection; never signal or kill it here.
    }
  }

  #write(record: JsonRecord): Promise<void> {
    if (this.#closed || !this.#writerUsable()) return Promise.reject(managerError(409));
    const line = JSON.stringify(record) + "\n";
    return new Promise<void>((resolve, reject) => {
      try {
        this.#input.write(line, error => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  #writerUsable(): boolean {
    return !this.#input.destroyed && !this.#input.writableEnded && !this.#input.writableFinished;
  }

  #decisionUsed(decisionId: string): boolean {
    this.#pruneCompleted();
    for (const pending of this.#pending.values()) if (pending.decisionId === decisionId) return true;
    for (const completed of this.#completed.values()) if (completed.decisionId === decisionId) return true;
    return false;
  }

  #remember(id: string, decisionId?: string): void {
    this.#pruneCompleted();
    this.#completed.delete(id);
    this.#completed.set(id, { decisionId, expires: Date.now() + COMPLETED_TTL_MS });
    while (this.#completed.size > COMPLETED_LIMIT) {
      const oldest = this.#completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
  }

  #pruneCompleted(): void {
    const now = Date.now();
    for (const [id, completed] of this.#completed) if (completed.expires <= now) this.#completed.delete(id);
  }

  #validateSessionArgument(sessionId: string): void {
    if (typeof sessionId !== "string" || sessionId.length === 0 || Buffer.byteLength(sessionId, "utf8") > 4096) throw managerError(400);
  }
}
