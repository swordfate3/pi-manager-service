import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A missing implementation produces observable unsafe state; actual import errors
// are never swallowed. This fixture is not a replacement production guard.
if (existsSync(process.argv[2])) await import(pathToFileURL(process.argv[2]).href);
const guard = () => globalThis[Symbol.for('pi.runtime.stdin-guard.v1')];
let input = '', delivered = 0;
const rawWrite = process.stdout.write.bind(process.stdout);
function output(value) { rawWrite(JSON.stringify(value) + '\n'); }
process.stdin.on('data', data => {
  delivered++;
  input += data.toString('utf8');
  let index;
  while ((index = input.indexOf('\n')) >= 0) {
    const raw = input.slice(0, index); input = input.slice(index + 1);
    let frame;
    try { frame = JSON.parse(raw); } catch { continue; }
    if (frame.type === 'get_state') output({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} });
    if (frame.type === 'prompt') {
      if (frame.message === 'handled') { output({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { disposition: 'handled' } }); continue; }
      output({ type: 'agent_start' });
      output({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { disposition: 'started' } });
    }
  }
});
const owner = Object.freeze({}), stranger = Object.freeze({});
process.on('message', message => {
  const g = guard(); let value;
  switch (message.action) {
    case 'state': value = { exists: !!g, safe: g?.safe() ?? false, intact: g?.intact() ?? false, transport: g?.transport, delivered, frozen: !!g && Object.isFrozen(g) }; break;
    case 'freeze': value = g?.freeze(owner, message.operation) ?? false; break;
    case 'release': value = g?.release(message.stranger ? stranger : owner, message.operation) ?? false; break;
    case 'agent_end': output({ type: 'agent_end' }); value = true; break;
    case 'settle': output({ type: 'agent_settled', aborted: false }); value = true; break;
    case 'output': rawWrite(message.chunk); value = true; break;
    // Pi captures the raw writer then redirects ordinary stdout to stderr.
    case 'takeover': process.stdout.write = function (chunk, callback) { return process.stderr.write(chunk, callback); }; value = true; break;
    case 'taint': g?.taint(); value = true; break;
    case 'web-prompt': value = g?.dispatchPrompt?.(message.text) ?? false; break;
    case 'tamper': if (message.channel === 'stdin') process.stdin.emit = function () { return false; }; else process.stdout._write = function (_chunk, _encoding, callback) { callback(); }; value = true; break;
    case 'shutdown': g?.shutdown(owner); value = true; break;
    case 'exit': process.exit(0); break;
    default: throw Error('Unknown fixture control');
  }
  process.send({ id: message.id, value });
});
process.send({ ready: true });
