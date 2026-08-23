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
import { useI18n } from '../i18n';
import { credits, formatInteger, relativeTime } from '../lib/format';
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
  const { t } = useI18n();
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
            <h2>{t('fleet.title')}</h2>
          </div>
        </div>
        <div className="official-fleet-current" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{fleet.mode === 'offline' ? t('fleet.offline') : t('fleet.standby')}</strong>
          </div>
        </div>
      </header>

      <div className="official-fleet-body">
        <div className="official-fleet-console">
          <div className="official-fleet-owner">
            <ServerCog aria-hidden="true" />
            <div>
              <small>{t('fleet.ownerLabel')}</small>
              <strong>{fleet.ownerEmail}</strong>
              <span>{t('fleet.ownerHint')}</span>
            </div>
            <em>{t('fleet.bound')}</em>
          </div>

          <div className="official-fleet-manual-rule">
            <MousePointer2 aria-hidden="true" />
            <div>
              <strong>{t('fleet.noAutoClaim')}</strong>
              <span>{t('fleet.noAutoClaimDetail')}</span>
            </div>
          </div>

          <fieldset className="official-mode-fieldset" disabled={changingMode !== null}>
            <legend>{t('fleet.powerLegend')}</legend>
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
                  <strong>{t('fleet.standbyTitle')}</strong>
                  <small>{t('fleet.standbyDetail')}</small>
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
                  <strong>{t('fleet.offlineTitle')}</strong>
                  <small>{t('fleet.offlineDetail')}</small>
                </span>
                <i aria-hidden="true" />
              </button>
            </div>
          </fieldset>

          <div className="official-mode-readout">
            <span>
              {changingMode
                ? t('fleet.switching')
                : fleet.mode === 'offline'
                  ? t('fleet.offlineNote')
                  : t('fleet.standbyNote')}
            </span>
            <small>{t('fleet.updated', { time: relativeTime(fleet.updatedAt) })}</small>
          </div>
          {error ? (
            <p className="official-fleet-error" role="alert">
              <AlertTriangle aria-hidden="true" /> {error}
            </p>
          ) : null}

          <div className="official-fleet-metrics">
            <article>
              <RadioTower aria-hidden="true" />
              <span>{t('fleet.machinesOnline')}</span>
              <strong>
                {fleet.nodeSummary.online} <small>/ {fleet.nodeSummary.total}</small>
              </strong>
            </article>
            <article>
              <Activity aria-hidden="true" />
              <span>{t('fleet.doing')}</span>
              <strong>{fleet.nodeSummary.activeLeases}</strong>
            </article>
            <article>
              <Zap aria-hidden="true" />
              <span>{t('fleet.maxConcurrent')}</span>
              <strong>{totals.maxConcurrency}</strong>
            </article>
            <article>
              <Bot aria-hidden="true" />
              <span>{t('fleet.todayDone')}</span>
              <strong>{formatInteger(completedToday)}</strong>
            </article>
            <article className="official-earned-metric">
              <Zap aria-hidden="true" />
              <span>{t('fleet.todayEarned')}</span>
              <strong>{credits(earnedToday)}</strong>
            </article>
          </div>

          {nodes.length ? (
            <div className="official-node-strip" aria-label={t('fleet.nodesAria')}>
              {nodes.map((node) => (
                <article key={node.id}>
                  <span className={`node-indicator node-${node.status}`} aria-hidden="true" />
                  <div>
                    <strong>{node.name}</strong>
                    <small>
                      {t('fleet.occupancy', {
                        active: node.activeLeases,
                        max: node.maxConcurrency,
                        platform: node.platform || t('common.platformUnknownShort'),
                      })}
                    </small>
                  </div>
                  {isOfficialRunner(node) ? (
                    <em className="official-node-badge">
                      <ServerCog aria-hidden="true" /> {t('common.official')}
                    </em>
                  ) : (
                    <em className="operator-unverified">{t('fleet.unmarked')}</em>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="official-nodes-empty">{t('fleet.empty')}</p>
          )}
        </div>

        <aside className="official-model-path">
          <div className="model-path-step">
            <KeyRound aria-hidden="true" />
            <span>
              <strong>{t('fleet.noCollect')}</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step warm">
            <RadioTower aria-hidden="true" />
            <span>
              <strong>{t('fleet.partnerGateway')}</strong>
            </span>
          </div>
          <i aria-hidden="true" />
          <div className="model-path-step">
            <Bot aria-hidden="true" />
            <span>
              <strong>{t('fleet.officialRunner')}</strong>
            </span>
          </div>
          <p>
            <AlertTriangle aria-hidden="true" />
            <span>{t('fleet.pathWarn')}</span>
          </p>
        </aside>
      </div>
    </section>
  );
}
