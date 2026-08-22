import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Check,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Mail,
  RadioTower,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';
import { identitySignal, networkHandle, networkShortId } from '../lib/identity';
import { safeAppPath } from '../lib/navigation';

type RegisterStep = 1 | 2;
type ConnectionState = 'idle' | 'connecting' | 'connected';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function PoolPass({
  displayName,
  connection,
}: {
  displayName: string;
  connection: ConnectionState;
}) {
  const handle = networkHandle(displayName);
  const shortId = networkShortId(displayName);
  const signal = useMemo(() => identitySignal(displayName), [displayName]);
  const ready = displayName.trim().length >= 2;
  const status =
    connection === 'connected'
      ? '已入网'
      : connection === 'connecting'
        ? '正在连接'
        : ready
          ? '身份已备好'
          : '等待输入';

  return (
    <div
      className={`network-pass network-pass-${connection} ${ready ? 'network-pass-ready' : ''}`}
      aria-label={`入网证，网络身份 @${handle}，短 ID ${shortId}，状态 ${status}`}
    >
      <header>
        <div className="pass-title">
          <Fingerprint aria-hidden="true" />
          <span>
            <strong>入网证</strong>
            <small>网络身份 / 内测</small>
          </span>
        </div>
        <span className="pass-status">
          <i aria-hidden="true" /> {status}
        </span>
      </header>

      <div className="pass-identity" aria-live="polite">
        <span>代号</span>
        <strong>@{handle}</strong>
        <small>AP-{shortId}</small>
      </div>

      <div className="pass-signal" aria-hidden="true">
        {signal.map((active, index) => (
          <i key={index} className={active && ready ? 'active' : ''} />
        ))}
      </div>

      <footer>
        <span>
          <RadioTower aria-hidden="true" /> 现场身份
        </span>
        <span>由 Agent Pool 签发</span>
        <strong>{shortId}</strong>
      </footer>
      <span className="pass-corner" aria-hidden="true" />
    </div>
  );
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  const navigate = useNavigate();
  const location = useLocation();
  const reducedMotion = useReducedMotion();
  const { login, register, setUser } = useAuth();
  const [registerStep, setRegisterStep] = useState<RegisterStep>(1);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextPath =
    safeAppPath(new URLSearchParams(location.search).get('next')) ||
    safeAppPath((location.state as { from?: string } | null)?.from) ||
    '/app';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (isRegister && registerStep === 1) {
      if (displayName.trim().length < 2) {
        setError('显示名称至少需要 2 个字符');
        return;
      }
      setRegisterStep(2);
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) {
        const user = await register(displayName.trim(), email, password);
        setSubmitting(false);
        setConnection('connecting');
        await wait(reducedMotion ? 20 : 850);
        setConnection('connected');
        await wait(reducedMotion ? 20 : 220);
        setUser(user);
        navigate(nextPath, { replace: true });
      } else {
        await login(email, password);
        navigate(nextPath, { replace: true });
      }
    } catch (requestError) {
      setConnection('idle');
      setError(requestError instanceof ApiError ? requestError.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={isRegister ? 'auth-page auth-page-register' : 'auth-page'}>
      <DocumentTitle title={isRegister ? '注册' : '登录'} />
      <Link className="auth-back" to="/">
        <ArrowLeft aria-hidden="true" /> 返回首页
      </Link>

      <section className="auth-brand-panel">
        <Brand />
        {isRegister ? (
          <>
            <div>
              <span className="section-index">注册</span>
              <h1>创建账户。</h1>
              <p>这个账户不管你的模型密钥。</p>
            </div>
            <PoolPass displayName={displayName} connection={connection} />
          </>
        ) : (
          <div>
            <span className="section-index">登录</span>
            <h1>欢迎回来。</h1>
            <p>继续看任务和积分。</p>
          </div>
        )}
        {!isRegister ? (
          <div className="auth-safety-note">
            <LockKeyhole aria-hidden="true" />
            <span>登录这个网站，拿不到你的 Codex 或 Claude 密钥。</span>
          </div>
        ) : null}
      </section>

      <section className="auth-form-panel">
        {connection !== 'idle' ? (
          <div
            className={`network-join network-join-${connection}`}
            role="status"
            aria-live="polite"
          >
            <div className="join-nodes" aria-hidden="true">
              {Array.from({ length: 12 }, (_, index) => (
                <i key={index} style={{ '--join-index': index } as CSSProperties} />
              ))}
              <span>
                {connection === 'connected' ? (
                  <Check aria-hidden="true" />
                ) : (
                  <RadioTower aria-hidden="true" />
                )}
              </span>
            </div>
            <span className="section-index">@{networkHandle(displayName)}</span>
            <h2>{connection === 'connected' ? '已经进来了。' : '正在创建账户…'}</h2>
            <p>
              {connection === 'connected'
                ? `欢迎，@${networkHandle(displayName)}。`
                : '正在创建账户…'}
            </p>
            <div className="join-progress" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="form-heading">
              {isRegister ? <span>{registerStep} / 2</span> : <h2>登录账户</h2>}
            </div>

            {isRegister && registerStep === 1 ? (
              <>
                <label className="field identity-field">
                  <span>显示名称</span>
                  <span className="input-shell">
                    <UserRound aria-hidden="true" />
                    <input
                      autoComplete="name"
                      minLength={2}
                      maxLength={40}
                      required
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="例如 Nori 或 北辰…"
                      aria-describedby="identity-live-preview"
                    />
                  </span>
                </label>
                <div
                  className="identity-inline-preview"
                  id="identity-live-preview"
                  aria-live="polite"
                >
                  <span>
                    <AtSign aria-hidden="true" /> {networkHandle(displayName)}
                  </span>
                  <span>AP-{networkShortId(displayName)}</span>
                </div>
              </>
            ) : null}

            {isRegister && registerStep === 2 ? (
              <div className="identity-confirmed">
                <span className="identity-confirm-icon">
                  <CheckCircle2 aria-hidden="true" />
                </span>
                <span>
                  <small>名字已定</small>
                  <strong>@{networkHandle(displayName)}</strong>
                </span>
                <button type="button" onClick={() => setRegisterStep(1)}>
                  修改
                </button>
              </div>
            ) : null}

            {!isRegister || registerStep === 2 ? (
              <>
                <label className="field">
                  <span>邮箱</span>
                  <span className="input-shell">
                    <Mail aria-hidden="true" />
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com…"
                    />
                  </span>
                </label>
                <label className="field">
                  <span>密码</span>
                  <span className="input-shell">
                    <KeyRound aria-hidden="true" />
                    <input
                      type="password"
                      autoComplete={isRegister ? 'new-password' : 'current-password'}
                      minLength={12}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 12 位…"
                    />
                  </span>
                </label>
              </>
            ) : null}

            {isRegister && registerStep === 2 ? (
              <div className="register-security-note">
                <ShieldCheck aria-hidden="true" />
                <span>这个账户不管你的模型密钥。</span>
              </div>
            ) : null}

            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}

            <button
              className="button button-primary button-wide"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? isRegister
                  ? '正在创建…'
                  : '正在登录…'
                : isRegister
                  ? registerStep === 1
                    ? '继续'
                    : '创建账户'
                  : '登录'}
              {!submitting ? <ArrowRight aria-hidden="true" /> : null}
            </button>

            {isRegister && registerStep === 2 ? (
              <button className="auth-step-back" type="button" onClick={() => setRegisterStep(1)}>
                <ArrowLeft aria-hidden="true" /> 返回改名字
              </button>
            ) : null}

            <p className="auth-switch">
              {isRegister ? '已有账户？' : '还没有账户？'}{' '}
              <Link to={isRegister ? `/login${location.search}` : `/register${location.search}`}>
                {isRegister ? '直接登录' : '现在注册'}
              </Link>
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
