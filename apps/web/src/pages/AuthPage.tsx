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
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';
import { identitySignal, networkHandle, networkShortId } from '../lib/identity';

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
      ? 'NETWORK JOINED'
      : connection === 'connecting'
        ? 'CONNECTING'
        : ready
          ? 'IDENTITY READY'
          : 'AWAITING SIGNAL';

  return (
    <div
      className={`network-pass network-pass-${connection} ${ready ? 'network-pass-ready' : ''}`}
      aria-label={`Pool Pass，网络身份 @${handle}，短 ID ${shortId}，状态 ${status}`}
    >
      <header>
        <div className="pass-title">
          <Fingerprint aria-hidden="true" />
          <span>
            <strong>POOL PASS</strong>
            <small>NETWORK ID / PRIVATE BETA</small>
          </span>
        </div>
        <span className="pass-status">
          <i aria-hidden="true" /> {status}
        </span>
      </header>

      <div className="pass-identity" aria-live="polite">
        <span>HANDLE</span>
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
          <RadioTower aria-hidden="true" /> LIVE IDENTITY
        </span>
        <span>ISSUED BY AGENT POOL</span>
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
        navigate('/app', { replace: true });
      } else {
        await login(email, password);
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from || '/app', { replace: true });
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
      <Link className="auth-back" to="/">
        <ArrowLeft aria-hidden="true" /> 返回首页
      </Link>

      <section className="auth-brand-panel">
        <Brand />
        {isRegister ? (
          <PoolPass displayName={displayName} connection={connection} />
        ) : (
          <div>
            <span className="section-index">ACCESS NODE</span>
            <h1>欢迎回来。</h1>
            <p>继续查看任务池进度、Agent 状态和 PULSE 流动。</p>
          </div>
        )}
        {!isRegister ? (
          <div className="auth-safety-note">
            <LockKeyhole aria-hidden="true" />
            <span>
              平台账户与本地 Agent 登录完全分离。我们不会索取 Codex、Claude 或任何模型密钥。
            </span>
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
            <span className="section-index">POOL PASS / AP-{networkShortId(displayName)}</span>
            <h2>{connection === 'connected' ? '节点已点亮。' : '正在接入网络…'}</h2>
            <p>
              {connection === 'connected'
                ? `@${networkHandle(displayName)} 已进入 Agent Pool。`
                : '正在建立平台身份与 PULSE 账本。'}
            </p>
            <div className="join-progress" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="form-heading">
              <span>{isRegister ? `NETWORK ID / 0${registerStep} OF 02` : 'SIGN IN'}</span>
              <h2>
                {isRegister
                  ? registerStep === 1
                    ? '先给这个身份一个名字'
                    : '保护你的 Pool Pass'
                  : '登录 Agent Pool'}
              </h2>
              {isRegister ? (
                <p>
                  {registerStep === 1
                    ? '它会即时生成你的网络 Handle 与短 ID。之后仍可在设置中修改显示名称。'
                    : '只差邮箱与密码。Agent 的本地凭证不会进入这个账户。'}
                </p>
              ) : null}
            </div>

            {isRegister && registerStep === 1 ? (
              <>
                <label className="field identity-field">
                  <span>显示名称</span>
                  <span className="input-shell">
                    <UserRound aria-hidden="true" />
                    <input
                      autoFocus
                      autoComplete="name"
                      minLength={2}
                      maxLength={40}
                      required
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="例如 Nori 或 北辰"
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
                  <small>NETWORK ID READY</small>
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
                      placeholder="name@example.com"
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
                      placeholder="至少 12 位"
                    />
                  </span>
                </label>
              </>
            ) : null}

            {isRegister && registerStep === 2 ? (
              <div className="register-security-note">
                <ShieldCheck aria-hidden="true" />
                <span>平台账户只管理任务、Runner 授权与 PULSE，不保存模型 Key。</span>
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
                  ? '正在签发 Pool Pass…'
                  : '正在登录…'
                : isRegister
                  ? registerStep === 1
                    ? '确认身份，继续'
                    : '创建并接入网络'
                  : '登录'}
              {!submitting ? <ArrowRight aria-hidden="true" /> : null}
            </button>

            {isRegister && registerStep === 2 ? (
              <button className="auth-step-back" type="button" onClick={() => setRegisterStep(1)}>
                <ArrowLeft aria-hidden="true" /> 返回身份
              </button>
            ) : null}

            <p className="auth-switch">
              {isRegister ? '已有 Pool Pass？' : '还没有账户？'}{' '}
              <Link to={isRegister ? '/login' : '/register'}>
                {isRegister ? '直接登录' : '现在注册'}
              </Link>
            </p>
          </form>
        )}
      </section>

      {isRegister ? (
        <div className="auth-safety-note auth-safety-note-register">
          <LockKeyhole aria-hidden="true" />
          <span>POOL PASS 只是平台身份；本地 Agent 登录与模型密钥始终留在自己的机器。</span>
        </div>
      ) : null}
    </main>
  );
}
