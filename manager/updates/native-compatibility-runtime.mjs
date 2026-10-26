// Fixed SDK/RPC restore host. The candidate CLI independently proves its launch
// behavior; unlike CLI --session, this supported SDK seam keeps cwd private
// without rewriting the saved header or changing the selected session/leaf.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, 'restore-runtime.json'), 'utf8'));
if (process.cwd() !== config.workspace || process.argv[process.argv.indexOf('--session') + 1] !== config.file) throw Error('Unexpected restore host inputs');
const sdk = await import(pathToFileURL(config.module).href);
if (sdk.VERSION !== config.version || sdk.CURRENT_SESSION_VERSION !== 3) throw Error('Unsupported SDK runtime');
const cwd = config.workspace, agentDir = process.env.PI_AGENT_DIR;
const sessionManager = sdk.SessionManager.open(config.file, path.dirname(config.file), cwd);
const runtime = await sdk.createAgentSessionRuntime(async options => {
  if (options.cwd !== cwd || options.sessionManager !== sessionManager) throw Error('Session replacement prohibited');
  const services = await sdk.createAgentSessionServices({ cwd, agentDir,
    resourceLoaderOptions: { additionalExtensionPaths: [path.join(root, 'provider.mjs'), path.join(root, 'web/extensions/mirror-server.ts')],
      noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
  if (services.diagnostics.some(d => d.type === 'error') || services.resourceLoader.getExtensions().errors.length) throw Error('Extension loading failed');
  const model = services.modelRuntime.getModel(config.provider, config.model);
  if (!model) throw Error('Synthetic source model unavailable');
  const created = await sdk.createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: config.thinking,
    tools: [], noTools: 'all' });
  return { ...created, services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager });
await sdk.runRpcMode(runtime);
