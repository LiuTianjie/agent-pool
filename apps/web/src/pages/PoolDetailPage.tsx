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
import { InlineError, LoadingState } from '../components/LoadingState';
import { LiveStatus, PoolStatus } from '../components/Status';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { api, ApiError } from '../lib/api';
import { credits, duration, fullDateTime, percent, relativeTime } from '../lib/format';
import type { PoolDetail, PoolUnit, UnitStatus } from '../lib/types';
import { webhookHostname } from '../lib/taskContract';
import { printableValue } from '../lib/units';

const UNIT_STATUS: Record<UnitStatus, string> = {
  queued: '排队',
  leased: '执行中',
  running: '执行中',
  submitted: '待验收',
  accepted: '已通过',
  rejected: '已拒绝',
  failed: '失败',
  cancelled: '已取消',
};

function resultJson(value: unknown): string {
  if (value === undefined) return '尚无交付内容';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function PoolDetailPage() {
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

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setPool(await api.getPool(poolId));
        setError(null);
      } catch (requestError) {
        setError(requestError instanceof ApiError ? requestError.message : '无法读取这批任务');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [poolId],
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
      setError(requestError instanceof ApiError ? requestError.message : '无法读取交付结果');
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
              ? '发布者要求重新执行'
              : '发布者拒绝了本次交付',
        ),
      );
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '验收操作失败');
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
      setError(requestError instanceof ApiError ? requestError.message : '取消失败');
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
      setError(requestError instanceof ApiError ? requestError.message : '开放剩余任务失败');
    } finally {
      setLaunching(false);
    }
  };

  if (loading && !pool) return <LoadingState label="正在读取这批任务" />;
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

  return (
    <div className="page pool-detail-page">
      <Link className="back-link" to="/app">
        <ArrowLeft aria-hidden="true" /> 返回控制台
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
              <RadioTower aria-hidden="true" /> 去领取
            </Link>
          ) : null}
          <button
            className="button button-outline button-small"
            type="button"
            onClick={() => void load(true)}
          >
            <RefreshCw aria-hidden="true" /> 刷新
          </button>
          {canCancel ? (
            <button
              className="button button-danger-quiet button-small"
              type="button"
              onClick={() => setCancelOpen(true)}
            >
              <Ban aria-hidden="true" /> 取消这批任务
            </button>
          ) : null}
        </div>
      </header>

      {error ? <InlineError message={error} /> : null}

      <section className="pool-hero-meter">
        <div className="meter-main">
          <div className="meter-number">
            <strong>{pool.acceptedUnits.toLocaleString('zh-CN')}</strong>
            <span>/ {pool.totalUnits.toLocaleString('zh-CN')}</span>
          </div>
          <small>已通过</small>
        </div>
        <div className="concurrency-display">
          <div>
            <strong>{activeConcurrency}</strong>
            <span>/ {pool.requiredConcurrency}</span>
          </div>
          <small>同时执行上限</small>
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
            <h2>试跑已全部通过，可以开放剩余任务。</h2>
            <p>
              {pilotAcceptedUnits}/{pilotUnitCount} 已通过 · {pilotFailedUnits} 失败 ·{' '}
              {heldUnitCount.toLocaleString('zh-CN')} 条还没开放。
            </p>
          </div>
          <div
            className="pilot-gate-meter"
            aria-label={`试跑 ${pilotAcceptedUnits}/${pilotUnitCount}`}
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
            {launching ? '正在开放…' : '开放剩余'} <Rocket aria-hidden="true" />
          </button>
        </section>
      ) : null}

      <nav className="detail-tabs" aria-label="任务详情">
        <button
          type="button"
          className={tab === 'overview' ? 'active' : ''}
          onClick={() => setTab('overview')}
        >
          实时进度
        </button>
        <button
          type="button"
          className={tab === 'results' ? 'active' : ''}
          onClick={() => setTab('results')}
        >
          结果 <span>{pool.submittedUnits + pool.acceptedUnits}</span>
        </button>
      </nav>

      {tab === 'overview' ? (
        <div className="overview-layout">
          <section>
            <div className="detail-block">
              <div className="section-bar">
                <div>
                  <h2>任务要求</h2>
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
                    <Cpu aria-hidden="true" /> 模型
                  </dt>
                  <dd>{pool.requestedModel}</dd>
                </div>
                <div>
                  <dt>
                    <Gauge aria-hidden="true" /> 同时执行上限
                  </dt>
                  <dd>{pool.requiredConcurrency}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 aria-hidden="true" /> 单条任务时限
                  </dt>
                  <dd>{duration(pool.maxUnitSeconds)}</dd>
                </div>
                <div>
                  <dt>
                    <Boxes aria-hidden="true" /> 单条奖励
                  </dt>
                  <dd className="contract-pulse">{credits(pool.rewardPerUnit)}</dd>
                </div>
                <div>
                  <dt>
                    <CheckCircle2 aria-hidden="true" /> 怎样算完
                  </dt>
                  <dd>
                    {capsule
                      ? {
                          non_empty: '结果非空',
                          hidden_exact: '与预设答案一致',
                          manual: '人工确认',
                          schema: '按格式检查',
                          schema_and_hidden_exact: '格式和答案都要符合',
                          webhook: '由你的地址确认',
                        }[capsule.acceptance.mode] || capsule.acceptance.mode
                      : pool.validationMode === 'auto'
                        ? pool.outputSchema
                          ? '按格式检查'
                          : '结果非空'
                        : '人工确认'}
                  </dd>
                </div>
                <div>
                  <dt>
                    {webhookDelivery ? (
                      <Webhook aria-hidden="true" />
                    ) : (
                      <ShieldCheck aria-hidden="true" />
                    )}{' '}
                    结果去向
                  </dt>
                  <dd>{webhookDelivery ? webhookHostname(webhookUrl) : '按契约验收'}</dd>
                </div>
                <div>
                  <dt>
                    <LockKeyhole aria-hidden="true" /> 数据
                  </dt>
                  <dd>
                    {pool.datasetMode === 'work'
                      ? '工作包托管'
                      : pool.datasetMode === 'https'
                        ? 'JSONL 托管'
                        : '粘贴在平台内'}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <aside className="owner-secret-panel">
            <div className="owner-secret-head">
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>任务说明</strong>
              </div>
            </div>
            <p>做任务的人在自己电脑上看题目。这个页面默认只给你看进度。</p>
            {capsule ? (
              <>
                <div className="capsule-detail-summary">
                  {capsule.goal && capsule.goal !== pool.title ? (
                    <strong>{capsule.goal}</strong>
                  ) : null}
                  <dl>
                    {capsule.inputDescription && capsule.inputDescription !== pool.publicSummary ? (
                      <div>
                        <dt>输入</dt>
                        <dd>{capsule.inputDescription}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>输出</dt>
                      <dd>{capsule.outputDescription}</dd>
                    </div>
                    <div>
                      <dt>格式</dt>
                      <dd>{capsule.delivery.format.toUpperCase()}</dd>
                    </div>
                    <div>
                      <dt>最大输出</dt>
                      <dd>{Math.round(capsule.delivery.maxBytes / 1024)} KB</dd>
                    </div>
                  </dl>
                </div>
                <details>
                  <summary>
                    约束与示例 <ChevronDown aria-hidden="true" />
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
                    实际验收 checks <ChevronDown aria-hidden="true" />
                  </summary>
                  <pre>{JSON.stringify(capsule.acceptance, null, 2)}</pre>
                </details>
              </>
            ) : (
              <details>
                <summary>
                  查看 legacy 任务指令 <ChevronDown aria-hidden="true" />
                </summary>
                <pre>{pool.secretInstruction || '服务端未返回任务指令。'}</pre>
              </details>
            )}
          </aside>
        </div>
      ) : (
        <section className="results-section">
          <div className="result-toolbar">
            <div>
              <h2>任务结果与验收</h2>
            </div>
            <label>
              <span className="sr-only">按状态筛选</span>
              <select
                value={statusFilter}
                onChange={(event) => {
                  const value = event.target.value as 'all' | 'submitted' | 'accepted' | 'failed';
                  setStatusFilter(value);
                  void loadResultPage(0, value);
                }}
              >
                <option value="all">全部状态</option>
                <option value="submitted">待验收</option>
                <option value="accepted">已通过</option>
                <option value="failed">失败</option>
              </select>
            </label>
          </div>
          <div className="results-table" role="table" aria-label="任务交付结果">
            <div className="results-head" role="row">
              <span>任务</span>
              <span>状态</span>
              <span>{webhookDelivery ? '输入 / 确认' : '输入 / 结果'}</span>
              <span>执行</span>
              <span>验收</span>
            </div>
            {filteredUnits.map((unit, index) => (
              <article className="result-row" role="row" key={unit.id}>
                <div className="result-id">
                  <span>{String(resultOffset + index + 1).padStart(4, '0')}</span>
                  <strong>{unit.label || unit.id.slice(0, 8)}</strong>
                  {unit.isPilot ? <em className="pilot-unit-tag">试跑</em> : null}
                  <small>{relativeTime(unit.updatedAt)}</small>
                </div>
                <div>
                  <span className={`unit-status unit-${unit.status}`}>
                    {UNIT_STATUS[unit.status]}
                  </span>
                  {unit.score !== undefined ? <small>Score {percent(unit.score)}</small> : null}
                </div>
                <details className="result-detail">
                  <summary>
                    {webhookDelivery ? '查看输入和确认' : '查看输入和结果'}{' '}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div>
                    <span>输入</span>
                    <pre>{resultJson(unit.input)}</pre>
                  </div>
                  {webhookDelivery ? (
                    <div>
                      <span>对方的确认</span>
                      <pre>{resultJson(unit.externalReceipt)}</pre>
                    </div>
                  ) : (
                    <div>
                      <span>结果</span>
                      <pre>{resultJson(unit.output)}</pre>
                    </div>
                  )}
                  <div className="validation-evidence">
                    <span>检查记录 · 第 {unit.attemptCount ?? 0} 次</span>
                    <pre>
                      {resultJson(
                        unit.validation || {
                          checks: '服务端未返回 validation evidence',
                        },
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
                        aria-label={`通过 ${unit.label || unit.id}`}
                        onClick={() => void review(unit, 'accept')}
                      >
                        <Check aria-hidden="true" />
                      </button>
                      {canRetry ? (
                        <button
                          className="icon-button icon-retry"
                          type="button"
                          disabled={reviewing === unit.id}
                          aria-label={`重新执行 ${unit.label || unit.id}`}
                          onClick={() => void review(unit, 'retry')}
                        >
                          <RotateCcw aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        className="icon-button icon-reject"
                        type="button"
                        disabled={reviewing === unit.id}
                        aria-label={`拒绝 ${unit.label || unit.id}`}
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
              <div className="results-empty">当前筛选条件下还没有任务。</div>
            ) : null}
          </div>
          {(pool.resultTotal || 0) > 100 ? (
            <div className="result-pagination">
              <span>
                显示 {resultOffset + 1}–
                {Math.min(resultOffset + filteredUnits.length, pool.resultTotal || 0)} /{' '}
                {(pool.resultTotal || 0).toLocaleString('zh-CN')}
              </span>
              <div>
                <button
                  className="button button-outline button-small"
                  type="button"
                  disabled={resultLoading || resultOffset === 0}
                  onClick={() => void loadResultPage(Math.max(0, resultOffset - 100))}
                >
                  上一页
                </button>
                <button
                  className="button button-outline button-small"
                  type="button"
                  disabled={
                    resultLoading || resultOffset + filteredUnits.length >= (pool.resultTotal || 0)
                  }
                  onClick={() => void loadResultPage(resultOffset + 100)}
                >
                  下一页
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
            <h2 id="cancel-title">取消这批任务？</h2>
            <p>还没开始的会停掉并退回积分。已经在做的会按结果结算。取消后不能恢复。</p>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setCancelOpen(false)}
              >
                暂不取消
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? '正在取消…' : '确认取消'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
