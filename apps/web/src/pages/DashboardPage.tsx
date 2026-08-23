import type { LiveEvent } from '@agent-pool/shared';
import { ArrowRight, Plus, RadioTower, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { DocumentTitle } from '../components/DocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { PoolCard } from '../components/PoolCard';
import { LiveStatus } from '../components/Status';
import { WalletGrid } from '../components/WalletGrid';
import { useAuth } from '../context/AuthContext';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { useI18n } from '../i18n';
import { api, ApiError } from '../lib/api';
import { formatInteger } from '../lib/format';
import type { DashboardData } from '../lib/types';

export function DashboardPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<number | undefined>(undefined);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setData(await api.dashboard());
        setError(null);
      } catch (requestError) {
        setError(
          requestError instanceof ApiError ? requestError.message : t('dashboard.loadError'),
        );
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [t],
  );

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

  if (loading && !data) return <LoadingState label={t('common.loading')} />;
  if (error && !data) return <InlineError message={error} retry={() => void load()} />;
  if (!data) return null;

  const activePools = data.pools.filter((pool) =>
    ['piloting', 'waiting_capacity', 'queued', 'running', 'paused'].includes(pool.status),
  );
  const recentPools = data.pools
    .filter((pool) => ['completed', 'cancelled'].includes(pool.status))
    .slice(0, 6);
  const name = user?.displayName || t('dashboard.hello');

  return (
    <div className="page dashboard-page">
      <DocumentTitle title={t('dashboard.title')} />
      <PageHeader
        eyebrow={t('dashboard.title')}
        title={
          activePools.length
            ? t('dashboard.titleActive', { name })
            : t('dashboard.titleIdle', { name })
        }
        description={t('dashboard.description')}
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
            <strong>{formatInteger(data.network.onlineNodes)}</strong>
            <p>
              {t('dashboard.pulseNodes', {
                busy: formatInteger(data.network.busyNodes),
              })}
            </p>
          </div>
          <dl>
            <div>
              <dt>{t('dashboard.pulseActive')}</dt>
              <dd>{formatInteger(data.network.activePools)}</dd>
            </div>
            <div>
              <dt>{t('dashboard.pulseQueued')}</dt>
              <dd>{formatInteger(data.network.queuedUnits)}</dd>
            </div>
            <div>
              <dt>{t('dashboard.pulseToday')}</dt>
              <dd>{formatInteger(data.network.completedToday)}</dd>
            </div>
          </dl>
        </div>

        <div className="quick-actions">
          <Link to="/app/pools/new">
            <span className="quick-icon">
              <Plus aria-hidden="true" />
            </span>
            <div>
              <strong>{t('dashboard.publishTitle')}</strong>
              <small>{t('dashboard.publishDetail')}</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link to="/app/run">
            <span className="quick-icon">
              <RadioTower aria-hidden="true" />
            </span>
            <div>
              <strong>{t('dashboard.runTitle')}</strong>
              <small>{t('dashboard.runDetail')}</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="page-section">
        <div className="section-bar">
          <div>
            <h2>{t('dashboard.activeTitle')}</h2>
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
          <p className="dashboard-quiet">{t('dashboard.quiet')}</p>
        ) : (
          <EmptyState title={t('dashboard.emptyTitle')} detail={t('dashboard.emptyDetail')} />
        )}
      </section>

      {recentPools.length ? (
        <section className="page-section">
          <div className="section-bar">
            <div>
              <h2>{t('dashboard.recentTitle')}</h2>
            </div>
            <span>{t('dashboard.recentCount', { count: recentPools.length })}</span>
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
        <span>{t('dashboard.privacy')}</span>
      </aside>
    </div>
  );
}
