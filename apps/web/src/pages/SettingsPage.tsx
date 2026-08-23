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
import { DocumentTitle } from '../components/DocumentTitle';
import { InlineError } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import { controlScopePresentation, highRiskControlScopes } from '../lib/controlAuthorization';
import { api, ApiError } from '../lib/api';
import { credentialDate } from '../lib/format';
import type { ControlCredential } from '../lib/types';

function credentialState(credential: ControlCredential): 'active' | 'expired' | 'revoked' {
  if (credential.revokedAt) return 'revoked';
  return new Date(credential.expiresAt).getTime() <= Date.now() ? 'expired' : 'active';
}

export function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const { t } = useI18n();
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
        requestError instanceof ApiError ? requestError.message : t('settings.loadError'),
      );
    } finally {
      setCredentialsLoading(false);
    }
  }, [t]);

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
      setError(requestError instanceof ApiError ? requestError.message : t('settings.saveFailed'));
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
        requestError instanceof ApiError ? requestError.message : t('settings.revokeError'),
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
      <DocumentTitle title={t('settings.title')} />
      <PageHeader
        eyebrow={t('settings.title')}
        title={t('settings.heading')}
        description={t('settings.description')}
      />
      {error ? <InlineError message={error} /> : null}

      <div className="settings-layout">
        <form className="settings-card profile-settings-card" onSubmit={submit}>
          <div className="settings-card-head">
            <span className="settings-icon">
              <UserRound aria-hidden="true" />
            </span>
            <div>
              <h2>{t('settings.publicIdentity')}</h2>
              <p>{t('settings.publicIdentityLead')}</p>
            </div>
          </div>
          <label className="field">
            <span>{t('settings.displayName')}</span>
            <input
              value={displayName}
              minLength={2}
              maxLength={40}
              required
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('settings.email')}</span>
            <input value={user?.email || ''} disabled />
            <small>{t('settings.emailLocked')}</small>
          </label>
          <div className="settings-actions">
            <span className={saved ? 'save-confirm save-confirm-visible' : 'save-confirm'}>
              {t('settings.saved')}
            </span>
            <button
              className="button button-primary"
              type="submit"
              disabled={saving || displayName.trim() === user?.displayName}
            >
              <Save aria-hidden="true" /> {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </form>

        <section className="settings-card boundary-settings-card">
          <div className="settings-card-head">
            <span className="settings-icon settings-icon-warm">
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <h2>{t('settings.boundaryTitle')}</h2>
              <p>{t('settings.boundaryLead')}</p>
            </div>
          </div>
          <div className="credential-boundary">
            <div>
              <KeyRound aria-hidden="true" />
              <span>
                <strong>{t('settings.poolName')}</strong>
                <small>{t('settings.poolDetail')}</small>
              </span>
            </div>
            <i aria-hidden="true" />
            <div>
              <KeyRound aria-hidden="true" />
              <span>
                <strong>{t('settings.modelName')}</strong>
                <small>{t('settings.modelDetail')}</small>
              </span>
            </div>
          </div>
          <p className="settings-note">{t('settings.boundaryNote')}</p>
        </section>

        <section className="settings-card control-credentials-card">
          <div className="settings-card-head control-credentials-head">
            <span className="settings-icon settings-icon-control">
              <Bot aria-hidden="true" />
            </span>
            <div>
              <h2>{t('settings.controlTitle')}</h2>
              <p>{t('settings.controlLead')}</p>
            </div>
            <span className="credential-count">
              {t('settings.activeCount', {
                count: credentials.filter((credential) => credentialState(credential) === 'active')
                  .length,
              })}
            </span>
          </div>

          {credentialError ? (
            <InlineError message={credentialError} retry={() => void loadCredentials()} />
          ) : null}

          {credentialsLoading ? (
            <div className="credential-list-loading" role="status">
              <span aria-hidden="true" /> {t('settings.loading')}
            </div>
          ) : credentialError &&
            orderedCredentials.length === 0 ? null : orderedCredentials.length === 0 ? (
            <div className="control-credentials-empty">
              <Bot aria-hidden="true" />
              <span>
                <strong>{t('settings.emptyTitle')}</strong>
                <small>{t('settings.emptyDetail')}</small>
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
                          <small>
                            {t('settings.grantedAt', {
                              date: credentialDate(credential.createdAt),
                            })}
                          </small>
                        </span>
                        <em>
                          {state === 'active'
                            ? t('settings.stateActive')
                            : state === 'expired'
                              ? t('settings.stateExpired')
                              : t('settings.stateRevoked')}
                        </em>
                      </header>
                      <div
                        className="control-credential-scopes"
                        aria-label={t('settings.scopesAria')}
                      >
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
                            <Clock3 aria-hidden="true" /> {t('settings.expires')}
                          </dt>
                          <dd>{credentialDate(credential.expiresAt)}</dd>
                        </div>
                        <div>
                          <dt>
                            <CheckCircle2 aria-hidden="true" /> {t('settings.lastUsed')}
                          </dt>
                          <dd>{credentialDate(credential.lastUsedAt)}</dd>
                        </div>
                        {highRiskCount > 0 ? (
                          <div className="is-high-risk">
                            <dt>{t('settings.highRisk')}</dt>
                            <dd>{t('settings.highRiskCount', { count: highRiskCount })}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                    <div className="control-credential-action">
                      {state !== 'active' ? null : pendingRevokeId === credential.id ? (
                        <div
                          className="credential-revoke-confirm"
                          role="group"
                          aria-label={t('settings.confirmAria')}
                        >
                          <span>{t('settings.revokeImmediate')}</span>
                          <button
                            className="button button-quiet button-small"
                            type="button"
                            disabled={revokingId === credential.id}
                            onClick={() => setPendingRevokeId(null)}
                          >
                            <X aria-hidden="true" /> {t('settings.keep')}
                          </button>
                          <button
                            className="button button-danger-quiet button-small"
                            type="button"
                            disabled={revokingId === credential.id}
                            onClick={() => void revokeCredential(credential.id)}
                          >
                            <Trash2 aria-hidden="true" />
                            {revokingId === credential.id
                              ? t('settings.revoking')
                              : t('settings.confirmRevoke')}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="button button-danger-quiet button-small"
                          type="button"
                          onClick={() => setPendingRevokeId(credential.id)}
                        >
                          <Trash2 aria-hidden="true" /> {t('settings.revoke')}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <p className="settings-note control-credentials-note">{t('settings.controlNote')}</p>
        </section>

        <section className="settings-card danger-card">
          <div className="settings-card-head">
            <span className="settings-icon settings-icon-danger">
              <LogOut aria-hidden="true" />
            </span>
            <div>
              <h2>{t('settings.signOutTitle')}</h2>
              <p>{t('settings.signOutLead')}</p>
            </div>
          </div>
          <button
            className="button button-danger-quiet"
            type="button"
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" /> {t('settings.signOut')}
          </button>
        </section>
      </div>
    </div>
  );
}
