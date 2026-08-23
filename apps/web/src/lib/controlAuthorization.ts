import { t } from '../i18n/translate';
import type { ControlDevicePreview, ControlScope } from './types';

export interface ControlScopePresentation {
  label: string;
  detail: string;
  risk: 'standard' | 'high';
}

const CONTROL_SCOPE_META: Record<
  ControlScope,
  { label: Parameters<typeof t>[0]; detail: Parameters<typeof t>[0]; risk: 'standard' | 'high' }
> = {
  'account:read': {
    label: 'scopes.accountRead',
    detail: 'scopes.accountReadDetail',
    risk: 'standard',
  },
  'pools:read': {
    label: 'scopes.poolsRead',
    detail: 'scopes.poolsReadDetail',
    risk: 'standard',
  },
  'pools:write': {
    label: 'scopes.poolsWrite',
    detail: 'scopes.poolsWriteDetail',
    risk: 'high',
  },
  'wallet:read': {
    label: 'scopes.walletRead',
    detail: 'scopes.walletReadDetail',
    risk: 'standard',
  },
  'wallet:write': {
    label: 'scopes.walletWrite',
    detail: 'scopes.walletWriteDetail',
    risk: 'high',
  },
  'runners:read': {
    label: 'scopes.runnersRead',
    detail: 'scopes.runnersReadDetail',
    risk: 'standard',
  },
  'runners:pair': {
    label: 'scopes.runnersPair',
    detail: 'scopes.runnersPairDetail',
    risk: 'high',
  },
  'fleet:read': {
    label: 'scopes.fleetRead',
    detail: 'scopes.fleetReadDetail',
    risk: 'standard',
  },
  'fleet:write': {
    label: 'scopes.fleetWrite',
    detail: 'scopes.fleetWriteDetail',
    risk: 'high',
  },
  'profile:write': {
    label: 'scopes.profileWrite',
    detail: 'scopes.profileWriteDetail',
    risk: 'standard',
  },
  'events:read': {
    label: 'scopes.eventsRead',
    detail: 'scopes.eventsReadDetail',
    risk: 'standard',
  },
  'credentials:read': {
    label: 'scopes.credentialsRead',
    detail: 'scopes.credentialsReadDetail',
    risk: 'standard',
  },
  'credentials:write': {
    label: 'scopes.credentialsWrite',
    detail: 'scopes.credentialsWriteDetail',
    risk: 'high',
  },
};

export function controlScopePresentation(scope: ControlScope): ControlScopePresentation {
  const meta = CONTROL_SCOPE_META[scope];
  return {
    label: t(meta.label),
    detail: t(meta.detail),
    risk: meta.risk,
  };
}

export function highRiskControlScopes(scopes: ControlScope[]): ControlScope[] {
  return scopes.filter((scope) => controlScopePresentation(scope).risk === 'high');
}

export function controlPreviewNeedsRiskConfirmation(
  preview: Pick<ControlDevicePreview, 'kind' | 'scopes'>,
): boolean {
  return preview.kind === 'control' && highRiskControlScopes(preview.scopes).length > 0;
}

export function formatCredentialTtl(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds % 86_400 === 0) return t('format.ttlDays', { n: seconds / 86_400 });
  if (seconds % 3_600 === 0) return t('format.ttlHours', { n: seconds / 3_600 });
  if (seconds >= 3_600) return t('format.ttlHours', { n: Math.round(seconds / 3_600) });
  return t('format.ttlMinutes', { n: Math.max(1, Math.round(seconds / 60)) });
}
