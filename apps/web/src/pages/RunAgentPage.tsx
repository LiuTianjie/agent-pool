import type { LiveEvent } from '@agent-pool/shared';
import {
  BadgeCheck,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
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
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { OfficialFleetCard } from '../components/OfficialFleetCard';
import { PageHeader } from '../components/PageHeader';
import { RunnerClaimMarket } from '../components/RunnerClaimMarket';
import { LiveStatus } from '../components/Status';
import { useLiveEvents } from '../hooks/useLiveEvents';
import { api, ApiError, normalizeList } from '../lib/api';
import { credits, duration, percent, relativeTime } from '../lib/format';
import { isOfficialRunner } from '../lib/officialFleet';
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

export function RunAgentPage() {
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

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setNodes(normalizeList(await api.runners()));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '无法读取 Runner 状态');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadMarket = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingMarket(true);
    try {
      const [publicPools, ownedPools] = await Promise.all([
        api.runnerMarketPools(),
        api.listPools(),
      ]);
      const ownedIds = new Set(ownedPools.map((pool) => pool.id));
      setMarketPools(publicPools.filter((pool) => !ownedIds.has(pool.id)));
      setMarketError(null);
    } catch (requestError) {
      setMarketError(
        requestError instanceof ApiError ? requestError.message : '无法读取 Runner 任务市场',
      );
    } finally {
      if (!quiet) setLoadingMarket(false);
    }
  }, []);

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
        requestError instanceof ApiError ? requestError.message : '无法读取 Official Fleet',
      );
    }
  }, []);

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
        requestError instanceof ApiError ? requestError.message : 'Official Fleet 模式切换失败',
      );
    } finally {
      setChangingFleetMode(null);
    }
  };

  if (loading && !nodes.length) return <LoadingState label="正在加载" />;

  const paired = nodes.length > 0;

  return (
    <div className="page run-agent-page">
      <PageHeader
        eyebrow="运行 Agent"
        title="用自己的电脑来做任务"
        description="接上本机 Codex 或 Claude，领一批来做。"
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
          <summary>安装与领取命令</summary>
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
              <h2>
                密钥留在这台电脑。
              </h2>
              <p>用本机已登录的 Codex 或 Claude 来做。题目不会出现在这个页面。</p>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
          </section>

          <section className="runner-steps page-section">
            <div className="section-bar">
              <div>
                <h2>安装、登录、再领一批</h2>
              </div>
            </div>
            <div className="runner-step-list">
              <article>
                <span className="runner-step-number">01</span>
                <div className="runner-step-icon">
                  <TerminalSquare aria-hidden="true" />
                </div>
                <div>
                  <h3>安装 Runner</h3>
                  <p>下载命令行工具。不会改你已经装好的 Agent。</p>
                  <CopyCommand command={INSTALL_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">02</span>
                <div className="runner-step-icon">
                  <KeyRound aria-hidden="true" />
                </div>
                <div>
                  <h3>登录账户</h3>
                  <p>
                    终端会给出一串设备码，回到这里确认这台电脑。
                  </p>
                  <CopyCommand command={LOGIN_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">03</span>
                <div className="runner-step-icon">
                  <BadgeCheck aria-hidden="true" />
                </div>
                <div>
                  <h3>先跑一遍能力检查</h3>
                  <p>在这台电脑上测一下速度和能不能做对，之后才好领匹配的任务。</p>
                  <CopyCommand command={BENCHMARK_COMMAND} />
                  <small>
                    把 <code>&lt;exact-model&gt;</code> 换成实际模型名。用 Claude 时把
                    <code>--agent</code> 改成 <code>claude</code>。
                  </small>
                </div>
              </article>
              <article>
                <span className="runner-step-number">04</span>
                <div className="runner-step-icon">
                  <RadioTower aria-hidden="true" />
                </div>
                <div>
                  <h3>领一批来做</h3>
                  <p>在上面选好机器和数量，到这台电脑运行命令。做完这一批就会停。</p>
                  <CopyCommand command={CLAIM_COMMAND} />
                  <div className="runner-webhook-optin">
                    <header>
                      <Webhook aria-hidden="true" />
                      <div>
                        <strong>可选：把结果发到对方地址</strong>
                      </div>
                    </header>
                    <p>
                      本机领取这类任务时要加上 <code>--allow-webhooks</code>
                      。对方会看到你的网络来源。
                    </p>
                    <CopyCommand command={WEBHOOK_CLAIM_COMMAND} />
                    <span>
                      <AlertTriangle aria-hidden="true" /> 默认关闭。不确定就别开。
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className="sealed-boundary">
            <div>
              <LockKeyhole aria-hidden="true" />
              <strong>这个页面看不到题目</strong>
            </div>
            <p>这里只显示进度和积分。题目和答案留在执行的那台电脑上。</p>
            <div className="boundary-flow" aria-label="可见范围">
              <span>
                <EyeOff aria-hidden="true" /> 这个页面
              </span>
              <i />
              <strong>进度 / 积分</strong>
              <i className="blocked" />
              <span>
                <ShieldCheck aria-hidden="true" /> 题目和答案
              </span>
            </div>
          </section>
        </details>
      ) : (
        <div className="runner-setup-unpaired">
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
              <h2>
                密钥留在这台电脑。
              </h2>
              <p>用本机已登录的 Codex 或 Claude 来做。题目不会出现在这个页面。</p>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
          </section>

          <section className="runner-steps page-section">
            <div className="section-bar">
              <div>
                <h2>安装、登录、再领一批</h2>
              </div>
            </div>
            <div className="runner-step-list">
              <article>
                <span className="runner-step-number">01</span>
                <div className="runner-step-icon">
                  <TerminalSquare aria-hidden="true" />
                </div>
                <div>
                  <h3>安装 Runner</h3>
                  <p>下载命令行工具。不会改你已经装好的 Agent。</p>
                  <CopyCommand command={INSTALL_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">02</span>
                <div className="runner-step-icon">
                  <KeyRound aria-hidden="true" />
                </div>
                <div>
                  <h3>登录账户</h3>
                  <p>
                    终端会给出一串设备码，回到这里确认这台电脑。
                  </p>
                  <CopyCommand command={LOGIN_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">03</span>
                <div className="runner-step-icon">
                  <BadgeCheck aria-hidden="true" />
                </div>
                <div>
                  <h3>先跑一遍能力检查</h3>
                  <p>在这台电脑上测一下速度和能不能做对，之后才好领匹配的任务。</p>
                  <CopyCommand command={BENCHMARK_COMMAND} />
                  <small>
                    把 <code>&lt;exact-model&gt;</code> 换成实际模型名。用 Claude 时把
                    <code>--agent</code> 改成 <code>claude</code>。
                  </small>
                </div>
              </article>
              <article>
                <span className="runner-step-number">04</span>
                <div className="runner-step-icon">
                  <RadioTower aria-hidden="true" />
                </div>
                <div>
                  <h3>领一批来做</h3>
                  <p>在上面选好机器和数量，到这台电脑运行命令。做完这一批就会停。</p>
                  <CopyCommand command={CLAIM_COMMAND} />
                  <div className="runner-webhook-optin">
                    <header>
                      <Webhook aria-hidden="true" />
                      <div>
                        <strong>可选：把结果发到对方地址</strong>
                      </div>
                    </header>
                    <p>
                      本机领取这类任务时要加上 <code>--allow-webhooks</code>
                      。对方会看到你的网络来源。
                    </p>
                    <CopyCommand command={WEBHOOK_CLAIM_COMMAND} />
                    <span>
                      <AlertTriangle aria-hidden="true" /> 默认关闭。不确定就别开。
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className="sealed-boundary">
            <div>
              <LockKeyhole aria-hidden="true" />
              <strong>这个页面看不到题目</strong>
            </div>
            <p>这里只显示进度和积分。题目和答案留在执行的那台电脑上。</p>
            <div className="boundary-flow" aria-label="可见范围">
              <span>
                <EyeOff aria-hidden="true" /> 这个页面
              </span>
              <i />
              <strong>进度 / 积分</strong>
              <i className="blocked" />
              <span>
                <ShieldCheck aria-hidden="true" /> 题目和答案
              </span>
            </div>
          </section>
        </div>
      )}

      <section className="page-section">
        <div className="section-bar">
          <div>
            <h2>已连接的执行节点</h2>
          </div>
          <span>
            {nodes.filter((node) => node.status === 'online').length} 在线 / {nodes.length} 总计
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
            title="还没有 Runner 连接"
            detail="在自己的 Mac 或 Linux 机器执行上面的安装命令，然后通过一次性设备码连接。"
            action={<CopyCommand command={INSTALL_COMMAND} />}
          />
        )}
      </section>
    </div>
  );
}

function RunnerNodeCard({ node }: { node: RunnerNodePublic }) {
  const activeCount = Math.max(node.activeLeases, node.activeJobs.length);
  const validCertifications = node.certifications.filter(
    (certification) => Date.parse(certification.expiresAt) > Date.now(),
  );

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
              <ServerCog aria-hidden="true" /> OFFICIAL
            </span>
          ) : null}
          <span className={`node-status node-status-${node.status}`}>
            {node.status === 'online' ? '在线' : node.status === 'paused' ? '已暂停' : '离线'}
          </span>
        </div>
      </header>
      <div className="node-target">
        <div>
          <Cpu aria-hidden="true" />
          <span>
            <small>PLATFORM</small>
            <strong>{node.platform || '未上报平台信息'}</strong>
          </span>
        </div>
        <div>
          <Gauge aria-hidden="true" />
          <span>
            <small>ACTIVE / MAX</small>
            <strong>
              {node.activeLeases} / {node.maxConcurrency}
            </strong>
          </span>
        </div>
        <div>
          <RadioTower aria-hidden="true" />
          <span>
            <small>ANONYMOUS JOBS</small>
            <strong>{activeCount} ACTIVE</strong>
          </span>
        </div>
      </div>

      <div className="cert-card cert-card-instruction">
        <header>
          <BadgeCheck aria-hidden="true" />
          <div>
            <strong>能力记录</strong>
            <small>{validCertifications.length} 个有效精确组合 · 不证明模型身份</small>
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
                <span>P95 {duration(certification.p95Ms / 1000)}</span>
                <span>并发证据 {certification.certifiedConcurrency}</span>
                <span>成功率 {percent(certification.successRate)}</span>
                <small>{relativeTime(certification.expiresAt)}到期</small>
              </article>
            ))}
          </div>
        ) : (
          <p>
            还没有能力记录。先跑下面的检查，才能领到对得上的任务。
          </p>
        )}
        <CopyCommand command={BENCHMARK_COMMAND} />
      </div>

      <div className="node-jobs">
        <div className="node-jobs-head">
          <strong>正在做的</strong>
          <span>只显示进度和积分</span>
        </div>
        <div className="node-aggregate">
          <span
            className={activeCount ? 'job-pulse' : 'job-pulse job-pulse-idle'}
            aria-hidden="true"
          />
          <div>
            <strong>{activeCount ? `${activeCount} 条任务正在执行` : '当前没有进行中的任务'}</strong>
            <small>
              {activeCount ? '进行中' : '现在空闲'}
            </small>
          </div>
        </div>
        {node.activeJobs.length ? (
          <ol className="aggregate-job-list" aria-label="匿名活跃任务进度">
            {node.activeJobs.map((job, index) => (
              <li key={`${job.stage}-${index}`}>
                <span>任务 {String(index + 1).padStart(2, '0')}</span>
                <strong>{job.stage}</strong>
                <span>{percent(job.progress)}</span>
                <span>{credits(job.reward)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <footer>
        <span>Runner {node.runnerVersion || '—'}</span>
        <span>最后信号 {relativeTime(node.lastSeenAt)}</span>
      </footer>
    </article>
  );
}
