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
import { InlineError } from '../components/LoadingState';
import {
  controlPreviewNeedsRiskConfirmation,
  controlScopePresentation,
  formatCredentialTtl,
  highRiskControlScopes,
} from '../lib/controlAuthorization';
import { api, ApiError } from '../lib/api';
import type { DeviceApprovalResult, DevicePreview } from '../lib/types';

type ApprovalState = 'idle' | 'approved' | 'denied';

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function DeviceApprovalPage() {
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
      setError('设备码应为 8–9 个字符');
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
        throw new ApiError('授权请求类型与当前页面不一致，请回到终端重新打开链接', 409);
      }
      if (previewRequestId.current === requestId) setPreview(result);
    } catch (requestError) {
      if (previewRequestId.current === requestId) {
        setError(requestError instanceof ApiError ? requestError.message : '无法核对设备');
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
        throw new ApiError('授权请求在确认时发生变化，请重新核对设备码', 409);
      }
      setApprovalResult(result);
      setApprovalState('approved');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '无法批准设备');
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
      setError(requestError instanceof ApiError ? requestError.message : '无法拒绝授权请求');
    } finally {
      setDenying(false);
    }
  };

  const isControl = preview?.kind === 'control' || (!preview && requestedKind === 'control');
  const backTarget = isControl ? '/app/settings' : '/app/run';
  const backLabel = isControl ? '返回账户设置' : '返回 Runner 页面';

  return (
    <main className={`device-page${isControl ? ' device-page-control' : ''}`}>
      <header>
        <Brand />
        <Link to={backTarget}>
          <ArrowLeft aria-hidden="true" /> {backLabel}
        </Link>
      </header>
      <section className={`device-card${isControl ? ' device-card-control' : ''}`}>
        {approvalState === 'approved' && approvalResult ? (
          <div className="device-approved">
            <span className="approval-ring">
              <CheckCircle2 aria-hidden="true" />
            </span>
            <h1>{approvalResult.kind === 'control' ? '控制 Agent 已连接' : '设备已连接'}</h1>
            {approvalResult.kind === 'control' ? (
              <p>{approvalResult.label} 只能做刚才列出的事。之后可以在设置里关掉。</p>
            ) : (
              <p>{approvalResult.label} 已连上。可以回到终端继续。</p>
            )}
            <Link
              className="button button-primary"
              to={approvalResult.kind === 'control' ? '/app/settings' : '/app/run'}
            >
              {approvalResult.kind === 'control' ? '管理控制 Agent' : '查看执行节点'}
            </Link>
          </div>
        ) : approvalState === 'denied' ? (
          <div className="device-approved device-denied">
            <span className="approval-ring">
              <XCircle aria-hidden="true" />
            </span>
            <h1>授权已拒绝</h1>
            <p>
              {deniedLabel ? `${deniedLabel} 未获得任何平台权限。` : '这个请求未获得任何平台权限。'}
              如果这不是你发起的，可以直接关闭页面。
            </p>
            <Link className="button button-secondary" to="/app/settings">
              返回账户设置
            </Link>
          </div>
        ) : (
          <>
            <h1>{isControl ? '让程序代你操作' : '连上这台机器'}</h1>
            <p>
              {isControl
                ? '先看它要做什么。没列出的，它做不了。'
                : '输入终端里的设备码。批准只连上这台机器，不会交出模型登录。'}
            </p>
            <form className="device-code-form" onSubmit={submitCode}>
              <label>
                <span>一次性设备码</span>
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
                  placeholder="ABCD-EFGH"
                />
              </label>
              <button
                className="button button-secondary"
                type="submit"
                disabled={!code || previewing}
              >
                {previewing ? '正在核对…' : '继续核对'}
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
                        ? 'CONTROL AGENT · 账户操作凭证'
                        : preview.operatorType === 'official'
                          ? 'OFFICIAL FLEET · 平台官方执行凭证'
                          : 'COMMUNITY RUNNER · 社区执行凭证'}
                    </small>
                    <strong>{preview.label}</strong>
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>设备码</dt>
                    <dd>{code}</dd>
                  </div>
                  {preview.kind === 'control' ? (
                    <>
                      <div>
                        <dt>凭证类型</dt>
                        <dd>账户控制</dd>
                      </div>
                      <div>
                        <dt>请求能力</dt>
                        <dd>{preview.scopes.length} 项</dd>
                      </div>
                      <div>
                        <dt>凭证有效期</dt>
                        <dd>{formatCredentialTtl(preview.requestedTtlSeconds)}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>凭证类型</dt>
                        <dd>{preview.operatorType === 'official' ? 'Official' : 'Community'}</dd>
                      </div>
                      <div>
                        <dt>客户端</dt>
                        <dd>{preview.client}</dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>设备码失效</dt>
                    <dd>{formatExpiry(preview.expiresAt)}</dd>
                  </div>
                </dl>

                {preview.kind === 'control' ? (
                  <>
                    <section className="device-capabilities" aria-labelledby="capability-title">
                      <header>
                        <span>
                          <small>REQUESTED CAPABILITIES</small>
                          <strong id="capability-title">这个 Agent 可以做什么</strong>
                        </span>
                        {highRiskScopes.length > 0 ? (
                          <em>{highRiskScopes.length} 项高风险</em>
                        ) : (
                          <em className="is-safe">只读 / 低风险</em>
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
                            ? '这不是只读授权。'
                            : '权限被限制在上方清单内。'}
                        </strong>
                        {highRiskScopes.length > 0
                          ? ' 它可以改你的账户。只批准你刚刚自己打开、并且信得过的那个。'
                          : ' 它只能做上面列出的事，拿不到模型登录。'}
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
                          我确认这是我刚刚发起的控制 Agent，并理解它可以
                          {highRiskScopes
                            .map((scope) => controlScopePresentation(scope).label)
                            .join('、')}
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
                        {denying ? '正在拒绝…' : '拒绝请求'}
                      </button>
                      <button
                        className={`button ${
                          highRiskScopes.length > 0 ? 'button-warm' : 'button-primary'
                        }`}
                        type="button"
                        disabled={approving || denying || (needsRiskConfirmation && !riskConfirmed)}
                        onClick={() => void approve()}
                      >
                        {approving ? '正在授权…' : '授权这些能力'}
                      </button>
                    </div>
                  </>
                ) : preview.operatorType === 'official' ? (
                  <>
                    <div className="device-safety device-safety-official">
                      <AlertTriangle aria-hidden="true" />
                      <p>
                        <strong>这是官方节点。</strong>
                        批准后它可以代官方账户领任务。只批准你刚刚自己打开的那个。
                      </p>
                    </div>
                    <label className="device-official-confirm">
                      <input
                        type="checkbox"
                        checked={riskConfirmed}
                        onChange={(event) => setRiskConfirmed(event.target.checked)}
                      />
                      <span>我确认终端明确显示 Official Fleet，并且设备码与上方一致</span>
                    </label>
                    <button
                      className="button button-primary button-wide"
                      type="button"
                      disabled={approving || !riskConfirmed}
                      onClick={() => void approve()}
                    >
                      {approving ? '正在连接…' : '批准官方节点'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="device-safety">
                      <ShieldCheck aria-hidden="true" />
                      <p>
                        <strong>这是普通机器。</strong>
                        批准后只连上它。要做任务，还得再运行领取命令。
                      </p>
                    </div>
                    <button
                      className="button button-primary button-wide"
                      type="button"
                      disabled={approving}
                      onClick={() => void approve()}
                    >
                      {approving ? '正在连接…' : '批准这台机器'}
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
