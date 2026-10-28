// The exact module source supplied to `node --input-type=module -e` in the Pi.
export const PI_LOGS_SOURCE = String.raw`import {readFile} from 'node:fs/promises'; const read=async p=>(await readFile(p,'utf8')).trim().split('\n').map(JSON.parse); console.log(JSON.stringify({provider:await read('/home/node/acceptance.jsonl'),profile:await read('/home/node/profile-acceptance.jsonl')}));`;
