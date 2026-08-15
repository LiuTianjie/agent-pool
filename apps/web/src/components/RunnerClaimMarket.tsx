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
  piloting: '试跑中',
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
            <h2>选一台，领一批</h2>
          </span>
        </div>
      </header>

      <div className="runner-market-rule">
        <RadioTower aria-hidden="true" />
        <p>
          上线之后，还要在这台机器上运行领取命令。
        </p>
      </div>

      {loading ? (
        <div className="runner-market-state" role="status">
          <RadioTower aria-hidden="true" /> 正在查找可领的任务…
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
          <Bot aria-hidden="true" /> 还没有机器。先完成下面的安装和登录。
        </div>
      ) : (
        <div className="runner-market-body">
          <div className="runner-market-picker">
            <label>
              <span>01 / 用哪台</span>
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
              <span>02 / 领哪一批</span>
              <select
                value={poolId}
                disabled={!matchedPools.length}
                onChange={(event) => setPoolId(event.target.value)}
              >
                {!matchedPools.length ? <option value="">现在没有可领的</option> : null}
                {matchedPools.map((pool) => (
                  <option value={pool.id} key={pool.id}>
                    {pool.title} · {pool.queuedUnits} 条任务 · {credits(pool.rewardPerUnit)}
                  </option>
                ))}
              </select>
            </label>

            {!matchedPools.length ? (
              <div className="runner-market-no-match">
                <Cpu aria-hidden="true" />
                <span>
                  这台现在没有可领的任务。需要执行器和模型对得上。
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
                  <strong>{credits(selectedPool.rewardPerUnit)} / 条</strong>
                </header>
                <p>{selectedPool.publicSummary}</p>
                <dl>
                  <div>
                    <dt>指定执行器</dt>
                    <dd>
                      {selectedPool.requestedAgent} / {selectedPool.requestedModel}
                    </dd>
                  </div>
                  <div>
                    <dt>结果去向</dt>
                    <dd>{selectedPool.deliveryMode === 'webhook' ? '发到对方地址' : '保存在这里'}</dd>
                  </div>
                  <div>
                    <dt>现在可领</dt>
                    <dd>{selectedPool.queuedUnits.toLocaleString('zh-CN')} 条任务</dd>
                  </div>
                  <div>
                    <dt>同时执行上限</dt>
                    <dd>{selectedPool.requiredConcurrency}</dd>
                  </div>
                </dl>

                <div className="runner-market-proof">
                  <CheckCircle2 aria-hidden="true" />
                  <span>
                    <strong>这台对得上</strong>
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
                      <strong>结果发到对方地址</strong>
                      {selectedNode.operatorType === 'official'
                        ? '这台已经允许外发。'
                        : '这条命令会带上允许外发。'}{' '}
                      对方看得到你的网络来源。
                    </span>
                  </div>
                ) : null}

                <label className="runner-market-units">
                  <span>03 / 领几条</span>
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
                    <small>条 / 最多 {selectedPool.queuedUnits.toLocaleString('zh-CN')}</small>
                  </div>
                </label>

                <div className="runner-market-command">
                  <div>
                    <TerminalSquare aria-hidden="true" />
                    <span>
                      <strong>04 / 在 {selectedNode.name} 上运行</strong>
                      <small>复制还不会开始，运行之后才领。</small>
                    </span>
                  </div>
                  <CopyCommand command={command} />
                  <p className="runner-market-pick-alt">
                    也可以在终端运行 <code>{runnerPickCommand(selectedNode, selectedPool)}</code>{' '}
                    自己选。
                  </p>
                </div>
                <div className="runner-market-return">
                  <Clock3 aria-hidden="true" />
                  这一批最多 {safeUnits} 条
                  <span>最多可赚 {credits(safeUnits * selectedPool.rewardPerUnit)}</span>
                </div>
              </>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
