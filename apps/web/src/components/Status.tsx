import type { PoolSummary } from '@agent-pool/shared';
import { useI18n } from '../i18n';
import type { StreamState } from '../hooks/useLiveEvents';

export type PoolLifecycleStatus = PoolSummary['status'] | 'piloting';

export function PoolStatus({ status }: { status: PoolLifecycleStatus }) {
  const { t } = useI18n();
  const labels: Record<PoolLifecycleStatus, string> = {
    draft: t('status.draft'),
    waiting_capacity: t('status.waitingCapacity'),
    queued: t('status.queued'),
    piloting: t('status.piloting'),
    running: t('status.running'),
    paused: t('status.paused'),
    completed: t('status.completed'),
    cancelled: t('status.cancelled'),
  };

  return <span className={`status status-${status}`}>{labels[status]}</span>;
}

export function LiveStatus({ state }: { state: StreamState }) {
  const { t } = useI18n();
  const label: Record<StreamState, string> = {
    connecting: t('status.connecting'),
    live: t('status.live'),
    retrying: t('status.retrying'),
    stopped: t('status.stopped'),
  };

  return (
    <span className={`live-status live-${state}`} aria-live="polite">
      <span aria-hidden="true" />
      {label[state]}
    </span>
  );
}
