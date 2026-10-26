// Fixed trusted instrumentation. Imported SDK/provider code resolves ONLY from /candidate.
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectedModule } from './compatibility-inputs.ts';
const load = async (name, subpath) => import(pathToFileURL(await selectedModule('/candidate', name, subpath)).href);
const { fauxAssistantMessage } = await load('@earendil-works/pi-ai');
const { registerFauxProvider, getApiProvider } = await load('@earendil-works/pi-ai', './compat');
const { VERSION, CURRENT_SESSION_VERSION } = await load('@earendil-works/pi-coding-agent');
export default function (pi) {
  const root = process.env.PI_COMPAT_TRACE;
  if (!['/work/first', '/work/restored'].includes(root)) throw Error('Unexpected trace root');
  const record = (event, fields = {}) => {
    const f = root + '/trace.jsonl';
    if (existsSync(f) && statSync(f).size > 65536) throw Error('Trace bound');
    appendFileSync(f, JSON.stringify({ event, ...fields }) + '\n', { mode: 0o600 });
  };
  const faux = registerFauxProvider({ provider: 'compatibility-offline', models: [{ id: 'fixed', name: 'Offline compatibility', reasoning: false }] });
  faux.setResponses(Array.from({ length: 5 }, () => async context => {
    const user = context.messages.findLast(m => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : user?.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!['COMPAT_GENERATE', 'COMPAT_RESUME', 'COMPAT_WEB'].includes(text)) throw Error('Unexpected model input');
    record('model', { text });
    if (text === 'COMPAT_GENERATE') {
      const until = Date.now() + 15000;
      while (!existsSync(root + '/release')) { if (Date.now() >= until) throw Error('Provider deadline'); await new Promise(r => setTimeout(r, 10)); }
    }
    return fauxAssistantMessage('COMPAT_RESPONSE');
  }));
  const model = faux.getModel();
  pi.registerProvider('compatibility-offline', { name: 'Offline compatibility', baseUrl: model.baseUrl, apiKey: 'synthetic', api: faux.api,
    // The CLI bundle and SDK module need not share a global API registry. Use the
    // supported extension registration seam for the selected SDK's model stream.
    streamSimple: getApiProvider(faux.api).streamSimple,
    models: faux.models.map(m => ({ ...m, api: faux.api })) });
  let timer;
  pi.on('session_start', (_event, ctx) => {
    record('session', { version: VERSION, format: CURRENT_SESSION_VERSION, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() });
    timer = setInterval(() => {
      if (!process.stdin.listenerCount('data')) return;
      clearInterval(timer); record('ready');
    }, 10);
  });
  pi.on('tool_call', () => { record('tool'); throw Error('Tools prohibited'); });
  pi.on('session_shutdown', () => { clearInterval(timer); faux.unregister(); pi.unregisterProvider('compatibility-offline'); });
}
