import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PUBLIC_AGENT_SKILLS } from './agent-skills.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('public agent skills', () => {
  it('keeps catalog descriptions identical to SKILL.md frontmatter', async () => {
    expect(PUBLIC_AGENT_SKILLS.length).toBeGreaterThan(0);
    for (const skill of PUBLIC_AGENT_SKILLS) {
      const source = await readFile(join(repoRoot, 'skills', skill.name, 'SKILL.md'), 'utf8');
      const name = source.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
      const description = source.match(/^description:\s*["']([^"']+)["']\s*$/m)?.[1];
      expect(name).toBe(skill.name);
      expect(description).toBe(skill.description);
      expect(skill.description.length).toBeGreaterThan(80);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
    }
  });
});
