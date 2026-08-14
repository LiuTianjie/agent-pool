import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const runnerRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(runnerRoot, 'dist');
const outputFile = resolve(outputDirectory, 'agentpool');

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(runnerRoot, 'src/index.ts')],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod(outputFile, 0o755);

const digest = createHash('sha256')
  .update(await readFile(outputFile))
  .digest('hex');
await writeFile(resolve(outputDirectory, 'agentpool.sha256'), `${digest}  agentpool\n`, {
  mode: 0o644,
});
