import type { LiveEvent } from '@agent-pool/shared';
import {
  ArrowLeft,
  Ban,
  Boxes,
  Check,
  RadioTower,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  Flame,
  Gauge,
  LockKeyhole,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Webhook,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DocumentTitle } from '../components/DocumentTitle';
import { InlineError, LoadingState } from '../components/LoadingState';
import { LiveStatus, PoolStatus } from '../components/Status';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { useI18n, type MessageKey } from '../i18n';
import { api, ApiError } from '../lib/api';
import {
  credits,
  duration,
  formatInteger,
  fullDateTime,
  percent,
  relativeTime,
} from '../lib/format';
import type { PoolDetail, PoolUnit, UnitStatus } from '../lib/types';
import { webhookHostname } from '../lib/taskContract';

function resultJson(value: unknown, empty: string): string {
  if (value === undefined) return empty;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function PoolDetailPage() {
  const { t } = useI18n();
  const { poolId = '' } = useParams();
  const [pool, setPool] = useState<PoolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'results'>('overview');
  const [statusFilter, setStatusFilter] = useState<'all' | 'submitted' | 'accepted' | 'failed'>(
    'all',
  );
  const [resultOffset, setResultOffset] = useState(0);
  const [resultLoading, setResultLoading] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [launching, setLaunching] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const unitStatus: Record<UnitStatus, string> = {
    queued: t('pool.queued'),
    leased: t('pool.leased'),
    running: t('pool.running'),
    submitted: t('pool.submitted'),
    accepted: t('pool.accepted'),
    rejected: t('pool.rejected'),
    failed: t('pool.failed'),
    cancelled: t('pool.cancelled'),
  };

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setPool(await api.getPool(poolId));
        setError(null);
      } catch (requestError) {
        setError(requestError instanceof ApiError ? requestError.message : t('pool.loadError'));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [poolId, t],
  );

  useEffect(() => {
    void load();
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      const eventPoolId = typeof event.data.poolId === 'string' ? event.data.poolId : undefined;
      if (eventPoolId && eventPoolId !== poolId) return;
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(true), 180);
    },
    [load, poolId],
  );

  const { state } = useLiveEvents(onEvent);

  const filteredUnits = useMemo(() => pool?.units || [], [pool]);

  const loadResultPage = async (
    offset: number,
    filter: 'all' | 'submitted' | 'accepted' | 'failed' = statusFilter,
  ) => {
    setResultLoading(true);
    setError(null);
    try {
      const result = await api.poolResults(poolId, {
        status: filter === 'all' ? undefined : filter,
        offset,
        limit: 100,
      });
      setPool((current) =>
        current ? { ...current, units: result.units, resultTotal: result.total } : current,
      );
      setResultOffset(offset);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('pool.resultsError'));
    } finally {
      setResultLoading(false);
    }
  };

  const review = async (unit: PoolUnit, decision: 'accept' | 'retry' | 'reject') => {
    setReviewing(unit.id);
    setError(null);
    try {
      setPool(
        await api.reviewUnit(
          poolId,
          unit.id,
          decision,
          decision === 'accept'
            ? undefined
            : decision === 'retry'
              ? t('pool.retryNote')
              : t('pool.rejectNote'),
        ),
      );
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('pool.reviewError'));
    } finally {
      setReviewing(null);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      setPool(await api.cancelPool(poolId));
      setCancelOpen(false);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('pool.cancelError'));
    } finally {
      setCancelling(false);
    }
  };

  const launchHeldUnits = async () => {
    setLaunching(true);
    setError(null);
    try {
      setPool(await api.launchPool(poolId));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('pool.launchError'));
    } finally {
      setLaunching(false);
    }
  };

  if (loading && !pool) return <LoadingState label={t('pool.loading')} />;
  if (error && !pool) return <InlineError message={error} retry={() => void load()} />;
  if (!pool) return null;

  const canCancel = ['piloting', 'waiting_capacity', 'queued', 'running', 'paused'].includes(
    pool.status,
  );
  const deadlinePassed = new Date(pool.deadlineAt).getTime() < Date.now();
  const canRetry = ['piloting', 'queued', 'running'].includes(pool.status) && !deadlinePassed;
  const deadlineRisk = pool.deadlineRisk || deadlinePassed;
  const activeConcurrency = pool.activeConcurrency ?? pool.runningUnits;
  const capsule = pool.taskCapsule || pool.capsule;
  const webhookDelivery = pool.deliveryTarget?.mode === 'webhook';
  const webhookUrl =
    webhookDelivery && pool.deliveryTarget && 'url' in pool.deliveryTarget
      ? pool.deliveryTarget.url || ''
      : '';
  const pilotUnitCount = pool.pilotUnits ?? 0;
  const heldUnitCount = pool.heldUnits ?? 0;
  const visiblePilotUnits = pool.units.filter((unit) => unit.isPilot);
  const pilotAcceptedUnits =
    pool.pilotAcceptedUnits ??
    visiblePilotUnits.filter((unit) => unit.status === 'accepted').length;
  const pilotFailedUnits =
    pool.pilotFailedUnits ??
    visiblePilotUnits.filter((unit) => ['failed', 'rejected'].includes(unit.status)).length;
  const canLaunchHeld =
    pool.status === 'piloting' &&
    heldUnitCount > 0 &&
    pilotUnitCount > 0 &&
    pilotAcceptedUnits === pilotUnitCount;

  const acceptanceLabel = (): string => {
    if (capsule) {
      const keys: Record<string, MessageKey> = {
        non_empty: 'pool.acceptNonEmpty',
        hidden_exact: 'pool.acceptHidden',
        manual: 'pool.acceptManual',
        schema: 'pool.acceptSchema',
        schema_and_hidden_exact: 'pool.acceptBoth',
        webhook: 'pool.acceptWebhook',
      };
      return t(keys[capsule.acceptance.mode] || 'pool.acceptNonEmpty');
    }
    if (pool.validationMode === 'auto') {
      return pool.outputSchema ? t('pool.acceptSchema') : t('pool.acceptNonEmpty');
    }
    return t('pool.acceptManual');
  };

  return (
    <div className="page pool-detail-page">
      <DocumentTitle title={pool.title} />
      <Link className="back-link" to="/app">
        <ArrowLeft aria-hidden="true" /> {t('pool.back')}
      </Link>
      <header className="pool-detail-header">
        <div>
          <div className="title-line">
            <h1>{pool.title}</h1>
            <PoolStatus status={pool.status} />
          </div>
          <p>{pool.publicSummary}</p>
        </div>
        <div className="page-actions">
          <LiveStatus state={state} />
          {canCancel ? (
            <Link className="button button-primary button-small" to="/app/run">
              <RadioTower aria-hidden="true" /> {t('pool.claim')}
            </Link>
          ) : null}
          <button
            className="button button-outline button-small"
            type="button"
            onClick={() => void load(true)}
          >
            <RefreshCw aria-hidden="true" /> {t('pool.refresh')}
          </button>
          {canCancel ? (
            <button
              className="button button-danger-quiet button-small"
              type="button"
              onClick={() => setCancelOpen(true)}
            >
              <Ban aria-hidden="true" /> {t('pool.cancelBatch')}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <InlineError message={error} /> : null}

      <section className="pool-hero-meter">
        <div className="meter-main">
          <div className="meter-number">
            <strong>{formatInteger(pool.acceptedUnits)}</strong>
            <span>/ {formatInteger(pool.totalUnits)}</span>
          </div>
          <small>{t('pool.passed')}</small>
        </div>
        <div className="concurrency-display">
          <div>
            <strong>{activeConcurrency}</strong>
            <span>/ {pool.requiredConcurrency}</span>
          </div>
          <small>{t('pool.concurrencyCap')}</small>
        </div>
        <div className={deadlineRisk ? 'deadline-display deadline-risk' : 'deadline-display'}>
          <Clock3 aria-hidden="true" />
          <strong>{fullDateTime(pool.deadlineAt)}</strong>
        </div>
      </section>

      {canLaunchHeld ? (
        <section className="pilot-gate pilot-gate-ready">
          <div className="pilot-gate-signal" aria-hidden="true">
            <Flame />
          </div>
          <div className="pilot-gate-copy">
            <h2>{t('pool.pilotReady')}</h2>
            <p>
              {t('pool.pilotStats', {
                accepted: pilotAcceptedUnits,
                total: pilotUnitCount,
                failed: pilotFailedUnits,
                held: formatInteger(heldUnitCount),
              })}
            </p>
          </div>
          <div
            className="pilot-gate-meter"
            aria-label={t('pool.pilotAria', {
              accepted: pilotAcceptedUnits,
              total: pilotUnitCount,
            })}
          >
            {Array.from({ length: pilotUnitCount }, (_, index) => (
              <i className={index < pilotAcceptedUnits ? 'accepted' : ''} key={index} />
            ))}
          </div>
          <button
            className="button button-primary pilot-launch-button"
            type="button"
            disabled={!canLaunchHeld || launching}
            onClick={() => void launchHeldUnits()}
          >
            {launching ? t('pool.launching') : t('pool.launchRest')} <Rocket aria-hidden="true" />
          </button>
        </section>
      ) : null}

      <nav className="detail-tabs" aria-label={t('pool.tabsAria')}>
        <button
          type="button"
          className={tab === 'overview' ? 'active' : ''}
          onClick={() => setTab('overview')}
        >
          {t('pool.tabLive')}
        </button>
        <button
          type="button"
          className={tab === 'results' ? 'active' : ''}
          onClick={() => setTab('results')}
        >
          {t('pool.tabResults')} <span>{pool.submittedUnits + pool.acceptedUnits}</span>
        </button>
      </nav>

      {tab === 'overview' ? (
        <div className="overview-layout">
          <section>
            <div className="detail-block">
              <div className="section-bar">
                <div>
                  <h2>{t('pool.requirements')}</h2>
                </div>
              </div>
              <dl className="contract-grid">
                <div>
                  <dt>
                    <Cpu aria-hidden="true" /> Agent
                  </dt>
                  <dd>{pool.requestedAgent}</dd>
                </div>
                <div>
                  <dt>
                    <Cpu aria-hidden="true" /> {t('pool.model')}
                  </dt>
                  <dd>{pool.requestedModel}</dd>
                </div>
                <div>
                  <dt>
                    <Gauge aria-hidden="true" /> {t('pool.concurrencyCap')}
                  </dt>
                  <dd>{pool.requiredConcurrency}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 aria-hidden="true" /> {t('pool.unitLimit')}
                  </dt>
                  <dd>{duration(pool.maxUnitSeconds)}</dd>
                </div>
                <div>
                  <dt>
                    <Boxes aria-hidden="true" /> {t('pool.unitReward')}
                  </dt>
                  <dd className="contract-pulse">{credits(pool.rewardPerUnit)}</dd>
                </div>
                <div>
                  <dt>
                    <CheckCircle2 aria-hidden="true" /> {t('pool.howDone')}
                  </dt>
                  <dd>{acceptanceLabel()}</dd>
                </div>
                <div>
                  <dt>
                    {webhookDelivery ? (
                      <Webhook aria-hidden="true" />
                    ) : (
                      <ShieldCheck aria-hidden="true" />
                    )}{' '}
                    {t('pool.resultDest')}
                  </dt>
                  <dd>{webhookDelivery ? webhookHostname(webhookUrl) : t('pool.destContract')}</dd>
                </div>
                <div>
                  <dt>
                    <LockKeyhole aria-hidden="true" /> {t('pool.data')}
                  </dt>
                  <dd>
                    {pool.datasetMode === 'work'
                      ? t('pool.dataWork')
                      : pool.datasetMode === 'https'
                        ? t('pool.dataJsonl')
                        : t('pool.dataInline')}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <aside className="owner-secret-panel">
            <div className="owner-secret-head">
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>{t('pool.taskNotes')}</strong>
              </div>
            </div>
            <p>{t('pool.notesLead')}</p>
            {capsule ? (
              <>
                <div className="capsule-detail-summary">
                  {capsule.goal && capsule.goal !== pool.title ? (
                    <strong>{capsule.goal}</strong>
                  ) : null}
                  <dl>
                    {capsule.inputDescription && capsule.inputDescription !== pool.publicSummary ? (
                      <div>
                        <dt>{t('pool.input')}</dt>
                        <dd>{capsule.inputDescription}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t('pool.output')}</dt>
                      <dd>{capsule.outputDescription}</dd>
                    </div>
                    <div>
                      <dt>{t('pool.format')}</dt>
                      <dd>{capsule.delivery.format.toUpperCase()}</dd>
                    </div>
                    <div>
                      <dt>{t('pool.maxOutput')}</dt>
                      <dd>{Math.round(capsule.delivery.maxBytes / 1024)} KB</dd>
                    </div>
                  </dl>
                </div>
                <details>
                  <summary>
                    {t('pool.constraintsExamples')} <ChevronDown aria-hidden="true" />
                  </summary>
                  <pre>
                    {JSON.stringify(
                      { constraints: capsule.constraints, examples: capsule.examples },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <details>
                  <summary>
                    {t('pool.actualChecks')} <ChevronDown aria-hidden="true" />
                  </summary>
                  <pre>{JSON.stringify(capsule.acceptance, null, 2)}</pre>
                </details>
              </>
            ) : (
              <details>
                <summary>
                  {t('pool.legacyInstructions')} <ChevronDown aria-hidden="true" />
                </summary>
                <pre>{pool.secretInstruction || t('pool.noInstruction')}</pre>
              </details>
            )}
          </aside>
        </div>
      ) : (
        <section className="results-section">
          <div className="result-toolbar">
            <div>
              <h2>{t('pool.resultsTitle')}</h2>
            </div>
            <label>
              <span className="sr-only">{t('pool.filterAria')}</span>
              <select
                value={statusFilter}
                onChange={(event) => {
                  const value = event.target.value as 'all' | 'submitted' | 'accepted' | 'failed';
                  setStatusFilter(value);
                  void loadResultPage(0, value);
                }}
              >
                <option value="all">{t('pool.filterAll')}</option>
                <option value="submitted">{t('pool.filterSubmitted')}</option>
                <option value="accepted">{t('pool.filterAccepted')}</option>
                <option value="failed">{t('pool.filterFailed')}</option>
              </select>
            </label>
          </div>
          <div className="results-table" role="table" aria-label={t('pool.tableAria')}>
            <div className="results-head" role="row">
              <span>{t('pool.colUnit')}</span>
              <span>{t('pool.colStatus')}</span>
              <span>{webhookDelivery ? t('pool.colIoConfirm') : t('pool.colIoResult')}</span>
              <span>{t('pool.colRun')}</span>
              <span>{t('pool.colReview')}</span>
            </div>
            {filteredUnits.map((unit, index) => (
              <article className="result-row" role="row" key={unit.id}>
                <div className="result-id">
                  <span>{String(resultOffset + index + 1).padStart(4, '0')}</span>
                  <strong>{unit.label || unit.id.slice(0, 8)}</strong>
                  {unit.isPilot ? <em className="pilot-unit-tag">{t('pool.pilotTag')}</em> : null}
                  <small>{relativeTime(unit.updatedAt)}</small>
                </div>
                <div>
                  <span className={`unit-status unit-${unit.status}`}>
                    {unitStatus[unit.status]}
                  </span>
                  {unit.score !== undefined ? <small>Score {percent(unit.score)}</small> : null}
                </div>
                <details className="result-detail">
                  <summary>
                    {webhookDelivery ? t('pool.viewIoConfirm') : t('pool.viewIoResult')}{' '}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div>
                    <span>{t('pool.input')}</span>
                    <pre>{resultJson(unit.input, t('pool.noDelivery'))}</pre>
                  </div>
                  {webhookDelivery ? (
                    <div>
                      <span>{t('pool.theirConfirm')}</span>
                      <pre>{resultJson(unit.externalReceipt, t('pool.noDelivery'))}</pre>
                    </div>
                  ) : (
                    <div>
                      <span>{t('pool.result')}</span>
                      <pre>{resultJson(unit.output, t('pool.noDelivery'))}</pre>
                    </div>
                  )}
                  <div className="validation-evidence">
                    <span>{t('pool.checkRecord', { attempt: unit.attemptCount ?? 0 })}</span>
                    <pre>
                      {resultJson(
                        unit.validation || {
                          checks: t('pool.noValidation'),
                        },
                        t('pool.noDelivery'),
                      )}
                    </pre>
                  </div>
                  {unit.rejectionReason ? (
                    <p className="rejection-reason">{unit.rejectionReason}</p>
                  ) : null}
                </details>
                <div className="result-runtime">
                  <strong>{unit.agent || pool.requestedAgent}</strong>
                  <small>{unit.model || pool.requestedModel}</small>
                </div>
                <div className="review-actions">
                  {pool.validationMode === 'manual' && unit.status === 'submitted' ? (
                    <>
                      <button
                        className="icon-button icon-accept"
                        type="button"
                        disabled={reviewing === unit.id}
                        aria-label={t('pool.acceptAria', { label: unit.label || unit.id })}
                        onClick={() => void review(unit, 'accept')}
                      >
                        <Check aria-hidden="true" />
                      </button>
                      {canRetry ? (
                        <button
                          className="icon-button icon-retry"
                          type="button"
                          disabled={reviewing === unit.id}
                          aria-label={t('pool.retryAria', { label: unit.label || unit.id })}
                          onClick={() => void review(unit, 'retry')}
                        >
                          <RotateCcw aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        className="icon-button icon-reject"
                        type="button"
                        disabled={reviewing === unit.id}
                        aria-label={t('pool.rejectAria', { label: unit.label || unit.id })}
                        onClick={() => void review(unit, 'reject')}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </article>
            ))}
            {!filteredUnits.length ? (
              <div className="results-empty">{t('pool.emptyFilter')}</div>
            ) : null}
          </div>
          {(pool.resultTotal || 0) > 100 ? (
            <div className="result-pagination">
              <span>
                {t('pool.showing', {
                  from: resultOffset + 1,
                  to: Math.min(resultOffset + filteredUnits.length, pool.resultTotal || 0),
                  total: formatInteger(pool.resultTotal || 0),
                })}
              </span>
              <div>
                <button
                  className="button button-outline button-small"
                  type="button"
                  disabled={resultLoading || resultOffset === 0}
                  onClick={() => void loadResultPage(Math.max(0, resultOffset - 100))}
                >
                  {t('pool.prev')}
                </button>
                <button
                  className="button button-outline button-small"
                  type="button"
                  disabled={
                    resultLoading || resultOffset + filteredUnits.length >= (pool.resultTotal || 0)
                  }
                  onClick={() => void loadResultPage(resultOffset + 100)}
                >
                  {t('pool.next')}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {cancelOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setCancelOpen(false)}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-title"
          >
            <div className="dialog-icon">
              <Ban aria-hidden="true" />
            </div>
            <h2 id="cancel-title">{t('pool.cancelTitle')}</h2>
            <p>{t('pool.cancelBody')}</p>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setCancelOpen(false)}
              >
                {t('pool.keep')}
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? t('pool.cancelling') : t('pool.confirmCancel')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
