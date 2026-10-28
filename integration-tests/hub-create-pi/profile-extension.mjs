// Explicit synthetic profile extension: no ambient provider credentials or external I/O.
import assert from 'node:assert/strict';
import { appendFileSync, lstatSync, openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => {
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), 1000);
    assert.equal(process.env.PI_OFFLINE, undefined);
    const agent = '/home/node/.pi/manager-agent';
    assert.equal(lstatSync(agent).uid, 1000);
    for (const name of ['auth.json', 'settings.json', 'model-store.json']) {
      const file = `${agent}/${name}`;
      if (!existsSync(file)) writeFileSync(file, '{}', { flag: 'wx', mode: 0o600 });
      const fd = openSync(file, 'r+'); closeSync(fd);
      assert.equal(lstatSync(file).uid, 1000);
    }
    assert.throws(() => openSync(`${agent}/models.json`, 'r+'), { code: 'EROFS' });
    appendFileSync('/home/node/profile-acceptance.jsonl', JSON.stringify({ uid: process.getuid(), gid: process.getgid(), writable: ['auth.json', 'settings.json', 'model-store.json'], modelsReadOnly: true, online: true }) + '\n');
  });
}
