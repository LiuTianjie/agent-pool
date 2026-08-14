import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const appRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(appRoot, 'dist');
const outputFile = resolve(outputDirectory, 'agentpool-official');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(appRoot, 'src/index.ts')],
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
await writeFile(
  resolve(outputDirectory, 'agentpool-official.sha256'),
  `${digest}  agentpool-official\n`,
  { mode: 0o644 },
);
