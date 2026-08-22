import type { RunnerMarketPool, RunnerNodePublic } from './types';

const ACTIVE_MARKET_STATES = new Set<RunnerMarketPool['status']>([
  'piloting',
  'waiting_capacity',
  'queued',
  'running',
]);

export function runnerMatchesPool(
  node: RunnerNodePublic,
  pool: RunnerMarketPool,
  now = Date.now(),
): boolean {
  if (!ACTIVE_MARKET_STATES.has(pool.status) || pool.queuedUnits < 1) return false;
  if (Date.parse(pool.deadlineAt) <= now) return false;
  if (pool.deliveryMode === 'webhook' && !node.supportsDirectWebhooks) return false;
  return node.certifications.some(
    (certification) =>
      certification.adapter === pool.requestedAgent &&
      certification.model === pool.requestedModel &&
      certification.certifiedConcurrency > 0 &&
      certification.p95Ms <= pool.maxUnitSeconds * 1_000 &&
      Date.parse(certification.expiresAt) > now,
  );
}

export function matchingMarketPools(
  node: RunnerNodePublic | undefined,
  pools: RunnerMarketPool[],
  now = Date.now(),
): RunnerMarketPool[] {
  if (!node) return [];
  return pools.filter((pool) => runnerMatchesPool(node, pool, now));
}

export function mergeMarketPools(
  publicPools: RunnerMarketPool[],
  ownedPools: RunnerMarketPool[],
): RunnerMarketPool[] {
  const ownedIds = new Set(ownedPools.map((pool) => pool.id));
  const seen = new Set<string>();
  const merged: RunnerMarketPool[] = [];
  for (const pool of ownedPools) {
    if (!ACTIVE_MARKET_STATES.has(pool.status) || pool.queuedUnits < 1) continue;
    seen.add(pool.id);
    merged.push({ ...pool, owned: true });
  }
  for (const pool of publicPools) {
    if (seen.has(pool.id)) continue;
    merged.push({ ...pool, owned: ownedIds.has(pool.id) });
  }
  return merged;
}

export function clampClaimUnits(value: number, availableUnits: number): number {
  return Math.max(1, Math.min(Math.floor(value), availableUnits, 20_000));
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9._:/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function runnerPickCommand(
  node: Pick<RunnerNodePublic, 'operatorType'>,
  pool: Pick<RunnerMarketPool, 'requestedAgent' | 'requestedModel' | 'deliveryMode'>,
): string {
  if (node.operatorType === 'official') return 'agentpool-official pick';
  const webhookFlag = pool.deliveryMode === 'webhook' ? ' --allow-webhooks' : '';
  return `agentpool pick --agent ${pool.requestedAgent} --model ${shellQuote(pool.requestedModel)}${webhookFlag}`;
}

export function runnerClaimCommand(
  node: Pick<RunnerNodePublic, 'operatorType'>,
  pool: Pick<
    RunnerMarketPool,
    'id' | 'queuedUnits' | 'requestedAgent' | 'requestedModel' | 'deliveryMode'
  >,
  units: number,
): string {
  const safeUnits = clampClaimUnits(units, pool.queuedUnits);
  if (node.operatorType === 'official') {
    return `agentpool-official claim --pool ${pool.id} --units ${safeUnits}`;
  }

  const webhookFlag = pool.deliveryMode === 'webhook' ? ' --allow-webhooks' : '';
  return `agentpool claim --pool ${pool.id} --units ${safeUnits} --agent ${pool.requestedAgent} --model ${shellQuote(pool.requestedModel)}${webhookFlag}`;
}

export function runnerResumeCommand(
  node: Pick<RunnerNodePublic, 'operatorType'>,
  claimId: string,
  deliveryMode: RunnerMarketPool['deliveryMode'] = 'platform',
): string {
  if (node.operatorType === 'official') return `agentpool-official claim --claim ${claimId}`;
  const webhookFlag = deliveryMode === 'webhook' ? ' --allow-webhooks' : '';
  return `agentpool claim --claim ${claimId}${webhookFlag}`;
}
