import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [
  ,
  ,
  imageReference,
  composeOutput = 'docker-compose.ci.yml',
  sidecarOutput = 'luma.ci.compose.yml',
] = process.argv;

if (!imageReference) {
  throw new Error('Usage: node scripts/render-ci-deployment.mjs <ghcr-image@sha256:digest>');
}

if (!/^(?:ghcr\.io|ghcr\.nju\.edu\.cn)\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(imageReference)) {
  throw new Error(
    'The deployment image must be an immutable lowercase GHCR or approved GHCR pull-through digest reference.',
  );
}

for (const output of [composeOutput, sidecarOutput]) {
  if (basename(output) !== output) {
    throw new Error('CI deployment outputs must be repository-root filenames.');
  }
}

const root = resolve(import.meta.dirname, '..');
const composeSource = await readFile(resolve(root, 'docker-compose.deploy.yml'), 'utf8');
const sidecarSource = await readFile(resolve(root, 'luma.compose.yml'), 'utf8');

const lines = composeSource.split('\n');
let insideApp = false;
let replacedImages = 0;

const renderedCompose = lines
  .map((line) => {
    if (line === '  app:') {
      insideApp = true;
      return line;
    }
    if (/^  [a-zA-Z0-9_-]+:$/.test(line) && line !== '  app:') {
      insideApp = false;
    }
    if (insideApp && /^    image:/.test(line)) {
      replacedImages += 1;
      return `    image: ${imageReference}`;
    }
    return line;
  })
  .join('\n');

if (replacedImages !== 1) {
  throw new Error(`Expected exactly one app image, found ${replacedImages}.`);
}

const composeDirective = 'compose: docker-compose.deploy.yml';
if (sidecarSource.split(composeDirective).length !== 2) {
  throw new Error('Expected one docker-compose.deploy.yml sidecar reference.');
}
const renderedSidecar = sidecarSource.replace(
  composeDirective,
  `compose: ${basename(composeOutput)}`,
);

await Promise.all([
  writeFile(resolve(root, composeOutput), renderedCompose, { encoding: 'utf8', flag: 'wx' }),
  writeFile(resolve(root, sidecarOutput), renderedSidecar, { encoding: 'utf8', flag: 'wx' }),
]);

process.stdout.write(`${imageReference}\n`);
