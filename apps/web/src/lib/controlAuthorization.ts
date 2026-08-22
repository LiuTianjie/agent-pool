import type { ControlDevicePreview, ControlScope } from './types';

export interface ControlScopePresentation {
  label: string;
  detail: string;
  risk: 'standard' | 'high';
}

const CONTROL_SCOPE_PRESENTATIONS: Record<ControlScope, ControlScopePresentation> = {
  'account:read': {
    label: '查看账户',
    detail: '查看你的账户信息。',
    risk: 'standard',
  },
  'pools:read': {
    label: '查看任务',
    detail: '查看你发布的任务和结果。',
    risk: 'standard',
  },
  'pools:write': {
    label: '管理任务',
    detail: '发布、取消任务，并确认结果。',
    risk: 'high',
  },
  'wallet:read': {
    label: '查看余额',
    detail: '查看积分和流水。',
    risk: 'standard',
  },
  'wallet:write': {
    label: '操作资金',
    detail: '增加或转出积分。',
    risk: 'high',
  },
  'runners:read': {
    label: '查看机器',
    detail: '查看已连接机器的状态。',
    risk: 'standard',
  },
  'runners:pair': {
    label: '连接机器',
    detail: '代你批准一台新机器连上来。',
    risk: 'high',
  },
  'fleet:read': {
    label: '查看官方节点',
    detail: '查看官方节点的状态。',
    risk: 'standard',
  },
  'fleet:write': {
    label: '管理官方节点',
    detail: '开关你名下的官方节点。',
    risk: 'high',
  },
  'profile:write': {
    label: '修改资料',
    detail: '改显示名称。',
    risk: 'standard',
  },
  'events:read': {
    label: '订阅动态',
    detail: '持续查看任务和账户动态。',
    risk: 'standard',
  },
  'credentials:read': {
    label: '查看控制凭证',
    detail: '查看已授权的程序。',
    risk: 'standard',
  },
  'credentials:write': {
    label: '撤销控制凭证',
    detail: '关掉其他程序的授权。',
    risk: 'high',
  },
};

export function controlScopePresentation(scope: ControlScope): ControlScopePresentation {
  return CONTROL_SCOPE_PRESENTATIONS[scope];
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
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} 小时`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}
