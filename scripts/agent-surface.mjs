import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');
const DOCS = [
  ['docs/PRODUCT.md', 'docs/product.md'],
  ['docs/work-package.md', 'docs/work-package.md'],
  ['docs/webhook-delivery.md', 'docs/webhook-delivery.md'],
  ['SECURITY.md', 'docs/security.md'],
];

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('SKILL.md is missing YAML frontmatter');
  const name = match[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*["']([^"']+)["']\s*$/m)?.[1]?.trim();
  if (!name || !description) {
    throw new Error('SKILL.md frontmatter must include name and a quoted description');
  }
  return { name, description };
}

export async function listAgentSkills() {
  const names = (await readdir(SKILLS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills = [];
  for (const name of names) {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    const source = await readFile(file, 'utf8');
    const meta = parseFrontmatter(source);
    if (meta.name !== name) {
      throw new Error(`Skill folder ${name} does not match frontmatter name ${meta.name}`);
    }
    const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    skills.push({
      name,
      type: 'skill-md',
      description: meta.description,
      url: `/.well-known/skills/${name}/SKILL.md`,
      digest,
      source,
    });
  }
  return skills;
}

export function skillIndexPayload(skills) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: skills.map(({ name, type, description, url, digest }) => ({
      name,
      type,
      description,
      url,
      digest,
    })),
  };
}

export async function stageAgentSurface(webDist) {
  const dist = resolve(webDist);
  const skills = await listAgentSkills();
  for (const skill of skills) {
    const directory = join(dist, '.well-known', 'skills', skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), skill.source);
  }
  await mkdir(join(dist, '.well-known', 'agent-skills'), { recursive: true });
  await writeFile(
    join(dist, '.well-known', 'agent-skills', 'index.json'),
    `${JSON.stringify(skillIndexPayload(skills), null, 2)}\n`,
  );
  for (const [from, to] of DOCS) {
    const target = join(dist, to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(ROOT, from), target);
  }
}

function send(res, status, body, type) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(body);
  return true;
}

export function agentSurfacePlugin() {
  return {
    name: 'agent-surface',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = req.url?.split('?')[0] ?? '';
          if (url === '/.well-known/agent-skills/index.json') {
            const skills = await listAgentSkills();
            return send(
              res,
              200,
              `${JSON.stringify(skillIndexPayload(skills), null, 2)}\n`,
              'application/json; charset=utf-8',
            );
          }
          const skillMatch = url.match(/^\/\.well-known\/skills\/([a-z0-9-]+)\/SKILL\.md$/);
          if (skillMatch) {
            const file = join(SKILLS_DIR, skillMatch[1], 'SKILL.md');
            return send(res, 200, await readFile(file, 'utf8'), 'text/markdown; charset=utf-8');
          }
          const doc = DOCS.find(([, to]) => url === `/${to}`);
          if (doc) {
            return send(
              res,
              200,
              await readFile(join(ROOT, doc[0]), 'utf8'),
              'text/markdown; charset=utf-8',
            );
          }
        } catch {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        next();
      });
    },
    async writeBundle(options) {
      const outDir = options.dir ?? join(ROOT, 'apps/web/dist');
      await stageAgentSurface(outDir);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await stageAgentSurface(process.argv[2] ?? join(ROOT, 'apps/web/dist'));
}
