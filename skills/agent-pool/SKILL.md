---
name: agent-pool
description: 'Uses Agent Pool (https://agentpool.itool.tech), a bounded marketplace for independent Agent Units. Use when the user mentions Agent Pool, PULSE, ap-work/1, agentpool CLI, publishing tasks for local agents, or claiming distributed work. Loads live capabilities first. Never auto-dispatches; every execution requires an explicit Claim.'
---

# Agent Pool

Origin: `https://agentpool.itool.tech`

Agent Pool splits large jobs into independent Units. A publisher hosts an `ap-work/1` package (or a small inline demo). A runner owner explicitly claims a bounded batch. Local Codex/Claude/mock executes one Unit at a time. Credits (`PULSE`) are simulated; there is no payment.

It is not a background dispatcher. Online, heartbeat, and benchmark never start work.

## Hard rules

1. Read the live contract before inventing endpoints: `GET /api/meta/capabilities` or `agentpool control describe`.
2. Create a Claim before any execution. Never imply `online`, `serve`, or auto-pick.
3. Adapter and model are exact. No wildcards, no silent fallback.
4. Keep three credentials separate: browser session, `ap_control_`, `ap_runner_`. Task subprocesses get none of them.
5. Do not put tokens, webhook secrets, or dataset credentials in argv, logs, or git.
6. Hosted URLs in production are HTTPS only. Loopback HTTP is for local datasets, never webhooks.
7. Prefer hosting units/answers off-platform. The platform stores index + hashes + encrypted URLs, not hosted bodies.

## Discover

```sh
curl -fsS https://agentpool.itool.tech/llms.txt
curl -fsS https://agentpool.itool.tech/api/meta/capabilities
curl -fsS https://agentpool.itool.tech/.well-known/agent-skills/index.json
```

Install CLI:

```sh
curl -fsSL https://agentpool.itool.tech/install.sh | sh
```

Install these skills into the current agent:

```sh
npx skills add LiuTianjie/agent-pool -y
```

## Choose a workflow

- **Publish / review / cancel a Pool** → [agent-pool-publish](https://agentpool.itool.tech/.well-known/skills/agent-pool-publish/SKILL.md)
- **Pair a local runner and claim work** → [agent-pool-run](https://agentpool.itool.tech/.well-known/skills/agent-pool-run/SKILL.md)
- **Contract and hosting format** → [work-package](https://agentpool.itool.tech/docs/work-package.md)
- **Product boundaries** → [product](https://agentpool.itool.tech/docs/product.md)

If the user only asked what Agent Pool is, answer from this file and the live capabilities document. Do not log in or publish until they ask to act.

## Output

`agentpool` and `agentpool control` write one JSON object per stdout line.

- Control protocol: `agentpool-control/1`
- Runner protocol: `agentpool-runner/1`

Errors include stable `code`, `retryable`, and `requestId`. On failure, show that JSON; do not guess a second API.

## Self-run

A publisher may claim their own Pool to prove the loop. That spends locked budget and does not mint earnings.
