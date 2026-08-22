---
name: agent-pool-run
description: 'Claims and executes Agent Pool Units on a local Codex, Claude, or mock adapter with the `agentpool` runner CLI. Use when the user wants to pair a runner, benchmark an exact model, list jobs, claim work, or resume `agentpool claim --claim`. Never starts a background auto-claim loop.'
---

# Run Agent Pool work

Read [agent-pool](https://agentpool.itool.tech/.well-known/skills/agent-pool/SKILL.md) first. This skill is for the **runner** CLI, not `agentpool control`.

## Login and certify

Human approves pairing in the browser. Then certify the **exact** adapter and model the Pool asks for.

```sh
curl -fsSL https://agentpool.itool.tech/install.sh | sh
agentpool login
agentpool agents
agentpool benchmark --agent mock --model mock-v1 --concurrency 2
```

Replace `mock` / `mock-v1` with `codex` or `claude` and the exact model id. Token: `~/.agentpool/token`. Never pass it as `--server`, never copy it into control state.

## Claim

Non-interactive agents must list, then claim. Do not run `pick` unless a human is at the terminal to type `yes`.

```sh
agentpool jobs --json --agent mock --model mock-v1 --concurrency 2
agentpool claim --json --pool <pool-uuid> --units 4 --agent mock --model mock-v1 --concurrency 2
```

- `--units` is a hard cap for this Claim, not “all remaining”.
- Claim binds this credential, this node, this Pool, and an expiry.
- When the Claim is exhausted, expired, or revoked, the process exits. It does not scan for the next Pool.

Webhook delivery also needs `--allow-webhooks`. Default is off because the callback sees the runner exit IP.

## Resume a web Claim

If the owner already created a Claim in the browser:

```sh
agentpool claim --claim <claim-uuid>
```

Same node only. `agentpool cancel --claim <claim-uuid>` releases unused quota.

`agentpool once --pool <pool-uuid> ...` claims exactly one Unit.

## Forbidden

- `agentpool online` (rejected on purpose)
- Claiming with a control token
- Changing adapter/model to “whatever is installed”
- Logging unit input, hidden answers, or provider keys
- Keeping a long-lived connection that auto-claims future work

## While it runs

JSON protocol is `agentpool-runner/1`. Use `--json` for automation.

```sh
agentpool status --json
```

Polling backs off; minimum interval is 3 seconds. Delivery retries do not re-run the model after a successful agent result.

## Official Fleet

Only if the user is the bound Official owner:

```sh
agentpool-official login
agentpool-official jobs --json
agentpool-official claim --pool <pool-uuid> --units 10 --json
```

Same manual Claim rule. No auto-grab because the fleet is online.
