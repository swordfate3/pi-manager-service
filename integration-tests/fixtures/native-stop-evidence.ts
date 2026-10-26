import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { NativeBackend } from '../../manager/backends/native.ts';

/** Test-owned resources only; shared by cutover and the test's final cleanup. */
export class NativeStopEvidence {
  readonly root: string;
  readonly backends: readonly NativeBackend[];
  #failure: unknown;
  readonly #uncertain = new WeakMap<NativeBackend, Map<string, unknown>>();
  constructor(root: string, backends: readonly NativeBackend[]) { this.root = root; this.backends = backends; }
  async stop(backend: NativeBackend, id: string) {
    const prior = this.#uncertain.get(backend);
    if (prior?.has(id)) throw prior.get(id);
    try { assert.equal((await backend.stop(id)).status, 'stopped'); }
    catch (error) {
      this.#failure ??= error;
      const failed = prior ?? new Map<string, unknown>();
      failed.set(id, error); this.#uncertain.set(backend, failed);
      throw error;
    }
  }
  async cleanup() {
    for (const backend of this.backends) for (const identity of backend.list()) {
      // Failed boundaries are remembered even when #finish erased the owned map.
      // Other still-owned children get one cleanup attempt; unknown stops never retry.
      try { await this.stop(backend, identity.instanceId); } catch { /* retained by stop */ }
    }
    if (this.#failure) throw Error(`Owned test cleanup uncertain; evidence retained at ${this.root}`, { cause: this.#failure });
    await rm(this.root, { recursive: true, force: true });
  }
}
