// Executor-owned optional preload for the audited JSONL RPC transport. This is
// cooperative quiescence, NOT isolation against malicious code in this process.
// It must be installed before Pi opens stdin; it never runs package code.
import { randomUUID } from 'node:crypto';
const key = Symbol.for('pi.runtime.stdin-guard.v1');
if (Object.prototype.hasOwnProperty.call(globalThis, key)) throw Error('Runtime input guard already installed');
const stdin = process.stdin, stdout = process.stdout;
// Pi deliberately redirects public stdout.write to stderr, preserving a raw
// writer for JSONL. Observe the actual stream sink underneath both writers.
// Replacement of that sink, including the vectored path, invalidates admission.
const originalEmit = stdin.emit, originalWrite = stdout._write, originalWritev = stdout._writev;
const limit = 1024 * 1024;
let input = Buffer.alloc(0), output = Buffer.alloc(0);
let uncertain = false, generating = false, stopping = false, barrier = null;
let rpcReady = false;
const pending = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function intact() {
  const valid = process.stdin === stdin && process.stdout === stdout && stdin.emit === guardedEmit &&
    stdout._write === guardedWrite && stdout._writev === guardedWritev && globalThis[key] === guard;
  if (!valid) uncertain = true;
  return valid;
}
function safe() { return intact() && !uncertain && !stopping && !generating && !input.length && !output.length && pending.size === 0; }

function inputFrame(frame) {
  if (!object(frame) || !id(frame.id) || !['get_state', 'prompt'].includes(frame.type) ||
    pending.has(frame.id) || pending.size >= 16) { uncertain = true; return; }
  if (frame.type === 'prompt') {
    if (generating) uncertain = true;
    generating = true;
  }
  pending.set(frame.id, frame.type);
}
function outputFrame(frame) {
  if (!object(frame) || typeof frame.type !== 'string') { uncertain = true; return; }
  if (frame.type === 'response') {
    const command = pending.get(frame.id);
    if (!command || frame.command !== command || typeof frame.success !== 'boolean') { uncertain = true; return; }
    pending.delete(frame.id);
    if (!frame.success) { uncertain = true; return; }
    if (command === 'get_state') rpcReady = true;
    if (command === 'prompt' && (!object(frame.data) || frame.data.disposition !== 'started')) {
      // "handled" may have launched extension-owned asynchronous work. No
      // observed settlement proof can establish its quiescence here.
      uncertain = true;
    }
  }
  if (frame.type === 'agent_start') {
    if (barrier || stopping) uncertain = true;
    generating = true;
  }
  // agent_end alone is deliberately insufficient: retries/extension work may follow.
  if (frame.type === 'agent_settled') {
    if (typeof frame.aborted !== 'boolean') uncertain = true;
    else generating = false;
  }
}
function consume(channel, chunk, encoding) {
  if (uncertain) return;
  try {
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array || typeof chunk === 'string') ||
      (typeof chunk === 'string' && encoding !== undefined && !['utf8', 'utf-8'].includes(encoding))) throw Error();
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (length > limit) throw Error();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let buffer = channel === 'input' ? input : output;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      if (buffer.length + end - offset > limit) throw Error();
      buffer = Buffer.concat([buffer, bytes.subarray(offset, end)]);
      if (newline < 0) break;
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      if (channel === 'input') inputFrame(frame); else outputFrame(frame);
      buffer = Buffer.alloc(0); offset = newline + 1;
      if (uncertain) break;
    }
    if (channel === 'input') input = buffer; else output = buffer;
  } catch { uncertain = true; }
  if (uncertain) { input = Buffer.alloc(0); output = Buffer.alloc(0); pending.clear(); }
}
function guardedEmit(event, ...args) {
  if (event === 'data') {
    if (barrier || stopping) { uncertain = true; return false; }
    consume('input', args[0]);
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
}
function guardedWrite(chunk, encoding, callback) {
  consume('output', chunk, typeof chunk === 'string' ? encoding : undefined);
  try { return Reflect.apply(originalWrite, this, [chunk, encoding, callback]); }
  catch (error) { uncertain = true; throw error; }
}
const guardedWritev = typeof originalWritev === 'function' ? function (chunks, callback) {
  let bytes = 0;
  for (const { chunk, encoding } of chunks) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > limit) { uncertain = true; break; }
    consume('output', chunk, typeof chunk === 'string' ? encoding : undefined);
  }
  try { return Reflect.apply(originalWritev, this, [chunks, callback]); }
  catch (error) { uncertain = true; throw error; }
} : originalWritev;
const guard = Object.freeze({
  version: 1, transport: 'pi-rpc-v1:stdin-stdout-jsonl', intact, safe,
  webInput: 'correlated-text-v1',
  dispatchPrompt(message) {
    // One fixed RPC action, generated correlation ID, no caller-selected frames.
    // Refusal is synchronous and never enqueues/replays input after cancellation.
    if (typeof message !== 'string' || message.length > 65536 || !message.trim() ||
      Buffer.byteLength(message) > 65536 || message.includes('\0') || message.trimStart().startsWith('/') ||
      !rpcReady || !safe() || barrier || stdin.listenerCount('data') === 0) return false;
    const frame = Buffer.from(JSON.stringify({ id: `web_${randomUUID()}`, type: 'prompt', message }) + '\n');
    try { guardedEmit.call(stdin, 'data', frame); return true; }
    catch { uncertain = true; return false; }
  },
  taint: () => { uncertain = true; },
  freeze(owner, operation) {
    if (!safe() || !owner || !/^[a-f0-9]{32}$/.test(operation) ||
      (barrier && (barrier.owner !== owner || barrier.operation !== operation))) return false;
    barrier = { owner, operation }; return true;
  },
  release(owner, operation) {
    if (stopping || !barrier || barrier.owner !== owner || barrier.operation !== operation) return false;
    barrier = null; return true;
  },
  shutdown(owner) { if (barrier?.owner === owner) stopping = true; },
});
stdin.emit = guardedEmit; stdout._write = guardedWrite; stdout._writev = guardedWritev;
Object.defineProperty(globalThis, key, { value: guard, configurable: false, writable: false });
