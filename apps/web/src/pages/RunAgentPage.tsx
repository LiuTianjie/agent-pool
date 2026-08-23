import type { LiveEvent } from '@agent-pool/shared';
import {
  BadgeCheck,
  AlertTriangle,
  Bot,
  Cpu,
  EyeOff,
  Gauge,
  HardDrive,
  KeyRound,
  LockKeyhole,
  RadioTower,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyCommand } from '../components/CopyCommand';
import { DocumentTitle } from '../components/DocumentTitle';
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { OfficialFleetCard } from '../components/OfficialFleetCard';
import { PageHeader } from '../components/PageHeader';
import { RunnerClaimMarket } from '../components/RunnerClaimMarket';
import { LiveStatus } from '../components/Status';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { useI18n } from '../i18n';
import { api, ApiError, normalizeList } from '../lib/api';
import { credits, duration, percent, relativeTime } from '../lib/format';
import { isOfficialRunner } from '../lib/officialFleet';
import { mergeMarketPools } from '../lib/runnerMarket';
import type {
  OfficialFleetMode,
  OfficialFleetView,
  RunnerMarketPool,
  RunnerNodePublic,
} from '../lib/types';

const INSTALL_COMMAND = 'curl -fsSL https://agentpool.itool.tech/install.sh | sh';
const LOGIN_COMMAND = 'agentpool login';
const BENCHMARK_COMMAND = 'agentpool benchmark --agent codex --model <exact-model> --concurrency 4';
const CLAIM_COMMAND =
  'agentpool claim --pool <pool-id> --units 3 --agent codex --model <exact-model>';
const WEBHOOK_CLAIM_COMMAND = `${CLAIM_COMMAND} --allow-webhooks`;

function RunnerSetup() {
  const { t } = useI18n();
  return (
    <>
      <section className="runner-intro">
        <div className="runner-orbit" aria-hidden="true">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <div>
            <Bot />
          </div>
          <i className="orbit-node node-one" />
          <i className="orbit-node node-two" />
          <i className="orbit-node node-three" />
        </div>
        <div>
          <h2>{t('run.keysStayTitle')}</h2>
          <p>{t('run.keysStayBody')}</p>
          <CopyCommand command={INSTALL_COMMAND} />
        </div>
      </section>

      <section className="runner-steps page-section">
        <div className="section-bar">
          <div>
            <h2>{t('run.installThenClaim')}</h2>
          </div>
        </div>
        <div className="runner-step-list">
          <article>
            <span className="runner-step-number">01</span>
            <div className="runner-step-icon">
              <TerminalSquare aria-hidden="true" />
            </div>
            <div>
              <h3>{t('run.step1Title')}</h3>
              <p>{t('run.step1Body')}</p>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
          </article>
          <article>
            <span className="runner-step-number">02</span>
            <div className="runner-step-icon">
              <KeyRound aria-hidden="true" />
            </div>
            <div>
              <h3>{t('run.step2Title')}</h3>
              <p>{t('run.step2Body')}</p>
              <CopyCommand command={LOGIN_COMMAND} />
            </div>
          </article>
          <article>
            <span className="runner-step-number">03</span>
            <div className="runner-step-icon">
              <BadgeCheck aria-hidden="true" />
            </div>
            <div>
              <h3>{t('run.step3Title')}</h3>
              <p>{t('run.step3Body')}</p>
              <CopyCommand command={BENCHMARK_COMMAND} />
              <small>
                {t('run.step3HintBefore')} <code>&lt;exact-model&gt;</code> {t('run.step3HintMid')}{' '}
                <code>--agent</code> {t('run.step3HintAfter')} <code>claude</code>.
              </small>
            </div>
          </article>
          <article>
            <span className="runner-step-number">04</span>
            <div className="runner-step-icon">
              <RadioTower aria-hidden="true" />
            </div>
            <div>
              <h3>{t('run.step4Title')}</h3>
              <p>{t('run.step4Body')}</p>
              <CopyCommand command={CLAIM_COMMAND} />
              <div className="runner-webhook-optin">
                <header>
                  <Webhook aria-hidden="true" />
                  <div>
                    <strong>{t('run.webhookTitle')}</strong>
                  </div>
                </header>
                <p>
                  {t('run.webhookBodyBefore')} <code>--allow-webhooks</code>
                  {t('run.webhookBodyAfter')}
                </p>
                <CopyCommand command={WEBHOOK_CLAIM_COMMAND} />
                <span>
                  <AlertTriangle aria-hidden="true" /> {t('run.webhookWarn')}
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="sealed-boundary">
        <div>
          <LockKeyhole aria-hidden="true" />
          <strong>{t('run.pageBlind')}</strong>
        </div>
        <p>{t('run.pageBlindBody')}</p>
        <div className="boundary-flow" aria-label={t('run.visibleAria')}>
          <span>
            <EyeOff aria-hidden="true" /> {t('run.thisPage')}
          </span>
          <i />
          <strong>{t('run.progressCredits')}</strong>
          <i className="blocked" />
          <span>
            <ShieldCheck aria-hidden="true" /> {t('run.promptsAnswers')}
          </span>
        </div>
      </section>
    </>
  );
}

export function RunAgentPage() {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<RunnerNodePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officialFleet, setOfficialFleet] = useState<OfficialFleetView | null>(null);
  const [marketPools, setMarketPools] = useState<RunnerMarketPool[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [officialFleetError, setOfficialFleetError] = useState<string | null>(null);
  const [changingFleetMode, setChangingFleetMode] = useState<OfficialFleetMode | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setNodes(normalizeList(await api.runners()));
        setError(null);
      } catch (requestError) {
        setError(requestError instanceof ApiError ? requestError.message : t('run.loadError'));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [t],
  );

  const loadMarket = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoadingMarket(true);
      try {
        const [publicPools, ownedPools] = await Promise.all([
          api.runnerMarketPools(),
          api.listPools(),
        ]);
        setMarketPools(mergeMarketPools(publicPools, ownedPools));
        setMarketError(null);
      } catch (requestError) {
        setMarketError(
          requestError instanceof ApiError ? requestError.message : t('run.marketError'),
        );
      } finally {
        if (!quiet) setLoadingMarket(false);
      }
    },
    [t],
  );

  const loadOfficialFleet = useCallback(async () => {
    try {
      setOfficialFleet(await api.officialFleet());
      setOfficialFleetError(null);
    } catch (requestError) {
      if (requestError instanceof ApiError && [403, 404].includes(requestError.status)) {
        setOfficialFleet(null);
        setOfficialFleetError(null);
        return;
      }
      setOfficialFleetError(
        requestError instanceof ApiError ? requestError.message : t('run.fleetError'),
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
    void loadMarket();
    void loadOfficialFleet();
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load, loadMarket, loadOfficialFleet]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (
        event.type !== 'runner.updated' &&
        event.type !== 'unit.updated' &&
        event.type !== 'pool.updated'
      )
        return;
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void load(true);
        void loadMarket(true);
        if (officialFleet) void loadOfficialFleet();
      }, 200);
    },
    [load, loadMarket, loadOfficialFleet, officialFleet],
  );
  const { state } = useLiveEvents(onEvent);

  const changeOfficialFleetMode = async (mode: OfficialFleetMode) => {
    if (!officialFleet || mode === officialFleet.mode || changingFleetMode) return;
    setChangingFleetMode(mode);
    setOfficialFleetError(null);
    try {
      setOfficialFleet(await api.updateOfficialFleet(mode));
    } catch (requestError) {
      setOfficialFleetError(
        requestError instanceof ApiError ? requestError.message : t('run.fleetSwitchError'),
      );
    } finally {
      setChangingFleetMode(null);
    }
  };

  if (loading && !nodes.length) return <LoadingState label={t('common.loading')} />;

  const paired = nodes.length > 0;

  return (
    <div className="page run-agent-page">
      <DocumentTitle title={t('run.title')} />
      <PageHeader
        eyebrow={t('run.eyebrow')}
        title={t('run.heading')}
        description={t('run.description')}
        actions={<LiveStatus state={state} />}
      />
      {error ? <InlineError message={error} retry={() => void load()} /> : null}
      <RunnerClaimMarket
        nodes={nodes}
        pools={marketPools}
        loading={loadingMarket}
        error={marketError}
        onReload={() => void loadMarket()}
      />
      {officialFleet ? (
        <OfficialFleetCard
          fleet={officialFleet}
          nodes={nodes.filter(isOfficialRunner)}
          changingMode={changingFleetMode}
          error={officialFleetError}
          onModeChange={(mode) => void changeOfficialFleetMode(mode)}
        />
      ) : officialFleetError ? (
        <InlineError message={officialFleetError} retry={() => void loadOfficialFleet()} />
      ) : null}

      {paired ? (
        <details className="runner-setup-details">
          <summary>{t('run.setupSummary')}</summary>
          <RunnerSetup />
        </details>
      ) : (
        <div className="runner-setup-unpaired">
          <RunnerSetup />
        </div>
      )}

      <section className="page-section">
        <div className="section-bar">
          <div>
            <h2>{t('run.connectedNodes')}</h2>
          </div>
          <span>
            {t('run.onlineTotal', {
              online: nodes.filter((node) => node.status === 'online').length,
              total: nodes.length,
            })}
          </span>
        </div>
        {nodes.length ? (
          <div className="node-list">
            {nodes.map((node) => (
              <RunnerNodeCard key={node.id} node={node} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={t('run.noRunnerTitle')}
            detail={t('run.noRunnerDetail')}
            action={<CopyCommand command={INSTALL_COMMAND} />}
          />
        )}
      </section>
    </div>
  );
}

function RunnerNodeCard({ node }: { node: RunnerNodePublic }) {
  const { t } = useI18n();
  const activeCount = Math.max(node.activeLeases, node.activeJobs.length);
  const validCertifications = node.certifications.filter(
    (certification) => Date.parse(certification.expiresAt) > Date.now(),
  );
  const statusLabel =
    node.status === 'online'
      ? t('common.online')
      : node.status === 'paused'
        ? t('common.paused')
        : t('common.offline');

  return (
    <article className="node-card">
      <header>
        <div className="node-machine">
          <span className={`node-indicator node-${node.status}`} aria-hidden="true" />
          <HardDrive aria-hidden="true" />
          <div>
            <strong>{node.name}</strong>
            <small>{node.id.slice(0, 12)}</small>
          </div>
        </div>
        <div className="node-status-stack">
          {isOfficialRunner(node) ? (
            <span className="official-node-badge">
              <ServerCog aria-hidden="true" /> {t('common.official')}
            </span>
          ) : null}
          <span className={`node-status node-status-${node.status}`}>{statusLabel}</span>
        </div>
      </header>
      <div className="node-target">
        <div>
          <Cpu aria-hidden="true" />
          <span>
            <small>{t('run.platform')}</small>
            <strong>{node.platform || t('common.platformUnknown')}</strong>
          </span>
        </div>
        <div>
          <Gauge aria-hidden="true" />
          <span>
            <small>{t('run.occupancy')}</small>
            <strong>
              {node.activeLeases} / {node.maxConcurrency}
            </strong>
          </span>
        </div>
        <div>
          <RadioTower aria-hidden="true" />
          <span>
            <small>{t('run.activeUnits')}</small>
            <strong>{t('run.unitCount', { count: activeCount })}</strong>
          </span>
        </div>
      </div>

      <div className="cert-card cert-card-instruction">
        <header>
          <BadgeCheck aria-hidden="true" />
          <div>
            <strong>{t('run.certsTitle')}</strong>
            <small>{t('run.certsMeta', { count: validCertifications.length })}</small>
          </div>
        </header>
        {validCertifications.length ? (
          <div className="runner-certification-list">
            {validCertifications.map((certification) => (
              <article
                key={`${certification.adapter}-${certification.model}-${certification.expiresAt}`}
              >
                <strong>
                  {certification.adapter} / {certification.model}
                </strong>
                <span>{t('run.p95', { value: duration(certification.p95Ms / 1000) })}</span>
                <span>
                  {t('run.concurrencyEvidence', { count: certification.certifiedConcurrency })}
                </span>
                <span>{t('run.successRate', { value: percent(certification.successRate) })}</span>
                <small>{t('run.expires', { time: relativeTime(certification.expiresAt) })}</small>
              </article>
            ))}
          </div>
        ) : (
          <p>{t('run.noCerts')}</p>
        )}
        <CopyCommand command={BENCHMARK_COMMAND} />
      </div>

      <div className="node-jobs">
        <div className="node-jobs-head">
          <strong>{t('run.doingNow')}</strong>
          <span>{t('run.progressOnly')}</span>
        </div>
        <div className="node-aggregate">
          <span
            className={activeCount ? 'job-pulse' : 'job-pulse job-pulse-idle'}
            aria-hidden="true"
          />
          <div>
            <strong>
              {activeCount ? t('run.jobsRunning', { count: activeCount }) : t('run.jobsIdle')}
            </strong>
            <small>{activeCount ? t('run.inProgress') : t('run.idleNow')}</small>
          </div>
        </div>
        {node.activeJobs.length ? (
          <ol className="aggregate-job-list" aria-label={t('run.jobsAria')}>
            {node.activeJobs.map((job, index) => (
              <li key={`${job.stage}-${index}`}>
                <span>{t('run.jobN', { n: String(index + 1).padStart(2, '0') })}</span>
                <strong>{job.stage}</strong>
                <span>{percent(job.progress)}</span>
                <span>{credits(job.reward)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <footer>
        <span>{t('run.runnerVersion', { version: node.runnerVersion || '—' })}</span>
        <span>{t('run.lastSignal', { time: relativeTime(node.lastSeenAt) })}</span>
      </footer>
    </article>
  );
}
