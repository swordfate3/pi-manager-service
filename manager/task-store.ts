import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  TASK_STATES,
  type JsonValue,
  type TaskRecord,
  type TaskRequest,
  type TaskState,
  type TaskStoreOpenOptions,
  type TaskTransitionOptions,
} from "./contracts.ts";

interface StoredState {
  schemaVersion: 1;
  tasks: Record<string, TaskRecord>;
  idempotency: Record<string, Record<string, string>>;
}

interface LockOwner {
  schemaVersion: 1;
  pid: number;
  processIdentity: string | null;
  token: string;
  createdAt: string;
}

interface OwnedLock {
  directory: string;
  token: string;
}

interface AcquiredWriterLock {
  lock: OwnedLock;
}

interface RecoveryMarker {
  schemaVersion: 1;
  reason: "stale-writer";
  createdAt: string;
}

const STATE_FILE = "tasks.json";
const LOCK_DIRECTORY = ".task-store.lock";
const ACQUISITION_DIRECTORY = ".task-store.acquire";
const RECOVERY_FILE = ".task-store.recovery.json";
const OWNER_FILE = "owner.json";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const MAX_RECOVERY_BYTES = 4 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

const taskStateSet = new Set<string>(TASK_STATES);
const resultStates = new Set<TaskState>(["succeeded", "failed", "cancelled", "unknown"]);
const allowedTransitions: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  pending_approval: new Set(["queued", "cancelled"]),
  queued: new Set(["waiting_idle", "running", "cancelled"]),
  waiting_idle: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled", "unknown"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  unknown: new Set(),
};

export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class TaskStoreLockedError extends TaskStoreError {}
export class TaskStoreRecoveryRequiredError extends TaskStoreError {}
export class TaskStoreDataError extends TaskStoreError {}
export class TaskStoreRequestError extends TaskStoreError {}
export class TaskStoreConflictError extends TaskStoreError {}
export class TaskStoreDurabilityError extends TaskStoreError {}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function validateJson(value: unknown, label: string): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new TaskStoreRequestError(`${label} exceeds the JSON complexity limit`);
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
    }
    if (ancestors.has(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const ownKeys = Reflect.ownKeys(candidate);
        if (
          ownKeys.length !== candidate.length + 1 ||
          !ownKeys.includes("length") ||
          ownKeys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= candidate.length),
          )
        ) {
          throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
        }
        return candidate.map((item) => visit(item, depth + 1));
      }
      if (!isPlainObject(candidate)) throw new TaskStoreRequestError(`${label} must contain valid JSON values`);
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(candidate)) setOwn(result, key, visit(item, depth + 1));
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value, 0);
}

function boundedJson(value: unknown, label: string, maximumBytes: number): { value: JsonValue; json: string } {
  const validated = validateJson(value, label);
  const json = JSON.stringify(validated);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new TaskStoreRequestError(`${label} JSON size exceeds its limit`);
  }
  return { value: validated, json };
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TaskStoreRequestError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > 4096) throw new TaskStoreRequestError(`${label} size exceeds its limit`);
  return value;
}

function normalizeRequest(request: TaskRequest): TaskRequest {
  if (!isPlainObject(request)) throw new TaskStoreRequestError("Task request must be an object");
  if (!hasOnlyKeys(request, ["key", "requester", "target", "action", "payload"])) {
    throw new TaskStoreRequestError("Task request contains unexpected fields");
  }
  const normalized: TaskRequest = {
    key: validateIdentifier(request.key, "Task idempotency key"),
    requester: validateIdentifier(request.requester, "Task requester"),
    target: validateIdentifier(request.target, "Task target"),
    action: validateIdentifier(request.action, "Task action"),
    payload: validateJson(request.payload, "Task payload"),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_REQUEST_BYTES) {
    throw new TaskStoreRequestError("Task request JSON size exceeds its limit");
  }
  return normalized;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestValue(request: TaskRequest): JsonValue {
  return {
    key: request.key,
    requester: request.requester,
    target: request.target,
    action: request.action,
    payload: request.payload,
  };
}

function sameRequest(task: TaskRecord, request: TaskRequest): boolean {
  return canonicalJson(requestValue(task)) === canonicalJson(requestValue(request));
}

function initialState(): StoredState {
  return { schemaVersion: 1, tasks: {}, idempotency: {} };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serializeState(state: StoredState): string {
  const json = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) {
    throw new TaskStoreDataError("Task store data size exceeds its limit");
  }
  return json;
}

async function writePrivateAtomic(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let renamed = false;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    renamed = true;
    await chmod(file, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function readBoundedPrivateFile(file: string, maximumBytes: number, label: string): Promise<string> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TaskStoreDataError(`${label} is invalid`);
    if (metadata.size > maximumBytes) throw new TaskStoreDataError(`${label} size exceeds its limit`);
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof TaskStoreError || isErrno(error, "ENOENT")) throw error;
    throw new TaskStoreDataError(`${label} is invalid`);
  } finally {
    await handle?.close();
  }
}

function parseIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateTask(id: string, value: unknown): TaskRecord {
  if (!isPlainObject(value)) throw new TaskStoreDataError("Invalid task store data");
  const taskKeys = Object.hasOwn(value, "result")
    ? ["key", "requester", "target", "action", "payload", "id", "revision", "state", "createdAt", "updatedAt", "result"]
    : ["key", "requester", "target", "action", "payload", "id", "revision", "state", "createdAt", "updatedAt"];
  if (!hasOnlyKeys(value, taskKeys)) throw new TaskStoreDataError("Invalid task store data");
  const request = normalizeRequest({
    key: value.key as string,
    requester: value.requester as string,
    target: value.target as string,
    action: value.action as string,
    payload: value.payload as JsonValue,
  });
  if (
    value.id !== id ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.state !== "string" ||
    !taskStateSet.has(value.state) ||
    !parseIsoDate(value.createdAt) ||
    !parseIsoDate(value.updatedAt)
  ) {
    throw new TaskStoreDataError("Invalid task store data");
  }
  const state = value.state as TaskState;
  const hasResult = Object.hasOwn(value, "result");
  if (hasResult && !resultStates.has(state)) throw new TaskStoreDataError("Invalid task store data");
  const result = hasResult ? boundedJson(value.result, "Task result", MAX_REQUEST_BYTES).value : undefined;
  return {
    ...request,
    id,
    revision: value.revision as number,
    state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(result === undefined ? {} : { result }),
  };
}

function parseStoredState(content: string): StoredState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TaskStoreDataError("Invalid task store data");
  }
  try {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, ["schemaVersion", "tasks", "idempotency"]) ||
      value.schemaVersion !== 1 ||
      !isPlainObject(value.tasks) ||
      !isPlainObject(value.idempotency)
    ) {
      throw new TaskStoreDataError("Invalid task store data");
    }
    const tasks: Record<string, TaskRecord> = {};
    for (const [id, task] of Object.entries(value.tasks)) setOwn(tasks, id, validateTask(id, task));
    const idempotency: Record<string, Record<string, string>> = {};
    for (const [requester, entries] of Object.entries(value.idempotency)) {
      if (!isPlainObject(entries)) throw new TaskStoreDataError("Invalid task store data");
      const normalizedEntries: Record<string, string> = {};
      for (const [key, taskId] of Object.entries(entries)) {
        const task = typeof taskId === "string" ? getOwn(tasks, taskId) : undefined;
        if (!task || task.requester !== requester || task.key !== key) {
          throw new TaskStoreDataError("Invalid task store data");
        }
        setOwn(normalizedEntries, key, taskId as string);
      }
      setOwn(idempotency, requester, normalizedEntries);
    }
    for (const task of Object.values(tasks)) {
      const entries = getOwn(idempotency, task.requester);
      if (!entries || getOwn(entries, task.key) !== task.id) {
        throw new TaskStoreDataError("Invalid task store data");
      }
    }
    return { schemaVersion: 1, tasks, idempotency };
  } catch (error) {
    if (error instanceof TaskStoreDataError) throw error;
    throw new TaskStoreDataError("Invalid task store data");
  }
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  try {
    const [statContent, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const commandEnd = statContent.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = statContent.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    const boot = bootId.trim();
    const identity = startTicks && boot ? `${boot}:${startTicks}` : null;
    return identity && isProcessIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

function isProcessIdentity(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/i.test(value);
}

async function currentLockOwner(token: string): Promise<LockOwner> {
  return {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity: await readProcessIdentity(process.pid),
    token,
    createdAt: new Date().toISOString(),
  };
}

function parseLockOwner(content: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TaskStoreLockedError("Task store lock metadata is malformed");
  }
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "pid", "processIdentity", "token", "createdAt"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    (value.processIdentity !== null &&
      (typeof value.processIdentity !== "string" || !isProcessIdentity(value.processIdentity))) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.token) ||
    !parseIsoDate(value.createdAt)
  ) {
    throw new TaskStoreLockedError("Task store lock metadata is malformed");
  }
  return value as unknown as LockOwner;
}

async function readLockOwner(directory: string): Promise<LockOwner> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TaskStoreLockedError("Task store lock is malformed");
    }
    const content = await readBoundedPrivateFile(path.join(directory, OWNER_FILE), MAX_LOCK_BYTES, "Task store lock");
    return parseLockOwner(content);
  } catch (error) {
    if (error instanceof TaskStoreLockedError) throw error;
    throw new TaskStoreLockedError("Task store lock is malformed");
  }
}

function probeProcess(pid: number): "alive" | "dead" | "ambiguous" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "dead";
    if (isErrno(error, "EPERM")) return "ambiguous";
    return "ambiguous";
  }
}

async function inspectLock(directory: string): Promise<"active" | "stale" | "ambiguous"> {
  const owner = await readLockOwner(directory);
  const liveness = probeProcess(owner.pid);
  if (liveness === "dead") return "stale";
  if (liveness === "ambiguous") return "ambiguous";
  const observedIdentity = await readProcessIdentity(owner.pid);
  if (owner.processIdentity !== null && observedIdentity !== null) {
    return owner.processIdentity === observedIdentity ? "active" : "stale";
  }
  return "ambiguous";
}

function parseRecoveryMarker(content: string): RecoveryMarker {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TaskStoreDataError("Task store recovery marker is invalid");
  }
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "reason", "createdAt"]) ||
    value.schemaVersion !== 1 ||
    value.reason !== "stale-writer" ||
    !parseIsoDate(value.createdAt)
  ) {
    throw new TaskStoreDataError("Task store recovery marker is invalid");
  }
  return value as unknown as RecoveryMarker;
}

async function readRecoveryMarker(root: string): Promise<RecoveryMarker | undefined> {
  try {
    const content = await readBoundedPrivateFile(
      path.join(root, RECOVERY_FILE),
      MAX_RECOVERY_BYTES,
      "Task store recovery marker",
    );
    return parseRecoveryMarker(content);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    if (error instanceof TaskStoreDataError) throw error;
    throw new TaskStoreDataError("Task store recovery marker is invalid");
  }
}

async function ensureRecoveryMarker(root: string): Promise<void> {
  const existing = await readRecoveryMarker(root);
  if (existing) return;
  const marker: RecoveryMarker = {
    schemaVersion: 1,
    reason: "stale-writer",
    createdAt: new Date().toISOString(),
  };
  await writePrivateAtomic(path.join(root, RECOVERY_FILE), `${JSON.stringify(marker)}\n`);
}

async function clearRecoveryMarker(root: string): Promise<void> {
  try {
    await rm(path.join(root, RECOVERY_FILE));
    await syncDirectory(root);
  } catch {
    throw new TaskStoreDataError("Task store recovery marker could not be cleared safely");
  }
}

async function createOwnedDirectory(directory: string): Promise<OwnedLock> {
  const token = randomUUID();
  await mkdir(directory, { mode: 0o700 });
  try {
    await chmod(directory, 0o700);
    await writePrivateAtomic(path.join(directory, OWNER_FILE), `${JSON.stringify(await currentLockOwner(token))}\n`);
    return { directory, token };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function releaseOwnedDirectory(lock: OwnedLock): Promise<void> {
  const owner = await readLockOwner(lock.directory);
  if (owner.pid !== process.pid || owner.token !== lock.token) {
    throw new TaskStoreLockedError("Task store lock ownership changed unexpectedly");
  }
  const released = `${lock.directory}.released-${randomUUID()}`;
  await rename(lock.directory, released);
  await rm(released, { recursive: true });
  await syncDirectory(path.dirname(lock.directory));
}

async function acquireWriterLock(root: string, recoverStaleLock: boolean): Promise<AcquiredWriterLock> {
  const acquisitionDirectory = path.join(root, ACQUISITION_DIRECTORY);
  let acquisition: OwnedLock;
  try {
    acquisition = await createOwnedDirectory(acquisitionDirectory);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new TaskStoreLockedError(
        "Task store lock acquisition is already in progress; offline recovery is required if it was abandoned",
      );
    }
    throw error;
  }

  const lockDirectory = path.join(root, LOCK_DIRECTORY);
  let quarantine: string | undefined;
  try {
    try {
      return { lock: await createOwnedDirectory(lockDirectory) };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    const status = await inspectLock(lockDirectory);
    if (status === "active" || status === "ambiguous") {
      throw new TaskStoreLockedError(
        status === "active" ? "Task store is locked by another writer" : "Task store lock ownership is ambiguous",
      );
    }
    if (!recoverStaleLock) {
      throw new TaskStoreRecoveryRequiredError("Task store recovery is required for a stale writer lock");
    }

    const confirmedStatus = await inspectLock(lockDirectory);
    if (confirmedStatus !== "stale") {
      throw new TaskStoreLockedError("Task store lock can no longer be proven stale");
    }
    await ensureRecoveryMarker(root);
    quarantine = path.join(root, `.task-store.stale-${randomUUID()}`);
    await rename(lockDirectory, quarantine);
    const lock = await createOwnedDirectory(lockDirectory);
    try {
      await rm(quarantine, { recursive: true });
    } catch {
      await releaseOwnedDirectory(lock);
      await rename(quarantine, lockDirectory);
      quarantine = undefined;
      throw new TaskStoreLockedError("Task store stale lock recovery could not be completed safely");
    }
    quarantine = undefined;
    return { lock };
  } catch (error) {
    if (quarantine) {
      try {
        await rename(quarantine, lockDirectory);
      } catch {
        throw new TaskStoreLockedError("Task store stale lock recovery could not be completed safely");
      }
    }
    throw error;
  } finally {
    await releaseOwnedDirectory(acquisition);
  }
}

async function prepareRoot(root: string): Promise<string> {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new TaskStoreDataError("Task store root must be a non-empty path");
  }
  const resolved = path.resolve(root);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TaskStoreDataError("Task store root must be a real directory");
  }
  await chmod(resolved, 0o700);
  return resolved;
}

export class TaskStore {
  readonly #root: string;
  readonly #stateFile: string;
  readonly #lock: OwnedLock;
  #state: StoredState;
  #writeTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #closed = false;
  #poisoned = false;

  private constructor(root: string, state: StoredState, lock: OwnedLock) {
    this.#root = root;
    this.#stateFile = path.join(root, STATE_FILE);
    this.#lock = lock;
    this.#state = state;
  }

  static async open(root: string, options: TaskStoreOpenOptions = {}): Promise<TaskStore> {
    const resolvedRoot = await prepareRoot(root);
    const recoverStaleLock = options.recoverStaleLock === true;
    const { lock } = await acquireWriterLock(resolvedRoot, recoverStaleLock);
    try {
      const recoveryMarker = await readRecoveryMarker(resolvedRoot);
      if (recoveryMarker && !recoverStaleLock) {
        throw new TaskStoreRecoveryRequiredError("Task store recovery is required after a stale writer");
      }
      const stateFile = path.join(resolvedRoot, STATE_FILE);
      let state: StoredState;
      try {
        const content = await readBoundedPrivateFile(stateFile, MAX_STATE_BYTES, "Task store data");
        state = parseStoredState(content);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        state = initialState();
        await writePrivateAtomic(stateFile, serializeState(state));
      }

      if (recoveryMarker) {
        const next = cloneJson(state);
        const now = new Date().toISOString();
        let recoveredFromCrash = false;
        for (const [id, task] of Object.entries(next.tasks)) {
          if (task.state !== "running") continue;
          setOwn(next.tasks, id, { ...task, state: "unknown", revision: task.revision + 1, updatedAt: now });
          recoveredFromCrash = true;
        }
        if (recoveredFromCrash) {
          await writePrivateAtomic(stateFile, serializeState(next));
          state = next;
        }
        await clearRecoveryMarker(resolvedRoot);
      }
      return new TaskStore(resolvedRoot, state, lock);
    } catch (error) {
      await releaseOwnedDirectory(lock);
      throw error;
    }
  }

  async submit(request: TaskRequest): Promise<TaskRecord> {
    this.#assertAcceptingWrites();
    const normalized = normalizeRequest(request);
    return this.#enqueueWrite(async () => {
      const requesterEntries = getOwn(this.#state.idempotency, normalized.requester);
      const existingId = requesterEntries ? getOwn(requesterEntries, normalized.key) : undefined;
      if (existingId) {
        const existing = getOwn(this.#state.tasks, existingId);
        if (!existing || !sameRequest(existing, normalized)) {
          throw new TaskStoreConflictError("Idempotency key is already bound to different request content");
        }
        return cloneJson(existing);
      }

      const now = new Date().toISOString();
      const task: TaskRecord = {
        ...cloneJson(normalized),
        id: randomUUID(),
        revision: 1,
        state: "pending_approval",
        createdAt: now,
        updatedAt: now,
      };
      const next = cloneJson(this.#state);
      setOwn(next.tasks, task.id, task);
      let entries = getOwn(next.idempotency, task.requester);
      if (!entries) {
        entries = {};
        setOwn(next.idempotency, task.requester, entries);
      }
      setOwn(entries, task.key, task.id);
      await this.#persist(next);
      return cloneJson(task);
    });
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    this.#assertOpen();
    const task = getOwn(this.#state.tasks, id);
    return task ? cloneJson(task) : undefined;
  }

  async transition(
    id: string,
    expectedState: TaskState,
    nextState: TaskState,
    options: TaskTransitionOptions = {},
  ): Promise<TaskRecord> {
    this.#assertAcceptingWrites();
    if (!taskStateSet.has(expectedState) || !taskStateSet.has(nextState)) {
      throw new TaskStoreConflictError("Task transition contains an invalid state");
    }
    const expectedRevision = options.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new TaskStoreConflictError("Task transition revision is invalid");
    }
    const hasResult = Object.hasOwn(options, "result");
    const result = hasResult ? boundedJson(options.result, "Task result", MAX_REQUEST_BYTES).value : undefined;

    return this.#enqueueWrite(async () => {
      const current = getOwn(this.#state.tasks, id);
      if (!current) throw new TaskStoreConflictError("Task does not exist");
      if (current.state !== expectedState) throw new TaskStoreConflictError("Task state does not match expected state");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new TaskStoreConflictError("Task revision does not match expected revision");
      }
      if (!allowedTransitions[current.state].has(nextState)) {
        throw new TaskStoreConflictError("Task transition is not allowed");
      }
      if (result !== undefined && !resultStates.has(nextState)) {
        throw new TaskStoreConflictError("Task result is only allowed on a terminal state");
      }

      const next = cloneJson(this.#state);
      const updated: TaskRecord = {
        ...current,
        state: nextState,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result: cloneJson(result) }),
      };
      setOwn(next.tasks, id, updated);
      await this.#persist(next);
      return cloneJson(updated);
    });
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      this.#closePromise = (async () => {
        await this.#writeTail;
        await releaseOwnedDirectory(this.#lock);
        this.#closed = true;
      })();
    }
    await this.#closePromise;
  }

  async #persist(next: StoredState): Promise<void> {
    const serialized = serializeState(next);
    try {
      await writePrivateAtomic(this.#stateFile, serialized);
    } catch {
      this.#poisoned = true;
      throw new TaskStoreDurabilityError(
        "Task store persistence is uncertain; close and reopen the store before reading or writing",
      );
    }
    this.#state = next;
  }

  #enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const guardedOperation = () => {
      this.#assertDurable();
      return operation();
    };
    const result = this.#writeTail.then(guardedOperation, guardedOperation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertAcceptingWrites(): void {
    if (this.#closing || this.#closed) throw new TaskStoreError("Task store is closed");
    this.#assertDurable();
  }

  #assertOpen(): void {
    if (this.#closed) throw new TaskStoreError("Task store is closed");
    this.#assertDurable();
  }

  #assertDurable(): void {
    if (this.#poisoned) {
      throw new TaskStoreDurabilityError(
        "Task store persistence is uncertain; close and reopen the store before reading or writing",
      );
    }
  }
}
