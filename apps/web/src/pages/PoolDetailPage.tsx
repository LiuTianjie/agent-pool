import type { LiveEvent } from '@agent-pool/shared';
import {
  ArrowLeft,
  Ban,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  Cpu,
  Fingerprint,
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
import {
  capacityReason,
  credits,
  duration,
  fullDateTime,
  percent,
  relativeTime,
} from '../lib/format';
import type { PoolDetail, PoolUnit, UnitStatus } from '../lib/types';
import { webhookHostname } from '../lib/taskContract';
import { printableValue } from '../lib/units';

const UNIT_STATUS: Record<UnitStatus, string> = {
  queued: '排队',
  leased: '已租用',
  running: '执行中',
  submitted: '待验收',
  accepted: '已通过',
  rejected: '已拒绝',
  failed: '失败',
  cancelled: '已取消',
};

function completion(pool: PoolDetail): number {
  return pool.totalUnits ? Math.round((pool.acceptedUnits / pool.totalUnits) * 1000) / 10 : 0;
}

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
        setError(requestError instanceof ApiError ? requestError.message : '无法读取任务池');
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
      setError(requestError instanceof ApiError ? requestError.message : '释放全池失败');
    } finally {
      setLaunching(false);
    }
  };

  if (loading && !pool) return <LoadingState label="正在接入任务池" />;
  if (error && !pool) return <InlineError message={error} retry={() => void load()} />;
  if (!pool) return null;

  const progress = completion(pool);
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
              <Ban aria-hidden="true" /> 取消任务池
            </button>
          ) : null}
        </div>
      </header>

      {error ? <InlineError message={error} /> : null}

      <section className="pool-hero-meter">
        <div className="meter-main">
          <span className="mono-label">ACCEPTED / TOTAL</span>
          <div className="meter-number">
            <strong>{pool.acceptedUnits.toLocaleString('zh-CN')}</strong>
            <span>/ {pool.totalUnits.toLocaleString('zh-CN')}</span>
          </div>
          <div className="hero-progress" aria-label={`完成 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <small>{progress}% 已验收通过</small>
        </div>
        <div className="concurrency-display">
          <span className="mono-label">ACTIVE / SIMULTANEOUS LIMIT</span>
          <div>
            <strong>{activeConcurrency}</strong>
            <span>/ {pool.requiredConcurrency}</span>
          </div>
          <small>
            {pool.requestedAgent} · {pool.requestedModel}
          </small>
        </div>
        <div className={deadlineRisk ? 'deadline-display deadline-risk' : 'deadline-display'}>
          <span className="mono-label">DEADLINE / ETA</span>
          <Clock3 aria-hidden="true" />
          <strong>{fullDateTime(pool.deadlineAt)}</strong>
          <small>
            {deadlineRisk
              ? (pool.deadlineRiskReason
                  ? pool.deadlineRiskReason.split(' · ').map(capacityReason).join(' · ')
                  : undefined) || (deadlinePassed ? '截止时间已过' : '当前容量参考提示存在延期风险')
              : pool.estimatedCompletionAt
                ? `容量参考：${relativeTime(pool.estimatedCompletionAt)}完成；需 Runner 主动领取`
                : '暂无足够数据计算 ETA'}
          </small>
        </div>
      </section>

      {canLaunchHeld ? (
        <section className="pilot-gate pilot-gate-ready">
          <div className="pilot-gate-signal" aria-hidden="true">
            <Flame />
          </div>
          <div className="pilot-gate-copy">
            <h2>Pilot 已全部通过，可以放量。</h2>
            <p>
              {pilotAcceptedUnits}/{pilotUnitCount} accepted · {pilotFailedUnits} failed ·{' '}
              {heldUnitCount.toLocaleString('zh-CN')} held。平台不会自动越过这道门。
            </p>
          </div>
          <div
            className="pilot-gate-meter"
            aria-label={`Pilot ${pilotAcceptedUnits}/${pilotUnitCount}`}
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
            {launching ? '正在释放…' : '释放全池'} <Rocket aria-hidden="true" />
          </button>
        </section>
      ) : null}

      <nav className="detail-tabs" aria-label="任务池详情">
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
          交付与验收 <span>{pool.submittedUnits + pool.acceptedUnits}</span>
        </button>
      </nav>

      {tab === 'overview' ? (
        <div className="overview-layout">
          <section>
            <div className="status-count-grid">
              <article>
                <CircleDashed aria-hidden="true" />
                <span>开放领取</span>
                <strong>{pool.queuedUnits.toLocaleString('zh-CN')}</strong>
              </article>
              <article className="status-running">
                <RotateCcw aria-hidden="true" />
                <span>执行中</span>
                <strong>{pool.runningUnits.toLocaleString('zh-CN')}</strong>
              </article>
              <article className="status-submitted">
                <Boxes aria-hidden="true" />
                <span>待验收</span>
                <strong>{pool.submittedUnits.toLocaleString('zh-CN')}</strong>
              </article>
              <article className="status-accepted">
                <CheckCircle2 aria-hidden="true" />
                <span>已通过</span>
                <strong>{pool.acceptedUnits.toLocaleString('zh-CN')}</strong>
              </article>
              <article className="status-failed">
                <X aria-hidden="true" />
                <span>失败</span>
                <strong>{pool.failedUnits.toLocaleString('zh-CN')}</strong>
              </article>
            </div>

            <div className="detail-block">
              <div className="section-bar">
                <div>
                  <span className="section-index">EXECUTION CONTRACT</span>
                  <h2>执行硬约束</h2>
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
                    <Cpu aria-hidden="true" /> 精确模型
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
                    <Clock3 aria-hidden="true" /> 单 Unit 时限
                  </dt>
                  <dd>{duration(pool.maxUnitSeconds)}</dd>
                </div>
                <div>
                  <dt>
                    <Boxes aria-hidden="true" /> Unit 奖励
                  </dt>
                  <dd className="contract-pulse">
                    {credits(pool.rewardPerUnit)}
                    <small>演示积分 / 非真实法币</small>
                  </dd>
                </div>
                <div>
                  <dt>
                    <CheckCircle2 aria-hidden="true" /> 验收
                  </dt>
                  <dd>
                    {capsule
                      ? capsule.acceptance.mode
                      : pool.validationMode === 'auto'
                        ? pool.outputSchema
                          ? '自动验收（JSON Schema 结构检查）'
                          : '自动验收（仅非空检查）'
                        : '发布者人工验收'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <Fingerprint aria-hidden="true" /> 合同 Hash
                  </dt>
                  <dd title={pool.contractHash || 'legacy'}>
                    {pool.contractHash ? `${pool.contractHash.slice(0, 16)}…` : 'legacy'}
                  </dd>
                </div>
                <div>
                  <dt>
                    {webhookDelivery ? (
                      <Webhook aria-hidden="true" />
                    ) : (
                      <ShieldCheck aria-hidden="true" />
                    )}{' '}
                    交付目标
                  </dt>
                  <dd>{webhookDelivery ? webhookHostname(webhookUrl) : 'Agent Pool / platform'}</dd>
                </div>
              </dl>
            </div>
          </section>

          <aside className="owner-secret-panel">
            <div className="owner-secret-head">
              <LockKeyhole aria-hidden="true" />
              <div>
                <span className="mono-label">PUBLISHER ONLY</span>
                <strong>Task Capsule / {capsule?.version || 'legacy'}</strong>
              </div>
            </div>
            <p>
              默认 Runner CLI / UI 不显示或记录任务内容；拥有 root /
              调试权限的恶意宿主仍可能检查进程或内存。
            </p>
            {capsule ? (
              <>
                <div className="capsule-detail-summary">
                  <span>GOAL</span>
                  <strong>{capsule.goal}</strong>
                  <dl>
                    <div>
                      <dt>输入</dt>
                      <dd>{capsule.inputDescription}</dd>
                    </div>
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
              <span className="section-index">DELIVERIES</span>
              <h2>Unit 结果与验收</h2>
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
          <div className="results-table" role="table" aria-label="Unit 交付结果">
            <div className="results-head" role="row">
              <span>Unit</span>
              <span>状态</span>
              <span>{webhookDelivery ? '输入 / 外部回执' : '输入 / 交付'}</span>
              <span>执行</span>
              <span>验收</span>
            </div>
            {filteredUnits.map((unit, index) => (
              <article className="result-row" role="row" key={unit.id}>
                <div className="result-id">
                  <span>{String(resultOffset + index + 1).padStart(4, '0')}</span>
                  <strong>{unit.label || unit.id.slice(0, 8)}</strong>
                  {unit.isPilot ? <em className="pilot-unit-tag">PILOT</em> : null}
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
                    {webhookDelivery ? '查看输入与回执' : '查看输入与结果'}{' '}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div>
                    <span>输入</span>
                    <pre>{resultJson(unit.input)}</pre>
                  </div>
                  {webhookDelivery ? (
                    <div>
                      <span>外部回执摘要（平台不保存输出）</span>
                      <pre>{resultJson(unit.externalReceipt)}</pre>
                    </div>
                  ) : (
                    <div>
                      <span>交付</span>
                      <pre>{resultJson(unit.output)}</pre>
                    </div>
                  )}
                  <div className="validation-evidence">
                    <span>验收证据 · Attempt {unit.attemptCount ?? 0}</span>
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
              <div className="results-empty">当前筛选条件下还没有 Unit。</div>
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
            <h2 id="cancel-title">取消整个任务池？</h2>
            <p>
              未开始的 Unit 将停止开放领取并解锁 PULSE。已经租用或提交的 Unit
              会按服务端结算规则处理；该操作无法撤销。
            </p>
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
                {cancelling ? '正在取消…' : '确认取消任务池'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
