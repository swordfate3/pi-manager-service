import net from 'node:net';
import { chmod, chown, lstat, unlink } from 'node:fs/promises';

const LIMIT = 8192;
export async function serve(socketPath, gid, handle) {
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Refusing to replace foreign socket');
    await unlink(socketPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = net.createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {}); // Per-client disconnect cannot terminate the executor.
    let data = '', handled = false;
    socket.on('data', chunk => {
      if (handled) return socket.destroy();
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > LIMIT) return socket.destroy();
      if (!data.endsWith('\n')) return;
      handled = true;
      Promise.resolve().then(() => handle(JSON.parse(data))).then(
        value => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
        error => socket.end(`${JSON.stringify({ ok: false, error: error.message.slice(0, 256) })}\n`),
      );
    });
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chown(socketPath, process.getuid(), gid);
  await chmod(socketPath, 0o660);
  return server;
}

export function rpc(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '', done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(4000, () => finish(new Error('RPC timeout')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > LIMIT) return finish(new Error('RPC response too large'));
      if (!data.endsWith('\n')) return;
      try { finish(null, JSON.parse(data)); } catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!done) finish(new Error('RPC ended without a complete response')); });
  });
}

export async function connectOnly(socketPath) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(1500, () => socket.destroy(new Error('Connect timeout')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}
