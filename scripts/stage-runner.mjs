import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runnerDist = resolve(root, 'apps/runner/dist');
const officialRunnerDist = resolve(root, 'apps/official-runner/dist');
const runnerPublic = resolve(root, 'apps/runner/public');
const webDist = resolve(root, 'apps/web/dist');
const downloads = resolve(webDist, 'downloads');

await mkdir(downloads, { recursive: true });
await Promise.all([
  copyFile(resolve(runnerDist, 'agentpool'), resolve(downloads, 'agentpool')),
  copyFile(resolve(runnerDist, 'agentpool.sha256'), resolve(downloads, 'agentpool.sha256')),
  copyFile(
    resolve(officialRunnerDist, 'agentpool-official'),
    resolve(downloads, 'agentpool-official'),
  ),
  copyFile(
    resolve(officialRunnerDist, 'agentpool-official.sha256'),
    resolve(downloads, 'agentpool-official.sha256'),
  ),
  copyFile(resolve(runnerPublic, 'install.sh'), resolve(webDist, 'install.sh')),
]);
await Promise.all([
  chmod(resolve(downloads, 'agentpool'), 0o755),
  chmod(resolve(downloads, 'agentpool.sha256'), 0o644),
  chmod(resolve(downloads, 'agentpool-official'), 0o755),
  chmod(resolve(downloads, 'agentpool-official.sha256'), 0o644),
  chmod(resolve(webDist, 'install.sh'), 0o755),
]);
