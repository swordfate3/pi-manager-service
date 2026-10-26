// Copied into a private test profile and resolved ONLY against that profile's
// selected Pi peer tree. No user credentials, tools, external APIs or HOME scan.
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getApiProvider, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const faux = registerFauxProvider({ provider: 'native-update-fixture', models: [
    { id: 'fixed', name: 'Isolated native version acceptance', reasoning: false },
  ] });
  faux.setResponses(Array.from({ length: 8 }, () => async () => fauxAssistantMessage('NATIVE_VERSION_OK 中文🙂')));
  const model = faux.getModel();
  pi.registerProvider('native-update-fixture', {
    name: 'Native version acceptance', baseUrl: model.baseUrl, apiKey: 'synthetic', api: faux.api as never,
    streamSimple: getApiProvider(faux.api as never)!.streamSimple,
    models: faux.models.map(m => ({ ...m, api: faux.api as never })),
  });
  pi.on('session_shutdown', () => { faux.unregister(); pi.unregisterProvider('native-update-fixture'); });
}
