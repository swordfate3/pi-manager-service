// Host-only experiment guards. Importing this file never accesses Docker.
export const LABEL = 'cn.swordfate.manager-isolation.run';
export const MAX_OUTPUT = 256 * 1024;

export function roleSpec(role, mutation = false) {
  const roles = {
    executor: { uid: 21001, groups: [21002, 21005], volumes: ['private', 'control', 'exec', 'admin'] },
    entry: { uid: 21002, groups: [21006], volumes: ['public', 'exec'] },
    frontend: { uid: 21003, groups: [21006], volumes: ['public', 'frontend-work'] },
    agent: { uid: 21004, groups: [21006], volumes: ['public', 'agent-work'] },
    admin: { uid: 21005, groups: [], volumes: ['admin'] },
  };
  if (!Object.hasOwn(roles, role)) throw new Error('Unknown fixture role');
  const spec = roles[role];
  // Deliberately unsafe ONLY for the new temporary Agent test container.
  if (role === 'agent' && mutation) { spec.groups.push(21005); spec.volumes.push('admin'); }
  return spec;
}

export function parseArgs(args) {
  if (args.length === 0) return null;
  const flags = new Set();
  let image;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    flags.add(flag);
    if (flag === '--image') image = args[++i];
    else if (!['--allow-temporary-docker', '--unsafe-fixture-admin-access',
      '--acknowledge-negative-control'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !flags.has('--allow-temporary-docker')) {
    throw new Error('Require --image <full local sha256 ID> --allow-temporary-docker');
  }
  const mutation = flags.has('--unsafe-fixture-admin-access');
  if (mutation !== flags.has('--acknowledge-negative-control')) {
    throw new Error('Negative control requires both explicit mutation acknowledgements');
  }
  return { image, mutation };
}

export function assertOwned(kind, id, item, run) {
  if (!/^[a-f0-9]{32}$/.test(run)) throw new Error('Invalid ownership nonce');
  const labels = kind === 'container' ? item.Config?.Labels : item.Labels;
  const actual = kind === 'container' ? item.Id : item.Name;
  const validId = kind === 'container' ? /^[a-f0-9]{64}$/.test(id)
    : kind === 'volume' && new RegExp(`^manager-isolation-${run}-[a-z-]+$`).test(id);
  if (!validId || actual !== id || labels?.[LABEL] !== run) {
    throw new Error(`Refusing unowned ${kind}: ${id}`);
  }
}

export function checkedResult(result) {
  if (result.error) throw new Error(`Child process failed: ${result.error.message}`, { cause: result.error });
  if (result.signal || result.status !== 0) {
    throw new Error(`Child process status=${result.status} signal=${result.signal ?? 'none'}: ${(result.stderr ?? '').slice(0, 2048)}`);
  }
  if (Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') > MAX_OUTPUT) {
    throw new Error('Child process output exceeded limit');
  }
  return (result.stdout ?? '').trim();
}
