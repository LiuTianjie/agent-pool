import type { LiveEvent } from '@agent-pool/shared';
import { ArrowRight, Plus, RadioTower, Sparkles } from 'lucide-react';
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
  const recentPools = data.pools
    .filter((pool) => ['completed', 'cancelled'].includes(pool.status))
    .slice(0, 6);

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="控制台"
        title={
          activePools.length
            ? `${user?.displayName || '你好'}，任务正在进行。`
            : `${user?.displayName || '你好'}，可以从这里发出去。`
        }
        description="发布一批托管任务，或用自己的 Agent 先跑通。"
        actions={<LiveStatus state={state} />}
      />

      <WalletGrid wallet={data.wallet} variant={activePools.length ? 'grid' : 'strip'} />

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
              个 Runner 节点在线，其中 {data.network.busyNodes.toLocaleString('zh-CN')} 个正在执行。
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
              <small>指向你托管的工作包</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link to="/app/run">
            <span className="quick-icon">
              <RadioTower aria-hidden="true" />
            </span>
            <div>
              <strong>用 Agent 接活</strong>
              <small>生成领取单，本机执行</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

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
        ) : recentPools.length ? (
          <p className="dashboard-quiet">现在没有进行中的。最近完成的在下面。</p>
        ) : (
          <EmptyState
            title="现在还没有进行中的任务"
            detail="上面可以直接发布一批，或用自己的 Agent 先跑通。"
          />
        )}
      </section>

      {recentPools.length ? (
        <section className="page-section">
          <div className="section-bar">
            <div>
              <h2>最近完成</h2>
            </div>
            <span>{recentPools.length} 批</span>
          </div>
          <div className="pool-list">
            {recentPools.map((pool) => (
              <PoolCard key={pool.id} pool={pool} />
            ))}
          </div>
        </section>
      ) : null}

      <aside className="privacy-strip">
        <Sparkles aria-hidden="true" />
        <span>进度里看不到题目和答案。托管正文也不进平台库。</span>
      </aside>
    </div>
  );
}
