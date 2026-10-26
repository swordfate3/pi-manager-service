import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ArtifactStager } from '../../manager/updates/stage.ts';
import { releaseFromMetadata, PI_PACKAGE } from '../../manager/updates/release.ts';

export const IMAGE = 'sha256:2fb6042d97483028479957719ac4d4ffe4d1ef8283f2b63fbcbf306a960f3ec6';
export const DAEMON = 'bac0be49-8ddb-4387-83aa-362f70f3ae8d';
export function artifact(extra: Record<string, unknown> = {}) {
  const manifest = { name: PI_PACKAGE, version: '2099.10.26', engines: { node: '>=20.0.0' },
    bin: { pi: 'cli.js' }, scripts: { preinstall: 'touch /work/LIFECYCLE-RAN', install: 'touch /work/LIFECYCLE-RAN', postinstall: 'touch /work/LIFECYCLE-RAN' }, ...extra };
  const blocks: Buffer[] = [];
  for (const [name, text] of [['package/package.json', JSON.stringify(manifest)], ['package/cli.js', "throw new Error('candidate must never run')"]]) {
    const data = Buffer.from(text), header = Buffer.alloc(512);
    header.write(name); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  const data = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const release = releaseFromMetadata({ ...manifest, dist: { tarball: `https://registry.npmjs.org/${PI_PACKAGE}/-/pi-coding-agent-${manifest.version}.tgz`,
    integrity: 'sha512-' + createHash('sha512').update(data).digest('base64') } }, PI_PACKAGE, manifest.version);
  return { data, release };
}
export async function prepared(root: string, extra: Record<string, unknown> = {}) {
  const { data, release } = artifact(extra);
  const stager = await ArtifactStager.create({ root, nodeVersion: '24.21.0', transport: async ({ url, accept }) => {
    void accept;
    return { url, statusCode: 200, headers: {}, body: (async function* () { yield data; })() };
  } });
  const receipt = await stager.stage({ installationId: 'test-install', release, expectedIdentity: release.identity });
  return { data, release, receipt, request: { installationId: 'test-install', release, expectedIdentity: release.identity, preparedKey: receipt.candidateKey } };
}
