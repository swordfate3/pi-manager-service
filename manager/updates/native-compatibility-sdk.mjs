// Only this short-lived owned child imports the candidate SDK, never the executor.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdk = await import(pathToFileURL(config.module).href);
if (sdk.VERSION !== config.version || sdk.CURRENT_SESSION_VERSION !== 3) throw Error('Unsupported candidate SDK/version');
const session = sdk.SessionManager.open(config.file, config.sessions, config.workspace);
const result = { version: sdk.VERSION, format: sdk.CURRENT_SESSION_VERSION, node: process.version, abi: process.versions.modules,
  sessionId: session.getSessionId(), leafId: session.getLeafId(), messages: session.buildSessionContext().messages };
const bytes = JSON.stringify(result);
if (Buffer.byteLength(bytes) > 2 * 1024 ** 2) throw Error('SDK output bound');
process.stdout.write(bytes);
