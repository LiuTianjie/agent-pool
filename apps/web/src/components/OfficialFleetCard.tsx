import {
  Activity,
  AlertTriangle,
  Bot,
  KeyRound,
  MousePointer2,
  Pause,
  Power,
  RadioTower,
  ServerCog,
  Zap,
} from 'lucide-react';
import { credits, relativeTime } from '../lib/format';
import { isOfficialRunner, officialFleetTotals } from '../lib/officialFleet';
import type { OfficialFleetMode, OfficialFleetView, RunnerNodePublic } from '../lib/types';

interface OfficialFleetCardProps {
  fleet: OfficialFleetView;
  nodes: RunnerNodePublic[];
  changingMode: OfficialFleetMode | null;
  error?: string | null;
  onModeChange(mode: OfficialFleetMode): void;
}

export function OfficialFleetCard({
  fleet,
  nodes,
  changingMode,
  error,
  onModeChange,
}: OfficialFleetCardProps) {
  const totals = officialFleetTotals(nodes);
  const completedToday = nodes.reduce((total, node) => total + node.completedToday, 0);
  const earnedToday = nodes.reduce((total, node) => total + node.earnedToday, 0);

  return (
    <section className={`official-fleet-card official-fleet-${fleet.mode}`}>
      <header className="official-fleet-head">
        <div className="official-fleet-ident">
          <span className="official-fleet-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <div>
            <span className="section-index">OPERATOR CONTROL / OWNER ONLY</span>
            <h2>OFFICIAL FLEET</h2>
          </div>
        </div>
        <div className="official-fleet-current" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <small>POWER STATE</small>
            <strong>{fleet.mode.toUpperCase()}</strong>
          </div>
        </div>
      </header>

      <div className="official-fleet-body">
        <div className="official-fleet-console">
          <div className="official-fleet-owner">
            <ServerCog aria-hidden="true" />
            <div>
              <small>PULSE EARNING OWNER</small>
              <strong>{fleet.ownerEmail}</strong>
              <span>官方 Runner 收益进入此 Agent Pool 账户</span>
            </div>
            <em>SERVER BOUND</em>
          </div>

          <div className="official-fleet-manual-rule">
            <MousePointer2 aria-hidden="true" />
            <div>
              <strong>Official 也不自动接单</strong>
              <span>
                待命只保持 Owner 控制与 Cell 状态。要执行任务，请在上方统一市场选择具体 Official
                Cell、Pool 和数量，再去对应机器运行一次性 Claim 命令。
              </span>
            </div>
          </div>

          <fieldset className="official-mode-fieldset" disabled={changingMode !== null}>
            <legend>节点电源</legend>
            <div className="official-mode-switch official-mode-switch-compact">
              <button
                type="button"
                aria-pressed={fleet.mode === 'standby'}
                className={
                  fleet.mode === 'standby' ? 'official-mode mode-standby active' : 'official-mode'
                }
                onClick={() => onModeChange('standby')}
              >
                <Pause aria-hidden="true" />
                <span>
                  <strong>待命</strong>
                  <small>STANDBY</small>
                </span>
                <i aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-pressed={fleet.mode === 'offline'}
                className={
                  fleet.mode === 'offline' ? 'official-mode mode-offline active' : 'official-mode'
                }
                onClick={() => onModeChange('offline')}
              >
                <Power aria-hidden="true" />
                <span>
                  <strong>停机</strong>
                  <small>OFFLINE</small>
                </span>
                <i aria-hidden="true" />
              </button>
            </div>
          </fieldset>

          <div className="official-mode-readout">
            <span>
              {changingMode
                ? '正在切换节点电源…'
                : fleet.mode === 'offline'
                  ? '官方 Cell 已停机，无法执行新的 Claim。'
                  : 'Cell 处于待命；没有主人运行的一次性 Claim 就不会领取 Unit。'}
            </span>
            <small>最后更新 {relativeTime(fleet.updatedAt)}</small>
          </div>
          {error ? (
            <p className="official-fleet-error" role="alert">
              <AlertTriangle aria-hidden="true" /> {error}
            </p>
          ) : null}

          <div className="official-fleet-metrics">
            <article>
              <RadioTower aria-hidden="true" />
              <span>CONNECTED CELLS</span>
              <strong>
                {fleet.nodeSummary.online} <small>/ {fleet.nodeSummary.total}</small>
              </strong>
            </article>
            <article>
              <Activity aria-hidden="true" />
              <span>ACTIVE LEASES</span>
              <strong>{fleet.nodeSummary.activeLeases}</strong>
            </article>
            <article>
              <Zap aria-hidden="true" />
              <span>MAX CONCURRENCY</span>
              <strong>{totals.maxConcurrency}</strong>
            </article>
            <article>
              <Bot aria-hidden="true" />
              <span>COMPLETED TODAY</span>
              <strong>{completedToday.toLocaleString('zh-CN')}</strong>
            </article>
            <article className="official-earned-metric">
              <Zap aria-hidden="true" />
              <span>EARNED TODAY</span>
              <strong>{credits(earnedToday)}</strong>
              <small>演示积分 / 非真实法币</small>
            </article>
          </div>

          {nodes.length ? (
            <div className="official-node-strip" aria-label="官方 Fleet Cell">
              {nodes.map((node) => (
                <article key={node.id}>
                  <span className={`node-indicator node-${node.status}`} aria-hidden="true" />
                  <div>
                    <strong>{node.name}</strong>
                    <small>
                      {node.activeLeases}/{node.maxConcurrency} active ·{' '}
                      {node.platform || 'platform —'}
                    </small>
                  </div>
                  {isOfficialRunner(node) ? (
                    <em className="official-node-badge">
                      <ServerCog aria-hidden="true" /> OFFICIAL
                    </em>
                  ) : (
                    <em className="operator-unverified">OPERATOR TYPE MISSING</em>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="official-nodes-empty">
              当前没有 Official Cell 上报；Owner 绑定仍会保留。
            </p>
          )}
        </div>

        <aside className="official-model-path">
          <span className="section-index">MODEL PATH / DISCLOSURE</span>
          <div className="model-path-step">
            <KeyRound aria-hidden="true" />
            <span>
              <small>USER KEY</small>
              <strong>不收集</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step warm">
            <RadioTower aria-hidden="true" />
            <span>
              <small>MODEL ACCESS</small>
              <strong>合作模型网关</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step">
            <Bot aria-hidden="true" />
            <span>
              <small>EXECUTION</small>
              <strong>Official Runner</strong>
            </span>
          </div>
          <p>
            <AlertTriangle aria-hidden="true" />
            <span>
              <strong>内容可见边界</strong>
              平台不收集用户的 Codex / Claude
              Key；官方节点改用平台配置的合作模型网关。合作网关、中转站与官方执行基础设施可在处理期间接触任务指令、Unit
              输入和结果。
            </span>
          </p>
          <small>Official 标记只来自服务端派生的 operatorType，不根据邮箱或节点名称推断。</small>
        </aside>
      </div>
    </section>
  );
}
