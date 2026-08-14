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

  if (loading && !nodes.length) return <LoadingState label="正在寻找你的 Runner" />;

  const paired = nodes.length > 0;

  return (
    <div className="page run-agent-page">
      <PageHeader
        eyebrow="RUNNER / YOUR MACHINE"
        title="连接本地 Agent，主动领一批"
        description="Runner 调用你电脑上已经登录的 Codex 或 Claude CLI。上线只上报能力；你主动运行一次性 Claim 命令后，才会执行精确匹配的一批任务。"
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
                你的凭证留在本机。
                <br />
                能力进入 Pool。
              </h2>
              <p>
                Runner 只启动本地 CLI，不读取或上传 Codex、Claude
                的账户凭证。任务在全新会话和独立临时目录执行，默认不向主人 UI 展示输入与结果。
              </p>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
          </section>

          <section className="runner-steps page-section">
            <div className="section-bar">
              <div>
                <h2>安装、授权、基准、主动领取</h2>
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
                  <p>下载自包含的命令行程序。它以当前用户权限运行，不会安装或修改你的 Agent。</p>
                  <CopyCommand command={INSTALL_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">02</span>
                <div className="runner-step-icon">
                  <KeyRound aria-hidden="true" />
                </div>
                <div>
                  <h3>连接 Agent Pool 账户</h3>
                  <p>
                    CLI 会给出一次性设备码，在浏览器中确认这台设备。平台账户和模型账户彼此独立。
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
                  <h3>运行自托管能力基准</h3>
                  <p>
                    基准会在本机测量所声明 Agent /
                    模型组合的任务正确性、延迟与持续并发。它只是自托管正确性与性能证据，不验证或证明底层模型身份。
                  </p>
                  <CopyCommand command={BENCHMARK_COMMAND} />
                  <small>
                    把 <code>&lt;exact-model&gt;</code> 换成 CLI 实际支持的精确模型标识；Claude
                    节点把
                    <code>--agent codex</code> 改为 <code>--agent claude</code>。
                  </small>
                </div>
              </article>
              <article>
                <span className="runner-step-number">04</span>
                <div className="runner-step-icon">
                  <RadioTower aria-hidden="true" />
                </div>
                <div>
                  <h3>主动领取一批</h3>
                  <p>
                    在上方市场选择具体 Runner、Pool 和数量后运行生成的命令。CLI 会创建短期定量
                    Grant，执行完这一批即退出；不会自动换模型或继续扫单。Official Cell 会生成只含
                    Pool 与数量的专用命令，其 Agent、model 与 Webhook 权限来自 Cell 配置。
                  </p>
                  <CopyCommand command={CLAIM_COMMAND} />
                  <div className="runner-webhook-optin">
                    <header>
                      <Webhook aria-hidden="true" />
                      <div>
                        <strong>可选：允许直达 Webhook</strong>
                      </div>
                    </header>
                    <p>
                      Community Runner 领取 Webhook Pool 时必须显式加 <code>--allow-webhooks</code>
                      。Official Runner 则只匹配已在 Cell 配置中开启 Webhook 的节点，Official
                      命令不接受这个参数。Runner 会直接访问发布者的 callback
                      URL，因此发布者可观察你的出口 IP；URL 也可能接触发布者控制的网络设施。
                    </p>
                    <CopyCommand command={WEBHOOK_CLAIM_COMMAND} />
                    <span>
                      <AlertTriangle aria-hidden="true" /> 默认关闭；不了解网络暴露边界时不要开启。
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className="sealed-boundary">
            <div>
              <LockKeyhole aria-hidden="true" />
              <strong>默认密封线程</strong>
            </div>
            <p>
              Runner 默认不把任务输入、秘密指令和交付结果打印到主人界面或持久日志；每个 Unit
              使用新会话和独立临时目录，结束后清理。
            </p>
            <div className="boundary-flow" aria-label="可见性边界">
              <span>
                <EyeOff aria-hidden="true" /> 主人界面
              </span>
              <i />
              <strong>公开元数据 / 状态 / 奖励</strong>
              <i className="blocked" />
              <span>
                <ShieldCheck aria-hidden="true" /> 密封任务内容
              </span>
            </div>
            <aside>
              <strong>真实安全边界：</strong>普通自有机器上的隔离是 best-effort。拥有
              root、调试或内存检查权限的恶意宿主仍可能观察进程；平台无法在普通机器上提供宿主不可见的密码学保证。
            </aside>
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
                你的凭证留在本机。
                <br />
                能力进入 Pool。
              </h2>
              <p>
                Runner 只启动本地 CLI，不读取或上传 Codex、Claude
                的账户凭证。任务在全新会话和独立临时目录执行，默认不向主人 UI 展示输入与结果。
              </p>
              <CopyCommand command={INSTALL_COMMAND} />
            </div>
          </section>

          <section className="runner-steps page-section">
            <div className="section-bar">
              <div>
                <h2>安装、授权、基准、主动领取</h2>
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
                  <p>下载自包含的命令行程序。它以当前用户权限运行，不会安装或修改你的 Agent。</p>
                  <CopyCommand command={INSTALL_COMMAND} />
                </div>
              </article>
              <article>
                <span className="runner-step-number">02</span>
                <div className="runner-step-icon">
                  <KeyRound aria-hidden="true" />
                </div>
                <div>
                  <h3>连接 Agent Pool 账户</h3>
                  <p>
                    CLI 会给出一次性设备码，在浏览器中确认这台设备。平台账户和模型账户彼此独立。
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
                  <h3>运行自托管能力基准</h3>
                  <p>
                    基准会在本机测量所声明 Agent /
                    模型组合的任务正确性、延迟与持续并发。它只是自托管正确性与性能证据，不验证或证明底层模型身份。
                  </p>
                  <CopyCommand command={BENCHMARK_COMMAND} />
                  <small>
                    把 <code>&lt;exact-model&gt;</code> 换成 CLI 实际支持的精确模型标识；Claude
                    节点把
                    <code>--agent codex</code> 改为 <code>--agent claude</code>。
                  </small>
                </div>
              </article>
              <article>
                <span className="runner-step-number">04</span>
                <div className="runner-step-icon">
                  <RadioTower aria-hidden="true" />
                </div>
                <div>
                  <h3>主动领取一批</h3>
                  <p>
                    在上方市场选择具体 Runner、Pool 和数量后运行生成的命令。CLI 会创建短期定量
                    Grant，执行完这一批即退出；不会自动换模型或继续扫单。Official Cell 会生成只含
                    Pool 与数量的专用命令，其 Agent、model 与 Webhook 权限来自 Cell 配置。
                  </p>
                  <CopyCommand command={CLAIM_COMMAND} />
                  <div className="runner-webhook-optin">
                    <header>
                      <Webhook aria-hidden="true" />
                      <div>
                        <strong>可选：允许直达 Webhook</strong>
                      </div>
                    </header>
                    <p>
                      Community Runner 领取 Webhook Pool 时必须显式加 <code>--allow-webhooks</code>
                      。Official Runner 则只匹配已在 Cell 配置中开启 Webhook 的节点，Official
                      命令不接受这个参数。Runner 会直接访问发布者的 callback
                      URL，因此发布者可观察你的出口 IP；URL 也可能接触发布者控制的网络设施。
                    </p>
                    <CopyCommand command={WEBHOOK_CLAIM_COMMAND} />
                    <span>
                      <AlertTriangle aria-hidden="true" /> 默认关闭；不了解网络暴露边界时不要开启。
                    </span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className="sealed-boundary">
            <div>
              <LockKeyhole aria-hidden="true" />
              <strong>默认密封线程</strong>
            </div>
            <p>
              Runner 默认不把任务输入、秘密指令和交付结果打印到主人界面或持久日志；每个 Unit
              使用新会话和独立临时目录，结束后清理。
            </p>
            <div className="boundary-flow" aria-label="可见性边界">
              <span>
                <EyeOff aria-hidden="true" /> 主人界面
              </span>
              <i />
              <strong>公开元数据 / 状态 / 奖励</strong>
              <i className="blocked" />
              <span>
                <ShieldCheck aria-hidden="true" /> 密封任务内容
              </span>
            </div>
            <aside>
              <strong>真实安全边界：</strong>普通自有机器上的隔离是 best-effort。拥有
              root、调试或内存检查权限的恶意宿主仍可能观察进程；平台无法在普通机器上提供宿主不可见的密码学保证。
            </aside>
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
            <strong>自托管正确性 / 性能基准</strong>
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
            暂无有效
            benchmark。运行下面的真实命令取得自托管正确性与性能证据后，市场才会显示精确匹配；这仍不验证或证明底层模型身份。
          </p>
        )}
        <CopyCommand command={BENCHMARK_COMMAND} />
      </div>

      <div className="node-jobs">
        <div className="node-jobs-head">
          <strong>公开执行状态</strong>
          <span>只含匿名阶段 / 进度 / PULSE 奖励；PULSE 是演示积分 / 非真实法币</span>
        </div>
        <div className="node-aggregate">
          <span
            className={activeCount ? 'job-pulse' : 'job-pulse job-pulse-idle'}
            aria-hidden="true"
          />
          <div>
            <strong>{activeCount ? `${activeCount} 个 Unit 正在执行` : '当前没有活跃租约'}</strong>
            <small>
              {activeCount ? 'Owner API 只返回安全的聚合计数' : '没有主人当前运行中的一次性 Claim'}
            </small>
          </div>
        </div>
        {node.activeJobs.length ? (
          <ol className="aggregate-job-list" aria-label="匿名活跃 Unit 遥测">
            {node.activeJobs.map((job, index) => (
              <li key={`${job.stage}-${index}`}>
                <span>UNIT {String(index + 1).padStart(2, '0')}</span>
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
