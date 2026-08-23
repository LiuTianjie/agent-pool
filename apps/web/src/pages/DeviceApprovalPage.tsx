import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  HardDrive,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { InlineError } from '../components/LoadingState';
import { useI18n } from '../i18n';
import {
  controlPreviewNeedsRiskConfirmation,
  controlScopePresentation,
  formatCredentialTtl,
  highRiskControlScopes,
} from '../lib/controlAuthorization';
import { api, ApiError } from '../lib/api';
import { credentialDate } from '../lib/format';
import type { DeviceApprovalResult, DevicePreview } from '../lib/types';

type ApprovalState = 'idle' | 'approved' | 'denied';

export function DeviceApprovalPage() {
  const { t, join } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialCode = searchParams.get('code') || '';
  const requestedKind: DevicePreview['kind'] =
    searchParams.get('kind') === 'control' ? 'control' : 'runner';
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [preview, setPreview] = useState<DevicePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);
  const [approvalState, setApprovalState] = useState<ApprovalState>('idle');
  const [approvalResult, setApprovalResult] = useState<DeviceApprovalResult | null>(null);
  const [deniedLabel, setDeniedLabel] = useState<string | null>(null);
  const previewRequestId = useRef(0);

  const highRiskScopes = useMemo(
    () => (preview?.kind === 'control' ? highRiskControlScopes(preview.scopes) : []),
    [preview],
  );
  const needsRiskConfirmation =
    preview?.kind === 'control'
      ? controlPreviewNeedsRiskConfirmation(preview)
      : preview?.kind === 'runner' && preview.operatorType === 'official';

  const prepare = async (candidate: string) => {
    const normalized = candidate.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
    if (normalized.length < 8 || normalized.length > 9) {
      setError(t('device.codeLength'));
      return;
    }
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;
    setCode(normalized);
    setSearchParams(
      requestedKind === 'control' ? { code: normalized, kind: 'control' } : { code: normalized },
      { replace: true },
    );
    setError(null);
    setPreview(null);
    setRiskConfirmed(false);
    setApprovalState('idle');
    setApprovalResult(null);
    setDeniedLabel(null);
    setPreviewing(true);
    try {
      const result =
        requestedKind === 'control'
          ? await api.previewControlDevice(normalized)
          : await api.previewRunnerDevice(normalized);
      if (result.kind !== requestedKind) {
        throw new ApiError(t('device.kindMismatch'), 409);
      }
      if (previewRequestId.current === requestId) setPreview(result);
    } catch (requestError) {
      if (previewRequestId.current === requestId) {
        setError(
          requestError instanceof ApiError ? requestError.message : t('device.previewFailed'),
        );
      }
    } finally {
      if (previewRequestId.current === requestId) setPreviewing(false);
    }
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    void prepare(code);
  };

  useEffect(() => {
    if (initialCode) void prepare(initialCode);
    // Only inspect the one-time code and kind present when this page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async () => {
    if (!preview || (needsRiskConfirmation && !riskConfirmed)) return;
    setApproving(true);
    setError(null);
    try {
      const result =
        preview.kind === 'control'
          ? await api.approveControlDevice(code, preview.approvalContext)
          : await api.approveRunnerDevice(code, preview);
      if (result.kind !== preview.kind) {
        throw new ApiError(t('device.changedOnApprove'), 409);
      }
      setApprovalResult(result);
      setApprovalState('approved');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('device.approveFailed'));
    } finally {
      setApproving(false);
    }
  };

  const deny = async () => {
    if (!preview || preview.kind !== 'control') return;
    setDenying(true);
    setError(null);
    try {
      const result = await api.denyControlDevice(code, preview.approvalContext);
      setDeniedLabel(result.label);
      setApprovalState('denied');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('device.denyFailed'));
    } finally {
      setDenying(false);
    }
  };

  const isControl = preview?.kind === 'control' || (!preview && requestedKind === 'control');
  const backTarget = isControl ? '/app/settings' : '/app/run';
  const backLabel = isControl ? t('device.backSettings') : t('device.backRunner');

  return (
    <main className={`device-page${isControl ? ' device-page-control' : ''}`}>
      <DocumentTitle title={t('device.title')} />
      <header>
        <Brand />
        <div className="device-header-actions">
          <LanguageSwitcher compact />
          <Link to={backTarget}>
            <ArrowLeft aria-hidden="true" /> {backLabel}
          </Link>
        </div>
      </header>
      <section className={`device-card${isControl ? ' device-card-control' : ''}`}>
        {approvalState === 'approved' && approvalResult ? (
          <div className="device-approved">
            <span className="approval-ring">
              <CheckCircle2 aria-hidden="true" />
            </span>
            <h1>
              {approvalResult.kind === 'control'
                ? t('device.approvedControl')
                : t('device.approvedRunner')}
            </h1>
            {approvalResult.kind === 'control' ? (
              <p>{t('device.approvedControlBody', { label: approvalResult.label })}</p>
            ) : (
              <p>{t('device.approvedRunnerBody', { label: approvalResult.label })}</p>
            )}
            <Link
              className="button button-primary"
              to={approvalResult.kind === 'control' ? '/app/settings' : '/app/run'}
            >
              {approvalResult.kind === 'control'
                ? t('device.manageControl')
                : t('device.viewNodes')}
            </Link>
          </div>
        ) : approvalState === 'denied' ? (
          <div className="device-approved device-denied">
            <span className="approval-ring">
              <XCircle aria-hidden="true" />
            </span>
            <h1>{t('device.deniedTitle')}</h1>
            <p>
              {deniedLabel
                ? t('device.deniedBody', { label: deniedLabel })
                : t('device.deniedBodyGeneric')}
            </p>
            <Link className="button button-secondary" to="/app/settings">
              {t('device.backSettings')}
            </Link>
          </div>
        ) : (
          <>
            <h1>{isControl ? t('device.headingControl') : t('device.headingRunner')}</h1>
            <p>{isControl ? t('device.leadControl') : t('device.leadRunner')}</p>
            <form className="device-code-form" onSubmit={submitCode}>
              <label>
                <span>{t('device.codeLabel')}</span>
                <input
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.toUpperCase());
                    previewRequestId.current += 1;
                    setPreview(null);
                    setRiskConfirmed(false);
                    setPreviewing(false);
                    setApprovalState('idle');
                  }}
                  autoCapitalize="characters"
                  autoComplete="one-time-code"
                  maxLength={24}
                  placeholder="ABCD-EFGH…"
                />
              </label>
              <button
                className="button button-secondary"
                type="submit"
                disabled={!code || previewing}
              >
                {previewing ? t('device.previewing') : t('device.continueCheck')}
              </button>
            </form>
            {error ? <InlineError message={error} /> : null}
            {preview ? (
              <div className={`device-request device-request-${preview.kind}`}>
                <div
                  className={`device-identity${
                    preview.kind === 'control'
                      ? ' device-identity-control'
                      : preview.operatorType === 'official'
                        ? ' device-identity-official'
                        : ''
                  }`}
                >
                  {preview.kind === 'control' ? (
                    <Bot aria-hidden="true" />
                  ) : (
                    <HardDrive aria-hidden="true" />
                  )}
                  <span>
                    <small>
                      {preview.kind === 'control'
                        ? t('device.identControl')
                        : preview.operatorType === 'official'
                          ? t('device.identOfficial')
                          : t('device.identCommunity')}
                    </small>
                    <strong>{preview.label}</strong>
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>{t('device.deviceCode')}</dt>
                    <dd>{code}</dd>
                  </div>
                  {preview.kind === 'control' ? (
                    <>
                      <div>
                        <dt>{t('device.credType')}</dt>
                        <dd>{t('device.credControl')}</dd>
                      </div>
                      <div>
                        <dt>{t('device.requestedCaps')}</dt>
                        <dd>{t('device.capCount', { count: preview.scopes.length })}</dd>
                      </div>
                      <div>
                        <dt>{t('device.credTtl')}</dt>
                        <dd>{formatCredentialTtl(preview.requestedTtlSeconds)}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>{t('device.credType')}</dt>
                        <dd>
                          {preview.operatorType === 'official'
                            ? t('common.official')
                            : t('common.community')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('device.client')}</dt>
                        <dd>{preview.client}</dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>{t('device.codeExpires')}</dt>
                    <dd>{credentialDate(preview.expiresAt)}</dd>
                  </div>
                </dl>

                {preview.kind === 'control' ? (
                  <>
                    <section className="device-capabilities" aria-labelledby="capability-title">
                      <header>
                        <span>
                          <small>{t('device.capsTitle')}</small>
                          <strong id="capability-title">{t('device.capsHeading')}</strong>
                        </span>
                        {highRiskScopes.length > 0 ? (
                          <em>{t('device.highRiskCount', { count: highRiskScopes.length })}</em>
                        ) : (
                          <em className="is-safe">{t('device.readOnly')}</em>
                        )}
                      </header>
                      <ul>
                        {preview.scopes.map((scope) => {
                          const presentation = controlScopePresentation(scope);
                          return (
                            <li
                              className={presentation.risk === 'high' ? 'is-high-risk' : ''}
                              key={scope}
                            >
                              {presentation.risk === 'high' ? (
                                <ShieldAlert aria-hidden="true" />
                              ) : (
                                <CheckCircle2 aria-hidden="true" />
                              )}
                              <span>
                                <strong>{presentation.label}</strong>
                                <small>{presentation.detail}</small>
                              </span>
                              <code>{scope}</code>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                    <div
                      className={`device-safety${
                        highRiskScopes.length > 0 ? ' device-safety-control-risk' : ''
                      }`}
                    >
                      {highRiskScopes.length > 0 ? (
                        <AlertTriangle aria-hidden="true" />
                      ) : (
                        <ShieldCheck aria-hidden="true" />
                      )}
                      <p>
                        <strong>
                          {highRiskScopes.length > 0
                            ? t('device.notReadOnly')
                            : t('device.limited')}
                        </strong>
                        {highRiskScopes.length > 0
                          ? ` ${t('device.notReadOnlyDetail')}`
                          : ` ${t('device.limitedDetail')}`}
                      </p>
                    </div>
                    {highRiskScopes.length > 0 ? (
                      <label className="device-official-confirm device-control-confirm">
                        <input
                          type="checkbox"
                          checked={riskConfirmed}
                          onChange={(event) => setRiskConfirmed(event.target.checked)}
                        />
                        <span>
                          {t('device.confirmControl', {
                            actions: join(
                              highRiskScopes.map((scope) => controlScopePresentation(scope).label),
                            ),
                          })}
                        </span>
                      </label>
                    ) : null}
                    <div className="device-decision-actions">
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={approving || denying}
                        onClick={() => void deny()}
                      >
                        {denying ? t('device.denying') : t('device.deny')}
                      </button>
                      <button
                        className={`button ${
                          highRiskScopes.length > 0 ? 'button-warm' : 'button-primary'
                        }`}
                        type="button"
                        disabled={approving || denying || (needsRiskConfirmation && !riskConfirmed)}
                        onClick={() => void approve()}
                      >
                        {approving ? t('device.authorizing') : t('device.authorize')}
                      </button>
                    </div>
                  </>
                ) : preview.operatorType === 'official' ? (
                  <>
                    <div className="device-safety device-safety-official">
                      <AlertTriangle aria-hidden="true" />
                      <p>
                        <strong>{t('device.officialWarn')}</strong> {t('device.officialWarnDetail')}
                      </p>
                    </div>
                    <label className="device-official-confirm">
                      <input
                        type="checkbox"
                        checked={riskConfirmed}
                        onChange={(event) => setRiskConfirmed(event.target.checked)}
                      />
                      <span>{t('device.confirmOfficial')}</span>
                    </label>
                    <button
                      className="button button-primary button-wide"
                      type="button"
                      disabled={approving || !riskConfirmed}
                      onClick={() => void approve()}
                    >
                      {approving ? t('device.connecting') : t('device.approveOfficial')}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="device-safety">
                      <ShieldCheck aria-hidden="true" />
                      <p>
                        <strong>{t('device.communityWarn')}</strong>{' '}
                        {t('device.communityWarnDetail')}
                      </p>
                    </div>
                    <button
                      className="button button-primary button-wide"
                      type="button"
                      disabled={approving}
                      onClick={() => void approve()}
                    >
                      {approving ? t('device.connecting') : t('device.approveMachine')}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
