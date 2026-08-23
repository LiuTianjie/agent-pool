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
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  const handle = networkHandle(displayName);
  const shortId = networkShortId(displayName);
  const signal = useMemo(() => identitySignal(displayName), [displayName]);
  const ready = displayName.trim().length >= 2;
  const status =
    connection === 'connected'
      ? t('auth.statusJoined')
      : connection === 'connecting'
        ? t('auth.statusConnecting')
        : ready
          ? t('auth.statusReady')
          : t('auth.statusWaiting');

  return (
    <div
      className={`network-pass network-pass-${connection} ${ready ? 'network-pass-ready' : ''}`}
      aria-label={t('auth.passAria', { handle, shortId, status })}
    >
      <header>
        <div className="pass-title">
          <Fingerprint aria-hidden="true" />
          <span>
            <strong>{t('auth.passTitle')}</strong>
            <small>{t('auth.passSub')}</small>
          </span>
        </div>
        <span className="pass-status">
          <i aria-hidden="true" /> {status}
        </span>
      </header>

      <div className="pass-identity" aria-live="polite">
        <span>{t('auth.passHandle')}</span>
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
          <RadioTower aria-hidden="true" /> {t('auth.passLive')}
        </span>
        <span>{t('auth.passIssued')}</span>
        <strong>{shortId}</strong>
      </footer>
      <span className="pass-corner" aria-hidden="true" />
    </div>
  );
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  const { t } = useI18n();
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
        setError(t('auth.displayNameMin'));
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
      setError(requestError instanceof ApiError ? requestError.message : t('auth.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={isRegister ? 'auth-page auth-page-register' : 'auth-page'}>
      <DocumentTitle title={isRegister ? t('auth.register') : t('auth.login')} />
      <Link className="auth-back" to="/">
        <ArrowLeft aria-hidden="true" /> {t('auth.backHome')}
      </Link>
      <div className="auth-locale">
        <LanguageSwitcher />
      </div>

      <section className="auth-brand-panel">
        <Brand />
        {isRegister ? (
          <>
            <div>
              <span className="section-index">{t('auth.register')}</span>
              <h1>{t('auth.registerTitle')}</h1>
              <p>{t('auth.registerLead')}</p>
            </div>
            <PoolPass displayName={displayName} connection={connection} />
          </>
        ) : (
          <div>
            <span className="section-index">{t('auth.login')}</span>
            <h1>{t('auth.loginTitle')}</h1>
            <p>{t('auth.loginLead')}</p>
          </div>
        )}
        {!isRegister ? (
          <div className="auth-safety-note">
            <LockKeyhole aria-hidden="true" />
            <span>{t('auth.loginSafety')}</span>
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
            <h2>{connection === 'connected' ? t('auth.joinedTitle') : t('auth.joiningTitle')}</h2>
            <p>
              {connection === 'connected'
                ? t('auth.joinedBody', { handle: networkHandle(displayName) })
                : t('auth.joiningBody')}
            </p>
            <div className="join-progress" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="form-heading">
              {isRegister ? (
                <span>{t('auth.stepOf', { current: registerStep, total: 2 })}</span>
              ) : (
                <h2>{t('auth.formLoginTitle')}</h2>
              )}
            </div>

            {isRegister && registerStep === 1 ? (
              <>
                <label className="field identity-field">
                  <span>{t('auth.displayName')}</span>
                  <span className="input-shell">
                    <UserRound aria-hidden="true" />
                    <input
                      autoComplete="name"
                      minLength={2}
                      maxLength={40}
                      required
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder={t('auth.displayPlaceholder')}
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
                  <small>{t('auth.nameLocked')}</small>
                  <strong>@{networkHandle(displayName)}</strong>
                </span>
                <button type="button" onClick={() => setRegisterStep(1)}>
                  {t('auth.edit')}
                </button>
              </div>
            ) : null}

            {!isRegister || registerStep === 2 ? (
              <>
                <label className="field">
                  <span>{t('auth.email')}</span>
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
                  <span>{t('auth.password')}</span>
                  <span className="input-shell">
                    <KeyRound aria-hidden="true" />
                    <input
                      type="password"
                      autoComplete={isRegister ? 'new-password' : 'current-password'}
                      minLength={12}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={t('auth.passwordPlaceholder')}
                    />
                  </span>
                </label>
              </>
            ) : null}

            {isRegister && registerStep === 2 ? (
              <div className="register-security-note">
                <ShieldCheck aria-hidden="true" />
                <span>{t('auth.securityNote')}</span>
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
                  ? t('auth.creating')
                  : t('auth.signingIn')
                : isRegister
                  ? registerStep === 1
                    ? t('auth.continue')
                    : t('auth.createAccount')
                  : t('auth.login')}
              {!submitting ? <ArrowRight aria-hidden="true" /> : null}
            </button>

            {isRegister && registerStep === 2 ? (
              <button className="auth-step-back" type="button" onClick={() => setRegisterStep(1)}>
                <ArrowLeft aria-hidden="true" /> {t('auth.backToName')}
              </button>
            ) : null}

            <p className="auth-switch">
              {isRegister ? t('auth.hasAccount') : t('auth.noAccount')}{' '}
              <Link to={isRegister ? `/login${location.search}` : `/register${location.search}`}>
                {isRegister ? t('auth.goLogin') : t('auth.goRegister')}
              </Link>
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
