// Fixed trusted-local instrumentation. Loaded only in the owned candidate CLI.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, 'provider.json'), 'utf8'));
const { fauxAssistantMessage } = await import(pathToFileURL(config.ai).href);
const { registerFauxProvider, getApiProvider } = await import(pathToFileURL(config.compat).href);
export default function (pi) {
  const faux = registerFauxProvider({ provider: config.provider, models: [{ id: config.model, name: 'Private native preflight', reasoning: false }] });
  faux.setResponses(Array.from({ length: 8 }, () => async context => {
    const last = context.messages.findLast(m => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : last?.content?.map(b => b.text ?? '').join('');
    if (!['NATIVE_SEED', 'NATIVE_BUSY', 'NATIVE_RELEASED'].includes(text)) throw Error('Unexpected synthetic input');
    if (text === 'NATIVE_BUSY') {
      writeFileSync(path.join(root, 'busy'), '1', { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!existsSync(path.join(root, 'release'))) {
        if (Date.now() > deadline) throw Error('Synthetic provider deadline');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return fauxAssistantMessage('NATIVE_COMPAT_OK 中文🙂');
  }));
  const model = faux.getModel();
  pi.registerProvider(config.provider, { name: 'Private synthetic provider', baseUrl: model.baseUrl, apiKey: 'synthetic', api: faux.api,
    streamSimple: getApiProvider(faux.api).streamSimple, models: faux.models.map(m => ({ ...m, api: faux.api })) });
  pi.on('tool_call', () => { throw Error('Tools prohibited'); });
  pi.on('session_shutdown', () => { faux.unregister(); pi.unregisterProvider(config.provider); });
}
