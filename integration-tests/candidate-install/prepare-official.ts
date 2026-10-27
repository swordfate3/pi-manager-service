/** Fresh official provenance after a previous disposable artifact directory expires. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReleaseCatalog, PI_PACKAGE } from '../../manager/updates/catalog.ts';
import { ArtifactStager } from '../../manager/updates/stage.ts';

const release = await new ReleaseCatalog().resolve(PI_PACKAGE, '1.4.0');
// This is a new official resolution/download, never a synthetic replacement
// for the missing prior receipt. Preserve its independently recorded identity.
assert.equal(release.identity, 'cc8118c0789be893ddd2190eb8558f26b68b22770f42b53f32310032ab5f3bc0');
const parent = await mkdtemp('/tmp/manager-official-artifacts-');
await writeFile(path.join(parent, 'resolved-release.json'), JSON.stringify(release) + '\n', { flag: 'wx', mode: 0o600 });
const stager = await ArtifactStager.create({ root: path.join(parent, 'artifacts'), nodeVersion: '24.21.0' });
const prepared = await stager.stage({ installationId: 'official-pi-1.4.0', release, expectedIdentity: release.identity });
console.log(JSON.stringify({ freshOfficialProvenance: true, parent, originalOldArtifactUsed: false,
  artifact: path.join(parent, 'artifacts', prepared.candidateKey), release, contentSha256: prepared.contentSha256 }));
