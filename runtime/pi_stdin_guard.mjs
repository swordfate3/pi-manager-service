// Fixed image-owned preload. Audited transport: Pi / pi-tui 1.1.0 stdin data events.
// This is a quiescence fence, not isolation from malicious code in this process.
const key = Symbol.for('pi.runtime.stdin-guard.v1');
if (!Object.prototype.hasOwnProperty.call(globalThis, key)) {
  const stdin = process.stdin;
  const original = stdin.emit;
  let uncertain = false;
  let barrier = null;
  let stopping = false;
  const intact = () => {
    const valid = process.stdin === stdin && stdin.emit === guardedEmit && globalThis[key] === guard;
    if (!valid) uncertain = true;
    return valid;
  };
  function guardedEmit(event, ...args) {
    if (event === 'data') {
      const data = args[0];
      // Up to four complete audited DSR/DA reports may be coalesced by a TTY.
      // This is a whole-packet allowlist, NOT a general CSI parser. Unknown,
      // fragmented, overlong or user-byte-mixed packets taint synchronously.
      const report = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('latin1') : '';
      if (report.length > 28 || !/^(?:\x1b\[1;1R|\x1b\[\?1;2c){1,4}$/.test(report)) uncertain = true;
      if (barrier || stopping) return false;
    }
    return Reflect.apply(original, this, [event, ...args]);
  }
  const guard = Object.freeze({
    version: 1,
    transport: 'pi-tui-1.1.0:stdin-data',
    intact,
    safe: () => intact() && !uncertain && !stopping,
    taint: () => { uncertain = true; },
    freeze(owner, operation) {
      if (!intact() || uncertain || stopping || !owner || !/^[a-f0-9]{32}$/.test(operation) ||
          (barrier && (barrier.owner !== owner || barrier.operation !== operation))) return false;
      barrier = { owner, operation }; return true;
    },
    release(owner, operation) {
      if (stopping || !barrier || barrier.owner !== owner || barrier.operation !== operation) return false;
      barrier = null; return true;
    },
    shutdown(owner) {
      if (barrier?.owner === owner) stopping = true;
    },
  });
  stdin.emit = guardedEmit;
  Object.defineProperty(globalThis, key, { value: guard, configurable: false, writable: false });
}
