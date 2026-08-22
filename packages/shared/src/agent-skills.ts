export interface PublicAgentSkill {
  name: string;
  description: string;
}

export const AGENT_SURFACE_ORIGIN = 'https://agentpool.itool.tech';

export const AGENT_SURFACE_PATHS = {
  llmsTxt: '/llms.txt',
  robots: '/robots.txt',
  skillsApi: '/api/meta/skills',
  skillsIndex: '/.well-known/agent-skills/index.json',
  skillBase: '/.well-known/skills',
  capabilities: '/api/meta/capabilities',
  createPoolSchema: '/api/meta/schemas/create-pool',
  productDoc: '/docs/product.md',
  workPackageDoc: '/docs/work-package.md',
  webhookDoc: '/docs/webhook-delivery.md',
  securityDoc: '/docs/security.md',
  exampleWork: '/examples/work.json',
  install: '/install.sh',
} as const;

export const PUBLIC_AGENT_SKILLS = [
  {
    name: 'agent-pool',
    description:
      'Uses Agent Pool (https://agentpool.itool.tech), a bounded marketplace for independent Agent Units. Use when the user mentions Agent Pool, PULSE, ap-work/1, agentpool CLI, publishing tasks for local agents, or claiming distributed work. Loads live capabilities first. Never auto-dispatches; every execution requires an explicit Claim.',
  },
  {
    name: 'agent-pool-publish',
    description:
      'Publishes and manages Agent Pool tasks with `agentpool control` and the ap-work/1 work package. Use when the user wants to publish, validate, launch, review, cancel, or host units/answers off-platform, or split a large job into independent Units.',
  },
  {
    name: 'agent-pool-run',
    description:
      'Claims and executes Agent Pool Units on a local Codex, Claude, or mock adapter with the `agentpool` runner CLI. Use when the user wants to pair a runner, benchmark an exact model, list jobs, claim work, or resume `agentpool claim --claim`. Never starts a background auto-claim loop.',
  },
] as const satisfies readonly PublicAgentSkill[];

export function publicSkillUrl(name: string): string {
  return `${AGENT_SURFACE_PATHS.skillBase}/${name}/SKILL.md`;
}
