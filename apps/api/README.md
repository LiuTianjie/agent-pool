# Agent Pool API

Fastify/PostgreSQL control plane for Agent Pool. Task instructions, unit inputs,
expected outputs, benchmark challenges, and submitted results are encrypted at
rest with AES-256-GCM. The key must be supplied in `TASK_ENCRYPTION_KEY` and is
never stored in PostgreSQL.

## Local development

Copy `.env.example`, create a PostgreSQL database, then run from the repository
root:

```bash
pnpm install
pnpm dev:api
```

Migrations run automatically before the server starts. Startup retries migration
failures for up to 10 minutes with capped exponential backoff so a PostgreSQL
recovery can finish without an API restart loop. `ALLOW_DEV_TOPUP=true` enables
the fake-credit endpoint; it must be false in a real-money environment.

## Privacy boundary

Authenticated publisher routes can read their own encrypted inputs and results.
Ordinary runner-owner/dashboard routes expose only progress, status, reward, and
aggregate metrics. Task contents are released only through a short-lived lease
response authenticated with the paired Runner credential and are marked
`Cache-Control: no-store`.

This prevents accidental disclosure in Agent Pool's UI and isolates tasks from
other sessions. It does **not** make task contents cryptographically invisible
to an administrator of a self-hosted machine: that administrator can inspect or
modify the Runner process. Strong host-owner secrecy would require an attested
confidential-computing worker, which this MVP does not claim to provide.

Capacity certifications likewise prove deterministic benchmark correctness and
observed performance for a self-declared adapter/model pair; they are not
cryptographic model-identity attestations.

## Manual claim boundary

Runner registration, heartbeat, and certification never assign work. A Runner
first calls `GET /api/runner/jobs?nodeId=...`, then explicitly creates one
bounded `POST /api/runner/claims` grant for a concrete node, Pool, maximum Unit
count, and expiry. Every lease poll must carry that `claimId`; the database
atomically binds and consumes the grant with the Runner credential, node, and
Pool. Pool cancellation/completion/deadline and credential revocation terminate
unused reservations immediately.

## Official Fleet owner

The configured default owner email is `liu28719976@gmail.com`, but knowing or
registering that address never grants Official privileges. On the API host,
bind the UUID of an existing account whose normalized email matches
`DEFAULT_OFFICIAL_OWNER_EMAIL`:

```bash
pnpm --filter @agent-pool/api official-fleet:bind -- --owner-id <existing-user-uuid>
```

Only that server-side binding allows the dedicated Official Fleet device flow
to issue an `operator_type=official` Runner credential. Official earnings are
settled to the bound node owner; the normal self-rent prohibition still applies.
The database permits exactly one global Official Fleet owner. Re-running the
bind for that same owner is idempotent; binding or implicitly migrating it to a
different owner is deliberately rejected.
