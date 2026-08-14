import { describe, expect, it } from 'vitest';
import {
  controlPreviewNeedsRiskConfirmation,
  controlScopePresentation,
  formatCredentialTtl,
  highRiskControlScopes,
} from './controlAuthorization';

describe('control Agent authorization', () => {
  it('derives high risk only from server-returned scopes', () => {
    expect(
      highRiskControlScopes(['account:read', 'wallet:write', 'runners:pair', 'credentials:write']),
    ).toEqual(['wallet:write', 'runners:pair', 'credentials:write']);
    expect(
      controlPreviewNeedsRiskConfirmation({
        kind: 'control',
        scopes: ['pools:read', 'events:read'],
      }),
    ).toBe(false);
    expect(controlPreviewNeedsRiskConfirmation({ kind: 'control', scopes: ['pools:write'] })).toBe(
      true,
    );
  });

  it('keeps the capability language explicit', () => {
    expect(controlScopePresentation('pools:write')).toMatchObject({
      label: '管理任务',
      risk: 'high',
    });
    expect(controlScopePresentation('pools:read').risk).toBe('standard');
  });

  it('formats the server-requested credential lifetime', () => {
    expect(formatCredentialTtl(3_600)).toBe('1 小时');
    expect(formatCredentialTtl(30 * 86_400)).toBe('30 天');
    expect(formatCredentialTtl(5_400)).toBe('2 小时');
  });
});
