import type { ControlDevicePreview, ControlScope } from './types';

export interface ControlScopePresentation {
  label: string;
  detail: string;
  risk: 'standard' | 'high';
}

const CONTROL_SCOPE_PRESENTATIONS: Record<ControlScope, ControlScopePresentation> = {
  'account:read': {
    label: '查看账户',
    detail: '读取当前平台身份与账户概况。',
    risk: 'standard',
  },
  'pools:read': {
    label: '查看任务',
    detail: '读取你发布的任务、进度与交付结果。',
    risk: 'standard',
  },
  'pools:write': {
    label: '管理任务',
    detail: '创建、发布、取消任务，并处理交付验收。',
    risk: 'high',
  },
  'wallet:read': {
    label: '查看余额',
    detail: '读取余额与账本记录。',
    risk: 'standard',
  },
  'wallet:write': {
    label: '操作资金',
    detail: '发起充值、提现或其他会改变余额的操作。',
    risk: 'high',
  },
  'runners:read': {
    label: '查看 Runner',
    detail: '读取执行节点、状态与公开遥测。',
    risk: 'standard',
  },
  'runners:pair': {
    label: '配对 Runner',
    detail: '代表你批准 Community Runner 的一次性设备配对。',
    risk: 'high',
  },
  'fleet:read': {
    label: '查看官方 Runner',
    detail: '读取你名下官方 Runner 的状态。',
    risk: 'standard',
  },
  'fleet:write': {
    label: '管理官方 Runner',
    detail: '切换你名下官方 Runner 的运行状态。',
    risk: 'high',
  },
  'profile:write': {
    label: '修改资料',
    detail: '更新平台显示名称等账户资料。',
    risk: 'standard',
  },
  'events:read': {
    label: '订阅动态',
    detail: '持续读取任务、Runner 与账户事件。',
    risk: 'standard',
  },
  'credentials:read': {
    label: '查看控制凭证',
    detail: '读取你已授权的控制 Agent 列表。',
    risk: 'standard',
  },
  'credentials:write': {
    label: '撤销控制凭证',
    detail: '撤销其他控制 Agent 的平台访问权。',
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
