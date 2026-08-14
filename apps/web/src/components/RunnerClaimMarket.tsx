import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Cpu,
  RadioTower,
  RefreshCcw,
  ServerCog,
  Target,
  TerminalSquare,
  Webhook,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CopyCommand } from './CopyCommand';
import { credits, duration, relativeTime } from '../lib/format';
import {
  clampClaimUnits,
  matchingMarketPools,
  runnerClaimCommand,
  runnerPickCommand,
} from '../lib/runnerMarket';
import type { RunnerMarketPool, RunnerNodePublic } from '../lib/types';

const MARKET_STATUS: Partial<Record<RunnerMarketPool['status'], string>> = {
  piloting: '点火批次开放领取',
  waiting_capacity: '开放领取',
  queued: '开放领取',
  running: '执行中 / 仍可领取',
};

interface RunnerClaimMarketProps {
  nodes: RunnerNodePublic[];
  pools: RunnerMarketPool[];
  loading: boolean;
  error?: string | null;
  onReload(): void;
}

export function RunnerClaimMarket({
  nodes,
  pools,
  loading,
  error,
  onReload,
}: RunnerClaimMarketProps) {
  const [nodeId, setNodeId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [units, setUnits] = useState(1);
  const selectedNode = nodes.find((node) => node.id === nodeId);
  const matchedPools = useMemo(
    () => matchingMarketPools(selectedNode, pools),
    [pools, selectedNode],
  );
  const selectedPool = matchedPools.find((pool) => pool.id === poolId);
  const matchingCertification = selectedPool
    ? selectedNode?.certifications.find(
        (certification) =>
          certification.adapter === selectedPool.requestedAgent &&
          certification.model === selectedPool.requestedModel &&
          certification.certifiedConcurrency > 0 &&
          certification.p95Ms <= selectedPool.maxUnitSeconds * 1_000 &&
          Date.parse(certification.expiresAt) > Date.now(),
      )
    : undefined;

  useEffect(() => {
    if (!nodes.length) {
      setNodeId('');
      return;
    }
    if (!nodes.some((node) => node.id === nodeId)) setNodeId(nodes[0]!.id);
  }, [nodeId, nodes]);

  useEffect(() => {
    if (!matchedPools.length) {
      setPoolId('');
      return;
    }
    if (!matchedPools.some((pool) => pool.id === poolId)) setPoolId(matchedPools[0]!.id);
  }, [matchedPools, poolId]);

  useEffect(() => {
    if (!selectedPool) return;
    setUnits(Math.min(3, selectedPool.queuedUnits));
  }, [selectedPool]);

  const safeUnits = selectedPool ? clampClaimUnits(units, selectedPool.queuedUnits) : 1;
  const command =
    selectedNode && selectedPool ? runnerClaimCommand(selectedNode, selectedPool, safeUnits) : '';

  return (
    <section className="runner-market-card">
      <header className="runner-market-head">
        <div>
          <span className="runner-market-icon" aria-hidden="true">
            <Target />
          </span>
          <span>
            <h2>选一台 Runner，抢这一批</h2>
          </span>
        </div>
      </header>

      <div className="runner-market-rule">
        <RadioTower aria-hidden="true" />
        <p>
          <strong>上线不等于接单。</strong>
          平台不会后台扫单或自动派发。只有你选择具体 Runner、Pool 和数量，并在那台机器运行一次性
          Claim 命令，才会创建短期 Grant 并开始这一批。
        </p>
      </div>

      {loading ? (
        <div className="runner-market-state" role="status">
          <RadioTower aria-hidden="true" /> 正在比对公开 Pool 与你的有效认证…
        </div>
      ) : error ? (
        <div className="runner-market-state runner-market-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
          <button className="text-link" type="button" onClick={onReload}>
            <RefreshCcw aria-hidden="true" /> 重试
          </button>
        </div>
      ) : !nodes.length ? (
        <div className="runner-market-state">
          <Bot aria-hidden="true" /> 还没有 Runner。先完成下方安装、登录和 benchmark，再回来领取。
        </div>
      ) : (
        <div className="runner-market-body">
          <div className="runner-market-picker">
            <label>
              <span>01 / 具体 Runner 或 Cell</span>
              <select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
                {nodes.map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.name} · {node.operatorType === 'official' ? 'OFFICIAL' : 'COMMUNITY'} ·{' '}
                    {node.certifications.length} CERTS
                  </option>
                ))}
              </select>
            </label>

            {selectedNode ? (
              <article className="runner-market-node">
                <span className={`node-indicator node-${selectedNode.status}`} aria-hidden="true" />
                <div>
                  <strong>{selectedNode.name}</strong>
                  <small>
                    {selectedNode.status.toUpperCase()} · {selectedNode.platform || 'platform —'} ·{' '}
                    {selectedNode.id.slice(0, 12)}
                  </small>
                </div>
                <em className={selectedNode.operatorType === 'official' ? 'is-official' : ''}>
                  {selectedNode.operatorType === 'official' ? (
                    <ServerCog aria-hidden="true" />
                  ) : null}
                  {selectedNode.operatorType.toUpperCase()}
                </em>
              </article>
            ) : null}

            <label>
              <span>02 / 精确匹配的 Pool</span>
              <select
                value={poolId}
                disabled={!matchedPools.length}
                onChange={(event) => setPoolId(event.target.value)}
              >
                {!matchedPools.length ? <option value="">没有可领取的精确匹配</option> : null}
                {matchedPools.map((pool) => (
                  <option value={pool.id} key={pool.id}>
                    {pool.title} · {pool.queuedUnits} Units · {credits(pool.rewardPerUnit)}
                  </option>
                ))}
              </select>
            </label>

            {!matchedPools.length ? (
              <div className="runner-market-no-match">
                <Cpu aria-hidden="true" />
                <span>
                  这台 Runner 当前没有可领取的精确匹配。需要 Agent、model、有效 benchmark、P95
                  时限和 Webhook 权限全部吻合；离线不影响匹配，运行 Claim 命令时会连接。
                </span>
              </div>
            ) : null}
          </div>

          {selectedPool && selectedNode ? (
          <div className="runner-market-claim">
              <>
                <header>
                  <div>
                    <span>{MARKET_STATUS[selectedPool.status] || selectedPool.status}</span>
                    <h3>{selectedPool.title}</h3>
                  </div>
                  <strong>{credits(selectedPool.rewardPerUnit)} / UNIT</strong>
                </header>
                <p>{selectedPool.publicSummary}</p>
                <dl>
                  <div>
                    <dt>EXACT TARGET</dt>
                    <dd>
                      {selectedPool.requestedAgent} / {selectedPool.requestedModel}
                    </dd>
                  </div>
                  <div>
                    <dt>DELIVERY</dt>
                    <dd>{selectedPool.deliveryMode.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>AVAILABLE NOW</dt>
                    <dd>{selectedPool.queuedUnits.toLocaleString('zh-CN')} Units</dd>
                  </div>
                  <div>
                    <dt>SIMULTANEOUS LIMIT</dt>
                    <dd>{selectedPool.requiredConcurrency}</dd>
                  </div>
                </dl>

                <div className="runner-market-proof">
                  <CheckCircle2 aria-hidden="true" />
                  <span>
                    <strong>有效自托管正确性 / 性能证据</strong>
                    {matchingCertification ? (
                      <small>
                        P95 {duration(matchingCertification.p95Ms / 1000)} · 并发证据{' '}
                        {matchingCertification.certifiedConcurrency} ·{' '}
                        {relativeTime(matchingCertification.expiresAt)}到期
                      </small>
                    ) : null}
                  </span>
                </div>

                {selectedPool.deliveryMode === 'webhook' ? (
                  <div className="runner-market-webhook">
                    <Webhook aria-hidden="true" />
                    <span>
                      <strong>直达 Webhook</strong>
                      {selectedNode.operatorType === 'official' ? (
                        <>
                          该 Official Cell 已由服务端确认开启 Webhook；命令从 Cell
                          配置读取权限，不接受额外 opt-in 参数。
                        </>
                      ) : (
                        <>
                          此命令包含显式 <code>--allow-webhooks</code>。
                        </>
                      )}{' '}
                      发布者可观察 Runner 出口 IP，输出不存平台。
                    </span>
                  </div>
                ) : null}

                <label className="runner-market-units">
                  <span>03 / 这一批最多领取</span>
                  <div>
                    <input
                      type="number"
                      min={1}
                      max={Math.min(20_000, selectedPool.queuedUnits)}
                      step={1}
                      inputMode="numeric"
                      value={units}
                      onChange={(event) => setUnits(Number(event.target.value))}
                    />
                    <small>UNITS / MAX {selectedPool.queuedUnits.toLocaleString('zh-CN')}</small>
                  </div>
                </label>

                <div className="runner-market-command">
                  <div>
                    <TerminalSquare aria-hidden="true" />
                    <span>
                      <strong>04 / 在 {selectedNode.name} 所在机器运行</strong>
                      <small>
                        {selectedNode.operatorType === 'official'
                          ? 'Official CLI 从 Cell 配置选择精确 Agent / model / Webhook 能力；命令只接受 Pool 与数量。'
                          : 'Community CLI 用命令里的 Agent / model / Webhook opt-in 创建精确 Grant。'}{' '}
                        复制本身不会接单；运行后才开始，并在额度用完、过期或中断后退出。
                      </small>
                    </span>
                  </div>
                  <CopyCommand command={command} />
                  <p className="runner-market-pick-alt">
                    不想从网页复制？也可运行{' '}
                    <code>{runnerPickCommand(selectedNode, selectedPool)}</code>{' '}
                    在终端查看公开任务、选编号与数量。
                  </p>
                </div>
                <div className="runner-market-return">
                  <Clock3 aria-hidden="true" />
                  一次性 Claim · 最多 {safeUnits} Units · 完成后回到待命
                  <span>
                    最多可赚 {credits(safeUnits * selectedPool.rewardPerUnit)} · 演示积分 /
                    非真实法币
                  </span>
                </div>
              </>
          </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
