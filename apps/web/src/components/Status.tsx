import type { PoolSummary } from '@agent-pool/shared';
import type { StreamState } from '../hooks/useLiveEvents';

export type PoolLifecycleStatus = PoolSummary['status'] | 'piloting';

const POOL_LABELS: Record<PoolLifecycleStatus, string> = {
  draft: '草稿',
  waiting_capacity: '开放领取',
  queued: '开放领取',
  piloting: '试跑开放领取',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
};

export function PoolStatus({ status }: { status: PoolLifecycleStatus }) {
  return <span className={`status status-${status}`}>{POOL_LABELS[status]}</span>;
}

export function LiveStatus({ state }: { state: StreamState }) {
  const label: Record<StreamState, string> = {
    connecting: '建立实时连接',
    live: '实时',
    retrying: '正在重连',
    stopped: '已停止',
  };

  return (
    <span className={`live-status live-${state}`} aria-live="polite">
      <span aria-hidden="true" />
      {label[state]}
    </span>
  );
}
