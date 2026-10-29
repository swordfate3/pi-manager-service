import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

const sourceBin = path.resolve('deploy/compose/bin');
const launcherFiles = [
  'pi-pirun',
  'hub-session.py',
  'host-identity.sh',
  'pi-qq-bridge',
  'pi-qq-lifecycle.sh',
  'pirun',
];
const image = `sha256:${'1'.repeat(64)}`;

async function exists(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function waitFor(check, message, timeout = 8000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(40);
  } while (Date.now() < end);
  assert.fail(message);
}

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pi-compose-launcher-'));
  const root = path.join(temporary, 'stack root');
  const bin = path.join(root, 'internal/bin');
  const workspace = path.join(temporary, 'project workspace');
  const home = path.join(temporary, 'home');
  const fakeBin = path.join(temporary, 'fake-bin');
  const dockerLog = path.join(temporary, 'docker.jsonl');
  const nodeLog = path.join(temporary, 'node.jsonl');
  const legacy = path.join(temporary, 'legacy');
  const screenshotSource = path.join(temporary, 'QQ Temp');
  const config = {
    image,
    screenshots: {enabled: false, source: screenshotSource},
    mounts: {ssh: true, bashrc: true, huggingface: true},
    volumes: {
      home: 'pi-user-home',
      runtime: 'pi-runtime',
      agent: 'pi-home',
      credentials: 'pi-credentials',
      huggingface: 'pi-huggingface-cache',
    },
    ...options.config,
  };
  if (options.config?.screenshots) config.screenshots = options.config.screenshots;
  if (options.config?.mounts) config.mounts = options.config.mounts;
  if (options.config?.volumes) config.volumes = options.config.volumes;

  for (const directory of [
    bin,
    workspace,
    home,
    fakeBin,
    legacy,
    screenshotSource,
    path.join(root, 'config'),
    path.join(root, 'pi-models'),
    path.join(root, 'data/memory'),
    path.join(root, 'data/screenshots'),
    path.join(root, 'data/hub/chat-runtime'),
    path.join(root, 'data/hub/launches'),
  ]) await mkdir(directory, {recursive: true, mode: 0o700});
  await mkdir(path.join(home, '.ssh'), {mode: 0o700});
  await mkdir(path.join(home, '.cache/huggingface'), {recursive: true, mode: 0o700});
  await writeFile(path.join(home, '.bashrc'), 'export MUST_NOT_BE_SOURCED=1\n', {mode: 0o600});
  await writeFile(path.join(home, '.cache/huggingface/token'), 'private-hf-token\n', {mode: 0o600});
  await writeFile(path.join(root, 'config/pi.json'), `${JSON.stringify(config)}\n`, {mode: 0o600});
  await writeFile(path.join(root, 'pi-models/models.json'), '{"providers":[]}\n', {mode: 0o600});
  await writeFile(path.join(root, 'compose.yaml'), 'services:\n  pi:\n    image: fixed-by-renderer\n', {mode: 0o600});
  await writeFile(path.join(root, 'data/hub/chat.json'), '{}\n', {mode: 0o600});
  await writeFile(path.join(root, 'internal/hub-runtime.json'), '{}\n', {mode: 0o600});
  await writeFile(path.join(legacy, 'config.json'), `${JSON.stringify({...config, image})}\n`, {mode: 0o600});

  for (const name of launcherFiles) {
    await copyFile(path.join(sourceBin, name), path.join(bin, name));
    await chmod(path.join(bin, name), 0o700);
  }

  const fakeTool = `#!/usr/bin/env python3
import json, os, pathlib, sys, time
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
log = os.environ['FAKE_NODE_LOG' if tool == 'node' else 'FAKE_DOCKER_LOG']
with open(log, 'a', encoding='utf-8') as stream:
    stream.write(json.dumps({'tool': tool, 'args': args, 'workspace_id': os.environ.get('PI_SCOPED_MEMORY_WORKSPACE_ID'), 'workspace_root': os.environ.get('PI_SCOPED_MEMORY_WORKSPACE_ROOT'), 'compose_env': {key: os.environ[key] for key in os.environ if key.startswith('COMPOSE_')}}) + '\\n')
command = next((value for value in ('issue', 'revoke') if value in args), None)
if command == 'issue':
    output = args[args.index('--output') + 1]
    pathlib.Path(output).write_text(json.dumps({'run_id': 'a' * 32, 'token': 'b' * 64}) + '\\n', encoding='utf-8')
    os.chmod(output, 0o600)
    root = pathlib.Path(os.environ['PI_STACK_ROOT'])
    print(json.dumps({'runId': 'a' * 32, 'credentialFile': output, 'socketPath': str(root / 'data/hub/chat-runtime/registry.sock')}))
elif command == 'revoke':
    print(json.dumps({'revoked': True}))
elif tool == 'docker' and args and args[0] == 'compose':
    wait_file = os.environ.get('FAKE_COMPOSE_WAIT_FILE')
    while wait_file and not pathlib.Path(wait_file).exists():
        time.sleep(0.05)
    raise SystemExit(int(os.environ.get('FAKE_COMPOSE_EXIT', '0')))
else:
    raise SystemExit(71)
`;
  for (const name of ['docker', 'node']) {
    await writeFile(path.join(fakeBin, name), fakeTool, {mode: 0o700});
  }

  const cleanEnvironment = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C.UTF-8',
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_NODE_LOG: nodeLog,
    PI_PIRUN_CONFIG_DIR: legacy,
    PI_PIRUN_IMAGE: `sha256:${'9'.repeat(64)}`,
    PI_PIRUN_MODELS_DIR: path.join(legacy, 'models'),
    PI_PIRUN_DOCKER_BIN: path.join(fakeBin, 'must-not-be-used'),
    COMPOSE_FILE: '/poison/compose.yaml',
    COMPOSE_PROJECT_NAME: 'poison-project',
    COMPOSE_PROFILES: 'poison-profile',
    COMPOSE_ENV_FILES: '/poison/.env',
    COMPOSE_PATH_SEPARATOR: '?',
    HTTP_PROXY: 'http://127.0.0.1:18080',
    SUB2API_OPENAI_API_KEY: 'test-api-secret',
  };
  const run = (args = [], env = {}, cwd = workspace) => spawnSync(
    path.join(bin, 'pirun'),
    args,
    {cwd, env: {...cleanEnvironment, ...env}, encoding: 'utf8'},
  );
  const start = (args = [], env = {}, cwd = workspace) => {
    const child = spawn(path.join(bin, 'pirun'), args, {
      cwd,
      env: {...cleanEnvironment, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal, output})));
    return {child, closed};
  };
  const records = async file => {
    if (!await exists(file)) return [];
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  t.after(async () => rm(temporary, {recursive: true, force: true}));
  return {temporary, root, bin, workspace, home, legacy, screenshotSource, dockerLog, nodeLog, run, start, records};
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  assert.notEqual(index, -1, `missing ${option} in ${JSON.stringify(args)}`);
  return args[index + 1];
}

function hasPair(args, option, value) {
  return args.some((item, index) => item === option && args[index + 1] === value);
}

test('installed launcher infers ROOT and emits only the clean noninteractive Compose contract', async t => {
  const f = await fixture(t);
  const result = f.run(['--mode', 'rpc'], {PI_PIRUN_WEB_HUB: 'off'});
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.records(f.dockerLog);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 11), [
    'compose', '-f', path.join(f.root, 'compose.yaml'), '--env-file', '/dev/null',
    '--project-directory', f.root, '--project-name', 'pi-stack', 'run', '--rm',
  ]);
  assert(hasPair(args, '-v', `${f.workspace}:/workspace`));
  assert(hasPair(args, '-v', `${path.join(f.home, '.ssh')}:/run/host-ssh:ro`));
  assert(hasPair(args, '-v', `${path.join(f.home, '.bashrc')}:/home/node/.bashrc:ro`));
  assert(hasPair(args, '-v', `${path.join(f.home, '.cache/huggingface/token')}:/run/secrets/huggingface-token:ro`));
  assert(args.includes('--no-deps'));
  assert(args.includes('--interactive'));
  assert(args.includes('-T'));
  assert.match(optionValue(args, '--name'), /^pi-stack-pi-[a-f0-9]{16}$/);
  assert(!args.some(value => value.startsWith('cn.swordfate.pi.local-id=')), 'terminal launch gained a Web-only label');
  assert.deepEqual(args.slice(-3), ['pi', '--mode', 'rpc']);
  assert(!args.some(value => value.includes(f.legacy)));
  assert(!args.some(value => value.includes('pi-models')));
  assert(hasPair(args, '-e', 'HTTP_PROXY'));
  assert(hasPair(args, '-e', 'SUB2API_OPENAI_API_KEY'));
  assert(hasPair(args, '-e', 'PI_SCOPED_MEMORY_WORKSPACE_ID'));
  assert(hasPair(args, '-e', 'PI_SCOPED_MEMORY_WORKSPACE_ROOT'));
  assert.match(calls[0].workspace_id, /^host:[a-f0-9-]{36}:/);
  assert.equal(calls[0].workspace_root, '/workspace');
  assert.deepEqual(calls[0].compose_env, {COMPOSE_DISABLE_ENV_FILE: '1'});
  assert.match(await readFile(path.join(f.root, 'data/memory/host-id'), 'utf8'), /^[a-f0-9-]{36}\n$/);
});

test('LocalLauncher name is validated, used as container name, and copied to the local-id label', async t => {
  const f = await fixture(t);
  const name = `pi-local-${'c'.repeat(24)}`;
  const result = f.run(['--mode', 'rpc'], {
    PI_STACK_ROOT: f.root,
    PI_PIRUN_DOCKER_NAME: name,
    PI_PIRUN_WEB_HUB: 'on',
  });
  assert.equal(result.status, 0, result.stderr);
  assert(!`${result.stdout}${result.stderr}`.includes('b'.repeat(64)), 'credential token leaked');
  const calls = await f.records(f.dockerLog);
  assert.equal(calls.length, 3);
  assert(calls[0].args.includes('issue'));
  assert.equal(calls[1].args[0], 'compose');
  assert(calls[2].args.includes('revoke'));
  assert(hasPair(calls[1].args, '--name', name));
  assert(hasPair(calls[1].args, '--label', `cn.swordfate.pi.local-id=${name}`));
  assert(hasPair(calls[1].args, '-e', 'PI_WEB_UI_DISABLED=0'));
  assert(hasPair(calls[1].args, '-e', 'PI_WEB_UI_HOST=127.0.0.1'));
  assert(hasPair(calls[1].args, '-e', 'PI_WEB_UI_REGISTRY_SOCKET=/run/pi-web-hub/registry.sock'));
  assert(hasPair(calls[1].args, '-e', 'PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=/run/secrets/pi-web-session.json'));
  assert(hasPair(calls[1].args, '-v', `${path.join(f.root, 'data/hub/chat-runtime')}:/run/pi-web-hub:ro`));
  const credentialMount = calls[1].args.find((value, index) => calls[1].args[index - 1] === '-v' && value.endsWith(':/run/secrets/pi-web-session.json:ro'));
  assert.equal(credentialMount, `${path.join(f.root, 'data/hub/launches', 'a'.repeat(32), 'credential.json')}:/run/secrets/pi-web-session.json:ro`);
  assert.match(optionValue(calls[0].args, '--output'), new RegExp(`${path.join(f.root, 'data/hub/launches').replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}/stage-[a-f0-9]{32}/credential\\.json$`));
  assert.deepEqual(await readdir(path.join(f.root, 'data/hub/launches')), []);

  const invalid = f.run([], {
    PI_STACK_ROOT: f.root,
    PI_PIRUN_DOCKER_NAME: 'bad name',
    PI_PIRUN_WEB_HUB: 'off',
  });
  assert.equal(invalid.status, 2);
});

test('inside Hub uses its local node CLI and never docker exec for credential lifecycle', async t => {
  const f = await fixture(t);
  const result = f.run(['--mode', 'rpc'], {
    PI_STACK_ROOT: f.root,
    PI_STACK_IN_HUB: '1',
    PI_PIRUN_WEB_HUB: 'on',
  });
  assert.equal(result.status, 0, result.stderr);
  const dockerCalls = await f.records(f.dockerLog);
  const nodeCalls = await f.records(f.nodeLog);
  assert.equal(dockerCalls.length, 1);
  assert.equal(dockerCalls[0].args[0], 'compose');
  assert.equal(nodeCalls.length, 2);
  assert(nodeCalls[0].args.includes('issue'));
  assert(nodeCalls[1].args.includes('revoke'));
  assert(!dockerCalls.some(call => call.args.includes('exec')));
});

test('package commands skip Web registration while ordinary terminal sessions require it by default', async t => {
  const f = await fixture(t);
  const maintenance = f.run(['list'], {PI_STACK_ROOT: f.root});
  assert.equal(maintenance.status, 0, maintenance.stderr);
  let calls = await f.records(f.dockerLog);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'compose');
  assert(!calls[0].args.some(value => value.includes('PI_WEB_UI_')));

  await rm(f.dockerLog, {force: true});
  const session = f.run([], {PI_STACK_ROOT: f.root});
  assert.equal(session.status, 0, session.stderr);
  calls = await f.records(f.dockerLog);
  assert(calls[0].args.includes('issue'));
  assert(calls.at(-1).args.includes('revoke'));
});

test('workspace protection and fixed config/model sources fail closed without legacy fallbacks', async t => {
  const f = await fixture(t);
  const protectedResult = f.run([], {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off'}, path.join(f.root, 'data'));
  assert.equal(protectedResult.status, 2);
  assert.match(protectedResult.stderr, /workspace.*stack/i);
  assert.equal((await f.records(f.dockerLog)).length, 0);

  await writeFile(path.join(f.root, 'config/pi.json'), `${JSON.stringify({image: 'legacy:latest'})}\n`, {mode: 0o600});
  const invalidConfig = f.run([], {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off'});
  assert.notEqual(invalidConfig.status, 0);
  assert.equal((await f.records(f.dockerLog)).length, 0);

  const validConfig = {
    image,
    screenshots: {enabled: false, source: f.screenshotSource},
    mounts: {ssh: false, bashrc: false, huggingface: false},
    volumes: {home: 'a', runtime: 'b', agent: 'c', credentials: 'd', huggingface: 'e'},
  };
  await writeFile(path.join(f.root, 'config/pi.json'), `${JSON.stringify(validConfig)}\n`, {mode: 0o600});
  const model = path.join(f.root, 'pi-models/models.json');
  const external = path.join(f.temporary, 'old-models.json');
  await writeFile(external, '{}\n');
  await rm(model);
  await symlink(external, model);
  const symlinkedModel = f.run([], {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off'});
  assert.notEqual(symlinkedModel.status, 0);
  assert.match(symlinkedModel.stderr, /models\.json/i);
});

test('screenshot mode mounts only the current project attachments and removes them after the last launch exits', async t => {
  const f = await fixture(t, {config: {screenshots: {enabled: true, source: ''}}});
  const configFile = path.join(f.root, 'config/pi.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.screenshots.source = f.screenshotSource;
  await writeFile(configFile, `${JSON.stringify(config)}\n`, {mode: 0o600});
  await writeFile(path.join(f.screenshotSource, 'QQ_ready.png'), 'complete-image');
  const result = f.run([], {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off'});
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.records(f.dockerLog);
  const attachments = path.join(f.workspace, '.pi-attachments');
  assert(hasPair(calls[0].args, '-v', `${attachments}:/workspace/.pi-attachments:ro`));
  assert.equal(await exists(attachments), undefined);
  assert((await readdir(path.join(f.root, 'data/screenshots'))).some(name => name.includes('pi-qq-bridge-')));
});

test('two launches in one workspace share the watcher and only the last exit removes attachments', async t => {
  const f = await fixture(t, {config: {screenshots: {enabled: true, source: ''}}});
  const configFile = path.join(f.root, 'config/pi.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.screenshots.source = f.screenshotSource;
  await writeFile(configFile, `${JSON.stringify(config)}\n`, {mode: 0o600});
  await writeFile(path.join(f.screenshotSource, 'QQ_first.png'), 'first');
  const gate = path.join(f.temporary, 'release-compose');
  const env = {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off', FAKE_COMPOSE_WAIT_FILE: gate};
  const first = f.start([], env);
  const attachments = path.join(f.workspace, '.pi-attachments');
  await waitFor(async () => await exists(path.join(attachments, 'latest.png')), 'first launcher did not start screenshot watcher');
  const second = f.start([], env);
  const lifecycleKey = createHash('sha256').update(`${f.workspace}\n${attachments}\n`).digest('hex').slice(0, 16);
  const lifecycle = path.join(f.root, 'data/screenshots', `pi-qq-bridge-${lifecycleKey}.lifecycle`);
  await waitFor(async () => (await readdir(lifecycle)).filter(name => name.startsWith('session.')).length === 2, 'launchers did not share lifecycle counters');

  first.child.kill('SIGTERM');
  const firstExit = await first.closed;
  assert.equal(firstExit.code, 143, firstExit.output);
  assert(await exists(attachments), 'first exit removed shared attachments');
  await writeFile(path.join(f.screenshotSource, 'QQ_second.png'), 'second');
  await waitFor(async () => await readFile(path.join(attachments, 'latest.png'), 'utf8') === 'second', 'surviving launcher did not preserve or take over watcher');

  await writeFile(gate, 'release');
  const secondExit = await second.closed;
  assert.equal(secondExit.code, 0, secondExit.output);
  await waitFor(async () => !await exists(attachments), 'last exit did not remove attachments');
});

test('an active legacy tmp lifecycle cannot divert the clean launcher from ROOT data', async t => {
  const f = await fixture(t, {config: {screenshots: {enabled: true, source: ''}}});
  const configFile = path.join(f.root, 'config/pi.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.screenshots.source = f.screenshotSource;
  await writeFile(configFile, `${JSON.stringify(config)}\n`, {mode: 0o600});
  const attachments = path.join(f.workspace, '.pi-attachments');
  const key = createHash('sha256').update(`${f.workspace}\n${attachments}\n`).digest('hex').slice(0, 16);
  const legacy = `/tmp/pi-qq-bridge-${key}.lifecycle`;
  await mkdir(legacy, {mode: 0o700});
  const raw = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await writeFile(path.join(legacy, 'session.live'), `${process.pid}\t${start}\t${boot}\n`, {mode: 0o600});
  t.after(() => rm(legacy, {recursive: true, force: true}));

  const result = f.run([], {PI_STACK_ROOT: f.root, PI_PIRUN_WEB_HUB: 'off'});
  assert.equal(result.status, 0, result.stderr);
  assert(await exists(path.join(f.root, 'data/screenshots', `pi-qq-bridge-${key}.lifecycle`)));
  assert(await exists(path.join(legacy, 'session.live')), 'clean launcher mutated legacy coordination state');
});

test('QQ bridge refuses to invent a legacy source or lock path', async t => {
  const f = await fixture(t);
  const result = spawnSync(path.join(f.bin, 'pi-qq-bridge'), ['--once'], {
    cwd: f.workspace,
    env: {PATH: '/usr/bin:/bin'},
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source.*lock paths are required/i);
});
