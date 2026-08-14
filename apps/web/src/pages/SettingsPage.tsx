import {
  Bot,
  CheckCircle2,
  Clock3,
  KeyRound,
  LogOut,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InlineError } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../context/AuthContext';
import { controlScopePresentation, highRiskControlScopes } from '../lib/controlAuthorization';
import { api, ApiError } from '../lib/api';
import type { ControlCredential } from '../lib/types';

function formatCredentialDate(value: string | null): string {
  if (!value) return '尚未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function credentialState(credential: ControlCredential): 'active' | 'expired' | 'revoked' {
  if (credential.revokedAt) return 'revoked';
  return new Date(credential.expiresAt).getTime() <= Date.now() ? 'expired' : 'active';
}

export function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<ControlCredential[]>([]);
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => setDisplayName(user?.displayName || ''), [user?.displayName]);

  const loadCredentials = useCallback(async () => {
    setCredentialsLoading(true);
    setCredentialError(null);
    try {
      setCredentials(await api.controlCredentials());
    } catch (requestError) {
      setCredentialError(
        requestError instanceof ApiError ? requestError.message : '无法读取控制 Agent 凭证',
      );
    } finally {
      setCredentialsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  const orderedCredentials = useMemo(
    () =>
      [...credentials].sort((left, right) => {
        const stateOrder = { active: 0, expired: 1, revoked: 2 } as const;
        const stateDifference =
          stateOrder[credentialState(left)] - stateOrder[credentialState(right)];
        if (stateDifference !== 0) return stateDifference;
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      }),
    [credentials],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.updateProfile({ displayName: displayName.trim() });
      setUser(result.user);
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const revokeCredential = async (credentialId: string) => {
    setRevokingId(credentialId);
    setCredentialError(null);
    try {
      await api.revokeControlCredential(credentialId);
      setCredentials((current) =>
        current.map((credential) =>
          credential.id === credentialId
            ? { ...credential, revokedAt: new Date().toISOString() }
            : credential,
        ),
      );
      setPendingRevokeId(null);
    } catch (requestError) {
      setCredentialError(
        requestError instanceof ApiError ? requestError.message : '撤销控制凭证失败',
      );
    } finally {
      setRevokingId(null);
    }
  };

  const signOut = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="ACCOUNT / BOUNDARIES"
        title="账户设置"
        description="管理平台身份与控制 Agent。模型账户和密钥仍只留在你自己的机器上。"
      />
      {error ? <InlineError message={error} /> : null}

      <div className="settings-layout">
        <form className="settings-card profile-settings-card" onSubmit={submit}>
          <div className="settings-card-head">
            <span className="settings-icon">
              <UserRound aria-hidden="true" />
            </span>
            <div>
              <h2>公开身份</h2>
              <p>显示在任务发布记录和你自己的控制台中。</p>
            </div>
          </div>
          <label className="field">
            <span>显示名称</span>
            <input
              value={displayName}
              minLength={2}
              maxLength={40}
              required
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>登录邮箱</span>
            <input value={user?.email || ''} disabled />
            <small>当前版本暂不支持修改邮箱。</small>
          </label>
          <div className="settings-actions">
            <span className={saved ? 'save-confirm save-confirm-visible' : 'save-confirm'}>
              已保存
            </span>
            <button
              className="button button-primary"
              type="submit"
              disabled={saving || displayName.trim() === user?.displayName}
            >
              <Save aria-hidden="true" /> {saving ? '保存中…' : '保存修改'}
            </button>
          </div>
        </form>

        <section className="settings-card boundary-settings-card">
          <div className="settings-card-head">
            <span className="settings-icon settings-icon-warm">
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <h2>登录边界</h2>
              <p>平台权限和模型登录严格分离。</p>
            </div>
          </div>
          <div className="credential-boundary">
            <div>
              <KeyRound aria-hidden="true" />
              <span>
                <strong>Agent Pool</strong>
                <small>网页、Runner 与控制 Agent 各自使用独立凭证</small>
              </span>
            </div>
            <i aria-hidden="true" />
            <div>
              <KeyRound aria-hidden="true" />
              <span>
                <strong>Codex / Claude</strong>
                <small>只由本地 CLI 管理，平台不读取</small>
              </span>
            </div>
          </div>
          <p className="settings-note">
            Runner 只负责执行；控制 Agent 只获得你批准的平台能力。两者都拿不到浏览器密码或模型登录。
          </p>
        </section>

        <section className="settings-card control-credentials-card">
          <div className="settings-card-head control-credentials-head">
            <span className="settings-icon settings-icon-control">
              <Bot aria-hidden="true" />
            </span>
            <div>
              <h2>控制 Agent</h2>
              <p>它们可以通过 CLI 或 API 代表你操作平台；每个凭证都能单独撤销。</p>
            </div>
            <span className="credential-count">
              {credentials.filter((credential) => credentialState(credential) === 'active').length}{' '}
              ACTIVE
            </span>
          </div>

          {credentialError ? (
            <InlineError message={credentialError} retry={() => void loadCredentials()} />
          ) : null}

          {credentialsLoading ? (
            <div className="credential-list-loading" role="status">
              <span aria-hidden="true" /> 正在读取控制凭证…
            </div>
          ) : credentialError &&
            orderedCredentials.length === 0 ? null : orderedCredentials.length === 0 ? (
            <div className="control-credentials-empty">
              <Bot aria-hidden="true" />
              <span>
                <strong>还没有控制 Agent</strong>
                <small>在终端执行控制登录后，浏览器会让你逐项确认它能调用的平台能力。</small>
              </span>
            </div>
          ) : (
            <div className="control-credential-list">
              {orderedCredentials.map((credential) => {
                const state = credentialState(credential);
                const highRiskCount = highRiskControlScopes(credential.scopes).length;
                return (
                  <article
                    className={`control-credential control-credential-${state}`}
                    key={credential.id}
                  >
                    <div className="control-credential-signal" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="control-credential-main">
                      <header>
                        <span>
                          <strong>{credential.label}</strong>
                          <small>授权于 {formatCredentialDate(credential.createdAt)}</small>
                        </span>
                        <em>
                          {state === 'active' ? '可用' : state === 'expired' ? '已过期' : '已撤销'}
                        </em>
                      </header>
                      <div className="control-credential-scopes" aria-label="已授权能力">
                        {credential.scopes.map((scope) => {
                          const presentation = controlScopePresentation(scope);
                          return (
                            <span
                              className={presentation.risk === 'high' ? 'is-high-risk' : ''}
                              key={scope}
                              title={scope}
                            >
                              {presentation.label}
                            </span>
                          );
                        })}
                      </div>
                      <dl>
                        <div>
                          <dt>
                            <Clock3 aria-hidden="true" /> 有效期至
                          </dt>
                          <dd>{formatCredentialDate(credential.expiresAt)}</dd>
                        </div>
                        <div>
                          <dt>
                            <CheckCircle2 aria-hidden="true" /> 最近使用
                          </dt>
                          <dd>{formatCredentialDate(credential.lastUsedAt)}</dd>
                        </div>
                        {highRiskCount > 0 ? (
                          <div className="is-high-risk">
                            <dt>高风险能力</dt>
                            <dd>{highRiskCount} 项</dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                    <div className="control-credential-action">
                      {state !== 'active' ? null : pendingRevokeId === credential.id ? (
                        <div
                          className="credential-revoke-confirm"
                          role="group"
                          aria-label="确认撤销"
                        >
                          <span>撤销后立即失效</span>
                          <button
                            className="button button-quiet button-small"
                            type="button"
                            disabled={revokingId === credential.id}
                            onClick={() => setPendingRevokeId(null)}
                          >
                            <X aria-hidden="true" /> 保留
                          </button>
                          <button
                            className="button button-danger-quiet button-small"
                            type="button"
                            disabled={revokingId === credential.id}
                            onClick={() => void revokeCredential(credential.id)}
                          >
                            <Trash2 aria-hidden="true" />
                            {revokingId === credential.id ? '撤销中…' : '确认撤销'}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="button button-danger-quiet button-small"
                          type="button"
                          onClick={() => setPendingRevokeId(credential.id)}
                        >
                          <Trash2 aria-hidden="true" /> 撤销
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <p className="settings-note control-credentials-note">
            控制凭证不会交给正在执行任务的 Codex / Claude 子进程。撤销只影响对应控制 Agent，不会让
            Runner 自动接单或中断其他设备。
          </p>
        </section>

        <section className="settings-card danger-card">
          <div className="settings-card-head">
            <span className="settings-icon settings-icon-danger">
              <LogOut aria-hidden="true" />
            </span>
            <div>
              <h2>结束浏览器会话</h2>
              <p>退出当前浏览器。已经授权的 Runner 或控制 Agent 不会因此自动下线。</p>
            </div>
          </div>
          <button
            className="button button-danger-quiet"
            type="button"
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" /> 退出登录
          </button>
        </section>
      </div>
    </div>
  );
}
