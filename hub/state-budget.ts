import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const STATE_LIMIT = 8 * 1024 * 1024;
export const ACTIVE_GRANT_LIMIT = 512;
// Normal admissions cannot spend the space required for all 512 revocations,
// management invalidation and one private atomic replacement (<=8 KiB).
const SECURITY_RESERVE = 64 * 1024;
const SCAN_ENTRIES = 32768;
type Config = { stateDir: string };
export class StateBudgetError extends Error {
  constructor() {
    super("Hub state quota exceeded");
  }
}

function privateStat(stat: NonNullable<ReturnType<typeof lstatSync>>) {
  if (process.platform !== "win32" && ((Number(stat.mode) & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    throw new Error("Unsafe private Hub state");
}

export function privateStateDirectory(directory: string) {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  privateStat(stat);
  if (!stat.isDirectory()) throw new Error("Unsafe private Hub directory");
  // File fsync alone does not persist newly created ancestor directory entries.
  if (created) {
    const parent = path.dirname(path.resolve(created));
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      syncDirectory(current);
      if (current === parent) break;
    }
  }
}

export function readStateJson(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    privateStat(stat);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Invalid private Hub file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Empty directory locks are never stolen, even after a crash. No PID guessing. */
export function acquireStateLock(config: Config, name: ".writer.lock" | ".serving.lock") {
  privateStateDirectory(config.stateDir);
  const root = realpathSync(config.stateDir);
  const lock = path.join(root, name);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error("Hub state lock busy; trusted recovery may be required");
  }
  const identity = lstatSync(lock);
  let released = false;
  return {
    root,
    release() {
      if (released) return;
      // Only the empty directory created by this acquisition is removed.
      try {
        const current = lstatSync(lock);
        if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Hub lock ownership changed");
        rmdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      released = true;
    },
  };
}

type Totals = {
  logicalBytes: number;
  files: number;
  activeGrants: number;
  revokedGrants: number;
  generationFiles: number;
  receiptFiles: number;
  exportReservedBytes: number;
};
function exportCharge(value: unknown) {
  const bytes = (value as { exportBytes?: unknown })?.exportBytes ?? 0;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8192)
    throw new Error("Invalid export reservation");
  return bytes;
}
function scan(root: string): Totals {
  const totals: Totals = {
    logicalBytes: 0,
    files: 0,
    activeGrants: 0,
    revokedGrants: 0,
    generationFiles: 0,
    receiptFiles: 0,
    exportReservedBytes: 0,
  };
  let entries = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 4) throw new StateBudgetError();
    const dir = opendirSync(directory);
    try {
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (++entries > SCAN_ENTRIES) throw new StateBudgetError();
        const file = path.join(directory, item.name);
        const stat = lstatSync(file);
        privateStat(stat);
        if (stat.isDirectory()) {
          visit(file, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub state");
        totals.files++;
        totals.logicalBytes += stat.size;
        const relative = path.relative(root, file);
        if (/^grants\/[a-f0-9]{32}\.json$/.test(relative)) {
          const grant = readStateJson(file);
          if (grant.revoked !== undefined && typeof grant.revoked !== "boolean") throw new Error("Invalid grant state");
          if (grant.revoked) totals.revokedGrants++;
          else totals.activeGrants++;
          const charge = exportCharge(grant);
          totals.exportReservedBytes += charge;
          totals.logicalBytes += charge;
        }
        if (/^(generations|bounded)\//.test(relative)) totals.generationFiles++;
        if (relative.startsWith("restarts/")) totals.receiptFiles++;
      }
    } finally {
      dir.closeSync();
    }
  };
  visit(root, 0);
  return totals;
}

/** Synchronous transaction: never hold across backend proof or other await. */
export class StateWriter {
  private totals: Totals | undefined;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Also fence authority-only transitions, such as legacy lease renewal. */
  assertAdmission() {
    this.totals ??= scan(this.root);
    if (this.totals.activeGrants > ACTIVE_GRANT_LIMIT || this.totals.logicalBytes > STATE_LIMIT)
      throw new StateBudgetError();
  }

  private destination(relative: string) {
    if (
      !/^(?:grants\/[a-f0-9]{32}\.json|generations\/[a-f0-9]{32}\.json|bounded\/[a-f0-9]{32}\.json|restarts\/[a-f0-9]{32}(?:\.started|\.verified)?\.json|management\.json|interaction-signing\.json|registry\.json)$/.test(
        relative,
      )
    )
      throw new Error("Invalid Hub state destination");
    const file = path.join(this.root, relative);
    privateStateDirectory(path.dirname(file));
    return file;
  }

  write(relative: string, value: unknown, options: { exclusive?: boolean; security?: boolean } = {}) {
    const file = this.destination(relative);
    const data = Buffer.from(`${JSON.stringify(value)}\n`);
    if (data.length > 8192) throw new StateBudgetError();
    let oldBytes = 0;
    let old: { revoked?: boolean; exportBytes?: number } | undefined;
    let exists = false;
    try {
      const stat = lstatSync(file);
      privateStat(stat);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub file");
      exists = true;
      oldBytes = stat.size;
      old = readStateJson(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.exclusive && exists) throw new Error("Hub state already exists");
    this.totals ??= scan(this.root);
    const totals = this.totals;
    const isGrant = relative.startsWith("grants/");
    const oldCharge = isGrant && exists ? exportCharge(old) : 0;
    const newCharge = isGrant ? exportCharge(value) : 0;
    const activeDelta = isGrant
      ? Number(!(value as { revoked?: boolean }).revoked) - Number(exists && !old?.revoked)
      : 0;
    // Account staging as well as final state. Replacement never temporarily
    // spends an unaccounted copy, and export reservation precedes publication.
    const peak = totals.logicalBytes + data.length + Math.max(0, newCharge - oldCharge);
    const ceiling = options.security ? STATE_LIMIT : STATE_LIMIT - SECURITY_RESERVE;
    // An already over-count store may recover one grant at a time. Headroom
    // alone is not a bypass: only the exact existing grant with revoked=true
    // can cross this fence, never a boot/registry write or credential change.
    const revocation =
      options.security &&
      isGrant &&
      activeDelta === -1 &&
      (value as { revoked?: unknown }).revoked === true &&
      JSON.stringify(value) === JSON.stringify({ ...old, revoked: true });
    if (
      peak > ceiling ||
      ((totals.activeGrants > ACTIVE_GRANT_LIMIT || totals.activeGrants + activeDelta > ACTIVE_GRANT_LIMIT) &&
        !revocation)
    )
      throw new StateBudgetError();
    const temporary = path.join(path.dirname(file), `.write-${randomBytes(16).toString("hex")}`);
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // On an uncertain write/fsync failure preserve the private staging file for
    // trusted recovery; the next authoritative scan still counts it.
    if (options.exclusive) {
      linkSync(temporary, file);
      unlinkSync(temporary);
    } else renameSync(temporary, file);
    syncDirectory(path.dirname(file));
    totals.logicalBytes += data.length - oldBytes + newCharge - oldCharge;
    totals.activeGrants += activeDelta;
    this.totals = undefined; // subsequent writes see all categories authoritatively
  }

  diagnostics() {
    const totals = scan(this.root);
    return {
      ...totals,
      limitBytes: STATE_LIMIT,
      activeGrantLimit: ACTIVE_GRANT_LIMIT,
      securityReserveBytes: SECURITY_RESERVE,
      overBudget: totals.logicalBytes > STATE_LIMIT || totals.activeGrants > ACTIVE_GRANT_LIMIT,
    };
  }
}

export function withStateWriter<T>(config: Config, operation: (writer: StateWriter) => T): T {
  const lock = acquireStateLock(config, ".writer.lock");
  try {
    const result = operation(new StateWriter(lock.root));
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new Error("Hub writer cannot cross an await");
    return result;
  } finally {
    lock.release();
  }
}

export const storageDiagnostics = (config: Config) => withStateWriter(config, (writer) => writer.diagnostics());

/** Grant must already be durable and charged before publishing an export. */
export function publishCredential(file: string, credential: unknown) {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(credential)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}
