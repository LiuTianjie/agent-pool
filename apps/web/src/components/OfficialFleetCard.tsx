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
            <h2>OFFICIAL FLEET</h2>
          </div>
        </div>
        <div className="official-fleet-current" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{fleet.mode.toUpperCase()}</strong>
          </div>
        </div>
      </header>

      <div className="official-fleet-body">
        <div className="official-fleet-console">
          <div className="official-fleet-owner">
            <ServerCog aria-hidden="true" />
            <div>
              <small>积分收益账户</small>
              <strong>{fleet.ownerEmail}</strong>
              <span>官方节点赚到的积分进这个账户</span>
            </div>
            <em>SERVER BOUND</em>
          </div>

          <div className="official-fleet-manual-rule">
            <MousePointer2 aria-hidden="true" />
            <div>
              <strong>官方节点也不会自己去领</strong>
              <span>要做的话，还是在上面选一批，再到对应机器运行命令。</span>
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
                  ? '官方 Cell 已停机，无法领取新任务。'
                  : '待命中。要做任务，还是得运行领取命令。'}
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
              <span>在线机器</span>
              <strong>
                {fleet.nodeSummary.online} <small>/ {fleet.nodeSummary.total}</small>
              </strong>
            </article>
            <article>
              <Activity aria-hidden="true" />
              <span>正在做</span>
              <strong>{fleet.nodeSummary.activeLeases}</strong>
            </article>
            <article>
              <Zap aria-hidden="true" />
              <span>同时最多</span>
              <strong>{totals.maxConcurrency}</strong>
            </article>
            <article>
              <Bot aria-hidden="true" />
              <span>今日完成</span>
              <strong>{completedToday.toLocaleString('zh-CN')}</strong>
            </article>
            <article className="official-earned-metric">
              <Zap aria-hidden="true" />
              <span>今日收益</span>
              <strong>{credits(earnedToday)}</strong>
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
              现在还没有官方机器连上来。
            </p>
          )}
        </div>

        <aside className="official-model-path">
          <div className="model-path-step">
            <KeyRound aria-hidden="true" />
            <span>
              <strong>不收集</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step warm">
            <RadioTower aria-hidden="true" />
            <span>
              <strong>合作模型网关</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step">
            <Bot aria-hidden="true" />
            <span>
              <strong>Official Runner</strong>
            </span>
          </div>
          <p>
            <AlertTriangle aria-hidden="true" />
            <span>
              官方节点用平台自己的模型通道，任务内容会经过这些机器。
            </span>
          </p>
        </aside>
      </div>
    </section>
  );
}
