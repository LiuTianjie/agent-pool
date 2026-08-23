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
  UserRound,
  Webhook,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { api, ApiError } from '../lib/api';
import { credits, duration, formatInteger, relativeTime } from '../lib/format';
import {
  clampClaimUnits,
  matchingMarketPools,
  runnerPickCommand,
  runnerResumeCommand,
} from '../lib/runnerMarket';
import type { RunnerMarketPool, RunnerNodePublic } from '../lib/types';
import { CopyCommand } from './CopyCommand';

interface RunnerClaimMarketProps {
  nodes: RunnerNodePublic[];
  pools: RunnerMarketPool[];
  loading: boolean;
  error?: string | null;
  onReload(): void;
}

function nodeStatusLabel(
  status: RunnerNodePublic['status'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (status === 'online') return t('common.online');
  if (status === 'paused') return t('common.paused');
  return t('common.offline');
}

export function RunnerClaimMarket({
  nodes,
  pools,
  loading,
  error,
  onReload,
}: RunnerClaimMarketProps) {
  const { t } = useI18n();
  const [nodeId, setNodeId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [units, setUnits] = useState(1);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [createdClaim, setCreatedClaim] = useState<{
    id: string;
    command: string;
    maxUnits: number;
    expiresAt: string;
  } | null>(null);
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
  const marketStatus: Partial<Record<RunnerMarketPool['status'], string>> = {
    piloting: t('market.piloting'),
    waiting_capacity: t('market.open'),
    queued: t('market.open'),
    running: t('market.running'),
  };

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
    setCreatedClaim(null);
    setClaimError(null);
  }, [selectedPool]);

  const safeUnits = selectedPool ? clampClaimUnits(units, selectedPool.queuedUnits) : 1;

  const createClaim = async () => {
    if (!selectedNode || !selectedPool) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const result = await api.createNodeClaim(selectedNode.id, {
        poolId: selectedPool.id,
        maxUnits: safeUnits,
      });
      setCreatedClaim({
        id: result.claim.id,
        command: runnerResumeCommand(selectedNode, result.claim.id, selectedPool.deliveryMode),
        maxUnits: result.claim.maxUnits,
        expiresAt: result.claim.expiresAt,
      });
    } catch (requestError) {
      setClaimError(
        requestError instanceof ApiError ? requestError.message : t('market.createFailed'),
      );
    } finally {
      setClaiming(false);
    }
  };

  return (
    <section className="runner-market-card">
      <header className="runner-market-head">
        <div>
          <span className="runner-market-icon" aria-hidden="true">
            <Target />
          </span>
          <span>
            <h2>{t('market.title')}</h2>
          </span>
        </div>
      </header>

      <div className="runner-market-rule">
        <RadioTower aria-hidden="true" />
        <p>{t('market.rule')}</p>
      </div>

      {loading ? (
        <div className="runner-market-state" role="status">
          <RadioTower aria-hidden="true" /> {t('market.loading')}
        </div>
      ) : error ? (
        <div className="runner-market-state runner-market-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
          <button className="text-link" type="button" onClick={onReload}>
            <RefreshCcw aria-hidden="true" /> {t('common.retry')}
          </button>
        </div>
      ) : !nodes.length ? (
        <div className="runner-market-state">
          <Bot aria-hidden="true" /> {t('market.noMachine')}
        </div>
      ) : (
        <div className="runner-market-body">
          <div className="runner-market-picker">
            <label>
              <span>{t('market.pickMachine')}</span>
              <select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
                {nodes.map((node) => (
                  <option value={node.id} key={node.id}>
                    {t('market.optionNode', {
                      name: node.name,
                      kind:
                        node.operatorType === 'official'
                          ? t('common.official')
                          : t('common.community'),
                      certs: node.certifications.length,
                    })}
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
                    {nodeStatusLabel(selectedNode.status, t)} ·{' '}
                    {selectedNode.platform || t('common.platformUnknownShort')} ·{' '}
                    {selectedNode.id.slice(0, 12)}
                  </small>
                </div>
                <em className={selectedNode.operatorType === 'official' ? 'is-official' : ''}>
                  {selectedNode.operatorType === 'official' ? (
                    <ServerCog aria-hidden="true" />
                  ) : null}
                  {selectedNode.operatorType === 'official'
                    ? t('common.official')
                    : t('common.community')}
                </em>
              </article>
            ) : null}

            <label>
              <span>{t('market.pickBatch')}</span>
              <select
                value={poolId}
                disabled={!matchedPools.length}
                onChange={(event) => setPoolId(event.target.value)}
              >
                {!matchedPools.length ? (
                  <option value="">{t('market.noneAvailable')}</option>
                ) : null}
                {matchedPools.map((pool) => (
                  <option value={pool.id} key={pool.id}>
                    {t('market.optionPool', {
                      owned: pool.owned ? t('market.ownPrefix') : '',
                      title: pool.title,
                      units: pool.queuedUnits,
                      reward: credits(pool.rewardPerUnit),
                    })}
                  </option>
                ))}
              </select>
            </label>

            {!matchedPools.length ? (
              <div className="runner-market-no-match">
                <Cpu aria-hidden="true" />
                <span>{t('market.noMatch')}</span>
              </div>
            ) : null}
          </div>

          {selectedPool && selectedNode ? (
            <div className="runner-market-claim">
              <header>
                <div>
                  <span>
                    {selectedPool.owned ? t('market.ownTask') : ''}
                    {marketStatus[selectedPool.status] || selectedPool.status}
                  </span>
                  <h3>{selectedPool.title}</h3>
                </div>
                <strong>
                  {t('market.perUnit', { amount: credits(selectedPool.rewardPerUnit) })}
                </strong>
              </header>
              <p>{selectedPool.publicSummary}</p>
              <dl>
                <div>
                  <dt>{t('market.requestedAdapter')}</dt>
                  <dd>
                    {selectedPool.requestedAgent} / {selectedPool.requestedModel}
                  </dd>
                </div>
                <div>
                  <dt>{t('market.resultDest')}</dt>
                  <dd>
                    {selectedPool.deliveryMode === 'webhook'
                      ? t('market.destWebhook')
                      : t('market.destContract')}
                  </dd>
                </div>
                <div>
                  <dt>{t('market.availableNow')}</dt>
                  <dd>
                    {t('market.unitsNow', { count: formatInteger(selectedPool.queuedUnits) })}
                  </dd>
                </div>
                <div>
                  <dt>{t('market.concurrencyCap')}</dt>
                  <dd>{selectedPool.requiredConcurrency}</dd>
                </div>
              </dl>

              {selectedPool.owned ? (
                <div className="runner-market-owned">
                  <UserRound aria-hidden="true" />
                  <span>
                    <strong>{t('market.ownTitle')}</strong>
                    <small>{t('market.ownDetail')}</small>
                  </span>
                </div>
              ) : null}

              <div className="runner-market-proof">
                <CheckCircle2 aria-hidden="true" />
                <span>
                  <strong>{t('market.matchTitle')}</strong>
                  {matchingCertification ? (
                    <small>
                      {t('market.certMeta', {
                        p95: duration(matchingCertification.p95Ms / 1000),
                        concurrency: matchingCertification.certifiedConcurrency,
                        expiry: relativeTime(matchingCertification.expiresAt),
                      })}
                    </small>
                  ) : null}
                </span>
              </div>

              {selectedPool.deliveryMode === 'webhook' ? (
                <div className="runner-market-webhook">
                  <Webhook aria-hidden="true" />
                  <span>
                    <strong>{t('market.webhookTitle')}</strong>
                    {selectedNode.operatorType === 'official'
                      ? t('market.webhookOfficial')
                      : t('market.webhookCommunity')}{' '}
                    {t('market.webhookSource')}
                  </span>
                </div>
              ) : null}

              <label className="runner-market-units">
                <span>{t('market.pickCount')}</span>
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
                  <small>
                    {t('market.unitsMax', { count: formatInteger(selectedPool.queuedUnits) })}
                  </small>
                </div>
              </label>

              {claimError ? (
                <div className="runner-market-state runner-market-error" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <span>{claimError}</span>
                </div>
              ) : null}

              {createdClaim ? (
                <div className="runner-market-command">
                  <div>
                    <TerminalSquare aria-hidden="true" />
                    <span>
                      <strong>{t('market.runOn', { name: selectedNode.name })}</strong>
                      <small>
                        {t('market.claimReady', {
                          units: createdClaim.maxUnits,
                          expiry: relativeTime(createdClaim.expiresAt),
                        })}
                      </small>
                    </span>
                  </div>
                  <CopyCommand command={createdClaim.command} />
                </div>
              ) : (
                <button
                  className="button button-primary runner-market-create"
                  type="button"
                  disabled={claiming}
                  onClick={() => void createClaim()}
                >
                  {claiming ? t('market.creating') : t('market.createClaim', { units: safeUnits })}
                </button>
              )}

              <p className="runner-market-pick-alt">
                {t('market.pickAlt')} <code>{runnerPickCommand(selectedNode, selectedPool)}</code>
              </p>
              <div className="runner-market-return">
                <Clock3 aria-hidden="true" />
                {t('market.batchMax', { units: safeUnits })}
                <span>
                  {selectedPool.owned
                    ? t('market.selfRun')
                    : t('market.maxEarn', {
                        amount: credits(safeUnits * selectedPool.rewardPerUnit),
                      })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
