import type { LiveEvent } from '@agent-pool/shared';
import { ArrowRight, Blocks, Plus, RadioTower, Server, Sparkles } from 'lucide-react';
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

  if (loading && !data) return <LoadingState label="正在汇集网络状态" />;
  if (error && !data) return <InlineError message={error} retry={() => void load()} />;
  if (!data) return null;

  const activePools = data.pools.filter((pool) =>
    ['piloting', 'waiting_capacity', 'queued', 'running', 'paused'].includes(pool.status),
  );

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="CONTROL ROOM / LIVE"
        title={`${user?.displayName || '你好'}，网络正在流动。`}
        description="发布任务池，或观察 Agent 正在把小单元逐个变成交付。"
        actions={<LiveStatus state={state} />}
      />

      <WalletGrid wallet={data.wallet} />

      <section className="dashboard-band">
        <div className="network-pulse-card">
          <div className="pulse-orbit" aria-hidden="true">
            <span />
            <span />
            <RadioTower />
          </div>
          <div>
            <span className="mono-label">NETWORK PULSE</span>
            <strong>{data.network.onlineNodes.toLocaleString('zh-CN')}</strong>
            <p>
              个 Runner 节点在线，其中 {data.network.busyNodes.toLocaleString('zh-CN')} 个正在执行。
            </p>
          </div>
          <dl>
            <div>
              <dt>活跃任务池</dt>
              <dd>{data.network.activePools.toLocaleString('zh-CN')}</dd>
            </div>
            <div>
              <dt>等待 Units</dt>
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
              <strong>发布任务池</strong>
              <small>把数据切成独立 Units</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link to="/app/run">
            <span className="quick-icon quick-icon-warm">
              <RadioTower aria-hidden="true" />
            </span>
            <div>
              <strong>打开 Runner 市场</strong>
              <small>选择一批，主人主动 Claim</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="page-section">
        <div className="section-bar">
          <div>
            <span className="section-index">ACTIVE POOLS</span>
            <h2>正在发布的任务池</h2>
          </div>
          <Link className="text-link" to="/app/pools/new">
            新建 <ArrowRight aria-hidden="true" />
          </Link>
        </div>
        {activePools.length ? (
          <div className="pool-list">
            {activePools.map((pool) => (
              <PoolCard key={pool.id} pool={pool} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="池子现在很安静"
            detail="发布一组可拆分的小任务，网络会按指定 Agent、模型和容量精准匹配。"
            action={
              <Link className="button button-primary" to="/app/pools/new">
                <Blocks aria-hidden="true" /> 创建任务池
              </Link>
            }
          />
        )}
      </section>

      <aside className="privacy-strip">
        <Sparkles aria-hidden="true" />
        <strong>执行端默认只看见：</strong>
        <span>公开摘要</span>
        <span>Agent / 模型要求</span>
        <span>进度</span>
        <span>PULSE 奖励</span>
        <span className="privacy-not">
          <Server aria-hidden="true" /> 不显示任务内容与交付结果
        </span>
      </aside>
    </div>
  );
}
