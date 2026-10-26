// Test-only fixed synthetic provider. Resolve against the actual selected CLI,
// not an ambient developer peer, so one administrator profile works across the
// two official/development installations without mutating either dependency tree.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const scope = path.resolve(path.dirname(process.argv[1]), '../../..');
const ai = path.join(scope, 'pi-ai');
const manifest = JSON.parse(readFileSync(path.join(ai, 'package.json'), 'utf8'));
const exported = name => {
  const value = manifest.exports[name];
  const selected = typeof value === 'string' ? value : value.import;
  if (typeof selected !== 'string' || !selected.startsWith('./dist/') || selected.includes('..')) throw Error('Unexpected selected peer export');
  return pathToFileURL(path.join(ai, selected)).href;
};
const { fauxAssistantMessage } = await import(exported('.'));
const { registerFauxProvider, getApiProvider } = await import(exported('./compat'));
export default function (pi) {
  const faux = registerFauxProvider({ provider: 'native-selected-fixture', models: [{ id: 'fixed', name: 'Selected runtime fixture', reasoning: false }] });
  faux.setResponses(Array.from({ length: 12 }, () => async () => fauxAssistantMessage('SELECTED_OK 中文🙂')));
  const model = faux.getModel();
  pi.registerProvider('native-selected-fixture', { name: 'Selected runtime fixture', baseUrl: model.baseUrl, apiKey: 'synthetic', api: faux.api,
    streamSimple: getApiProvider(faux.api).streamSimple, models: faux.models.map(m => ({ ...m, api: faux.api })) });
  pi.on('session_shutdown', () => { faux.unregister(); pi.unregisterProvider('native-selected-fixture'); });
}
