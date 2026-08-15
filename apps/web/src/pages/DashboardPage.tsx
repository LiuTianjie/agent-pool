import type { LiveEvent } from '@agent-pool/shared';
import { ArrowRight, Blocks, Plus, RadioTower, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { PoolCard } from '../components/PoolCard';
import { LiveStatus } from '../components/Status';
import { WalletGrid } from '../components/WalletGrid';
import { useAuth } from '../context/AuthContext';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { api, ApiError } from '../lib/api';
import type { DashboardData } from '../lib/types';

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '无法读取控制台');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  const onLiveEvent = useCallback(
    (_event: LiveEvent) => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(true), 250);
    },
    [load],
  );

  const { state } = useLiveEvents(onLiveEvent);

  if (loading && !data) return <LoadingState label="正在加载" />;
  if (error && !data) return <InlineError message={error} retry={() => void load()} />;
  if (!data) return null;

  const activePools = data.pools.filter((pool) =>
    ['piloting', 'waiting_capacity', 'queued', 'running', 'paused'].includes(pool.status),
  );

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="控制台"
        title={`${user?.displayName || '你好'}，任务正在进行。`}
        description="发布任务，或看正在做的进度。"
        actions={<LiveStatus state={state} />}
      />

      <WalletGrid wallet={data.wallet} variant={activePools.length ? 'grid' : 'strip'} />

      {activePools.length ? (
        <section className="dashboard-band">
          <div className="network-pulse-card">
            <div className="pulse-orbit" aria-hidden="true">
              <span />
              <span />
              <RadioTower />
            </div>
            <div>
              <strong>{data.network.onlineNodes.toLocaleString('zh-CN')}</strong>
              <p>
                个 Runner 节点在线，其中 {data.network.busyNodes.toLocaleString('zh-CN')}{' '}
                个正在执行。
              </p>
            </div>
            <dl>
              <div>
                <dt>进行中的任务</dt>
                <dd>{data.network.activePools.toLocaleString('zh-CN')}</dd>
              </div>
              <div>
                <dt>等待中的任务</dt>
                <dd>{data.network.queuedUnits.toLocaleString('zh-CN')}</dd>
              </div>
              <div>
                <dt>今日完成</dt>
                <dd>{data.network.completedToday.toLocaleString('zh-CN')}</dd>
              </div>
            </dl>
          </div>

          <div className="quick-actions">
            <Link to="/app/pools/new">
              <span className="quick-icon">
                <Plus aria-hidden="true" />
              </span>
              <div>
                <strong>发布一批任务</strong>
                <small>写说明，放上数据</small>
              </div>
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>
        </section>
      ) : null}

      <section className="page-section">
        <div className="section-bar">
          <div>
            <h2>进行中的任务</h2>
          </div>
          <span />
        </div>
        {activePools.length ? (
          <div className="pool-list">
            {activePools.map((pool) => (
              <PoolCard key={pool.id} pool={pool} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="现在还没有进行中的任务"
            detail="发布一组能拆开做的小任务。"
            action={
              <Link className="button button-primary" to="/app/pools/new">
                <Blocks aria-hidden="true" /> 发布一批任务
              </Link>
            }
          />
        )}
      </section>

      {activePools.length ? (
        <aside className="privacy-strip">
          <Sparkles aria-hidden="true" />
          <span>进度里看不到题目和答案。</span>
        </aside>
      ) : null}
    </div>
  );
}
