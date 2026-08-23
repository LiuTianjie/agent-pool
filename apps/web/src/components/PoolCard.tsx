import type { PoolSummary } from '@agent-pool/shared';
import { ArrowUpRight, Boxes, Clock3, Cpu, Gauge } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { credits, dateTime, formatInteger } from '../lib/format';
import { PoolStatus, type PoolLifecycleStatus } from './Status';

function completion(pool: PoolSummary): number {
  if (!pool.totalUnits) return 0;
  return Math.min(100, Math.round((pool.acceptedUnits / pool.totalUnits) * 100));
}

export function PoolCard({ pool }: { pool: PoolSummary }) {
  const { t } = useI18n();
  const progress = completion(pool);
  const runtimeStatus = pool.status as PoolLifecycleStatus;

  return (
    <Link className="pool-card" to={`/app/pools/${pool.id}`}>
      <div className="pool-card-head">
        <div>
          <h3>{pool.title}</h3>
        </div>
        <PoolStatus status={runtimeStatus} />
      </div>
      <p>{pool.publicSummary}</p>
      <div className="runtime-target">
        <span>
          <Cpu aria-hidden="true" /> {pool.requestedAgent}
        </span>
        <strong>{pool.requestedModel}</strong>
        <span>
          <Gauge aria-hidden="true" /> {t('card.concurrency', { count: pool.requiredConcurrency })}
        </span>
      </div>
      <div className="pool-progress" aria-label={t('card.progress', { percent: progress })}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="pool-counts">
        <div>
          <strong>{formatInteger(pool.acceptedUnits)}</strong>
          <span>{t('card.accepted')}</span>
        </div>
        <div>
          <strong>{formatInteger(pool.runningUnits)}</strong>
          <span>{t('card.running')}</span>
        </div>
        <div>
          <strong>{formatInteger(pool.queuedUnits)}</strong>
          <span>{t('card.queued')}</span>
        </div>
        <div>
          <strong>{formatInteger(pool.failedUnits)}</strong>
          <span>{t('card.failed')}</span>
        </div>
      </div>
      <footer>
        <span>
          <Boxes aria-hidden="true" />{' '}
          {t('card.unitCount', { count: formatInteger(pool.totalUnits) })}
        </span>
        <span>
          <Clock3 aria-hidden="true" /> {t('card.deadline', { time: dateTime(pool.deadlineAt) })}
        </span>
        <span className="pool-pulse-reward">
          {t('card.perUnit', { amount: credits(pool.rewardPerUnit) })}
        </span>
        <ArrowUpRight aria-hidden="true" />
      </footer>
    </Link>
  );
}
