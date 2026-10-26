// EXPERIMENT ONLY: fixed marker policy, not a public Manager executor/backend.
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const POLICY = Object.freeze({ version: 1, action: 'marker', target: 'control', payload: 'empty' });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Invalid or extra fields');
  }
}
const canonical = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const requestOf = task => Object.fromEntries(['key', 'requester', 'target', 'action', 'payload'].map(key => [key, task[key]]));

export function validateRequest(request) {
  exact(request, ['key', 'requester', 'target', 'action', 'payload']);
  exact(request.payload, []);
  if (!/^[a-z0-9-]{1,64}$/.test(request.key) || !['agent', 'frontend'].includes(request.requester) ||
      request.action !== POLICY.action || request.target !== POLICY.target) throw new Error('Marker policy denied');
  return Object.freeze({ ...request, payload: Object.freeze({}) });
}
export function frozenRef(ref) {
  exact(ref, ['taskId', 'revision']);
  if (!uuid.test(ref.taskId) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('Invalid reference');
  return Object.freeze({ taskId: ref.taskId, revision: ref.revision });
}
export function approvalFor(task, policy = POLICY) {
  validateRequest(requestOf(task));
  return Object.freeze({ ...frozenRef({ taskId: task.id, revision: task.revision }),
    requestHash: hash(requestOf(task)), policyHash: hash(policy) });
}
export function verifyApproval(task, approval, policy = POLICY) {
  exact(approval, ['taskId', 'revision', 'requestHash', 'policyHash']);
  const expected = approvalFor(task, policy);
  if (Object.keys(expected).some(key => approval[key] !== expected[key])) throw new Error('Approval binding mismatch');
}

export async function routeEntry(message, forward) {
  exact(message, ['op', 'body']);
  if (message.op === 'submit') return forward({ op: 'submit', body: validateRequest(message.body) });
  if (message.op === 'dispatch') return forward({ op: 'dispatch', body: frozenRef(message.body) });
  if (message.op === 'query') {
    exact(message.body, ['taskId']);
    if (!uuid.test(message.body.taskId)) throw new Error('Invalid task ID');
    return forward(message);
  }
  throw new Error('Public entry only permits submit/query/dispatch-reference; never approval');
}

// Authoritative socket handler: intentionally does not call the public proxy.
// It must remain safe when the entry container sends requests directly.
export async function routeExecutor(message, executor) {
  exact(message, ['op', 'body']);
  if (message.op === 'submit') return executor.submit(validateRequest(message.body));
  if (message.op === 'dispatch') return executor.dispatch(frozenRef(message.body));
  if (message.op === 'query') {
    exact(message.body, ['taskId']);
    if (!uuid.test(message.body.taskId)) throw new Error('Invalid task ID');
    return executor.get(message.body.taskId);
  }
  throw new Error('Execution channel cannot approve or accept other operations');
}

export class ProbeExecutor {
  #store; #marker; #delay; #approved = new Map(); #tail = Promise.resolve(); #work = new Set(); #failure;
  constructor(store, marker, delayMs = 6000) {
    this.#store = store; this.#marker = marker; this.#delay = delayMs;
  }
  #serial(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
  submit(request) { return this.#store.submit(validateRequest(request)); }
  get(taskId) { return this.#store.get(taskId); }
  approve(approval) {
    return this.#serial(async () => {
      const task = await this.#store.get(approval.taskId);
      if (!task || task.state !== 'pending_approval') throw new Error('Not pending approval');
      verifyApproval(task, approval);
      const queued = await this.#store.transition(task.id, 'pending_approval', 'queued', { expectedRevision: task.revision });
      this.#approved.set(task.id, approvalFor(queued));
      return queued;
    });
  }
  dispatch(input) {
    return this.#serial(async () => {
      const ref = frozenRef(input);
      const task = await this.#store.get(ref.taskId);
      if (!task || task.state !== 'queued' || task.revision !== ref.revision) throw new Error('Unapproved or stale reference');
      const approved = this.#approved.get(task.id);
      if (!approved) throw new Error('No approval in this executor lifetime');
      verifyApproval(task, approved);
      const running = await this.#store.transition(task.id, 'queued', 'running', { expectedRevision: ref.revision });
      this.#approved.delete(task.id);
      const work = (async () => {
        await delay(this.#delay);
        await appendFile(this.#marker, 'marker\n', { mode: 0o600 });
        await this.#store.transition(task.id, 'running', 'succeeded', { expectedRevision: running.revision });
      })();
      this.#work.add(work);
      work.then(() => this.#work.delete(work), error => { this.#failure = error; this.#work.delete(work); });
      return running;
    });
  }
  async idle() {
    await this.#tail;
    await Promise.all([...this.#work]);
    if (this.#failure) throw this.#failure;
  }
}
