import type { PoolSummary } from '@agent-pool/shared';
import { ArrowUpRight, Boxes, Clock3, Cpu, Gauge } from 'lucide-react';
import { Link } from 'react-router-dom';
import { credits, dateTime } from '../lib/format';
import { PoolStatus, type PoolLifecycleStatus } from './Status';

function completion(pool: PoolSummary): number {
  if (!pool.totalUnits) return 0;
  return Math.min(100, Math.round((pool.acceptedUnits / pool.totalUnits) * 100));
}

export function PoolCard({ pool }: { pool: PoolSummary }) {
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
          <Gauge aria-hidden="true" /> 同时执行上限 {pool.requiredConcurrency}
        </span>
      </div>
      <div className="pool-progress" aria-label={`完成 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="pool-counts">
        <div>
          <strong>{pool.acceptedUnits.toLocaleString('zh-CN')}</strong>
          <span>已验收</span>
        </div>
        <div>
          <strong>{pool.runningUnits.toLocaleString('zh-CN')}</strong>
          <span>执行中</span>
        </div>
        <div>
          <strong>{pool.queuedUnits.toLocaleString('zh-CN')}</strong>
          <span>排队</span>
        </div>
        <div>
          <strong>{pool.failedUnits.toLocaleString('zh-CN')}</strong>
          <span>失败</span>
        </div>
      </div>
      <footer>
        <span>
          <Boxes aria-hidden="true" /> {pool.totalUnits.toLocaleString('zh-CN')} 条任务
        </span>
        <span>
          <Clock3 aria-hidden="true" /> 截止 {dateTime(pool.deadlineAt)}
        </span>
        <span className="pool-pulse-reward">
          {credits(pool.rewardPerUnit)} / 条
        </span>
        <ArrowUpRight aria-hidden="true" />
      </footer>
    </Link>
  );
}
