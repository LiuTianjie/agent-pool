import {
  ArrowRight,
  Blocks,
  CheckCircle2,
  EyeOff,
  LockKeyhole,
  RadioTower,
  WalletCards,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { formatInteger } from '../lib/format';
import type { NetworkPulse } from '../lib/types';

export function LandingPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [pulse, setPulse] = useState<NetworkPulse | null>(null);
  const publishHref = user ? '/app/pools/new' : '/register?next=/app/pools/new';
  const runHref = user ? '/app/run' : '/register?next=/app/run';

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.networkPulse();
        if (alive) setPulse(next);
      } catch {
        if (alive) setPulse(null);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="landing">
      <DocumentTitle title="Agent Pool" />
      <a className="skip-link" href="#main">
        {t('common.skipToContent')}
      </a>
      <header className="landing-nav">
        <Brand />
        <div className="landing-nav-actions">
          <Link className="text-link" to={publishHref}>
            {t('landing.publish')}
          </Link>
          <Link className="text-link" to={runHref}>
            {t('landing.run')}
          </Link>
          <LanguageSwitcher />
          {user ? (
            <Link className="text-link landing-nav-login" to="/app">
              {t('landing.console')}
            </Link>
          ) : (
            <Link className="text-link landing-nav-login" to="/login">
              {t('landing.login')}
            </Link>
          )}
        </div>
      </header>

      <main id="main">
        <section className="hero section-wrap">
          <div className="hero-copy reveal">
            <h1>
              <span>{t('landing.heroTitle1')}</span>
              <span className="hero-title-accent">{t('landing.heroTitle2')}</span>
            </h1>
            <p>{t('landing.heroBody')}</p>
            <div className="hero-actions">
              <Link className="button button-primary" to={publishHref}>
                {t('landing.ctaPublish')} <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to={runHref}>
                {t('landing.ctaRun')}
              </Link>
            </div>
            <div className="hero-trust">
              <span>
                <CheckCircle2 aria-hidden="true" /> {t('landing.trustData')}
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> {t('landing.trustContract')}
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> {t('landing.trustHuman')}
              </span>
            </div>
          </div>

          <div className="pool-signal reveal reveal-delay">
            <div className="signal-header">
              <div>
                <strong>{t('landing.pulseNow')}</strong>
              </div>
              <span className="signal-live">
                <span />
                {t('landing.pulsePublic')}
              </span>
            </div>
            <div className="signal-meter">
              <div>
                <span>{t('landing.pulseOnline')}</span>
                <strong>{pulse ? formatInteger(pulse.onlineNodes) : '—'}</strong>
              </div>
              <div>
                <span>{t('landing.pulseQueued')}</span>
                <strong>{pulse ? formatInteger(pulse.queuedUnits) : '—'}</strong>
              </div>
              <div>
                <span>{t('landing.pulseToday')}</span>
                <strong>{pulse ? formatInteger(pulse.completedToday) : '—'}</strong>
              </div>
            </div>
            <div className="signal-footer">
              <span>{t('landing.pulseFooter')}</span>
              <Blocks aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="mechanism section-wrap" aria-labelledby="mechanism-title">
          <div className="section-heading">
            <h2 id="mechanism-title">{t('landing.mechanismTitle')}</h2>
          </div>
          <div className="mechanism-track">
            <article>
              <span className="step-number">01</span>
              <Blocks aria-hidden="true" />
              <h3>{t('landing.step1Title')}</h3>
              <p>{t('landing.step1Body')}</p>
            </article>
            <article>
              <span className="step-number">02</span>
              <RadioTower aria-hidden="true" />
              <h3>{t('landing.step2Title')}</h3>
              <p>{t('landing.step2Body')}</p>
            </article>
            <article>
              <span className="step-number">03</span>
              <WalletCards aria-hidden="true" />
              <h3>{t('landing.step3Title')}</h3>
              <p>{t('landing.step3Body')}</p>
            </article>
          </div>
        </section>

        <section className="sealed-section section-wrap" id="runner">
          <div className="sealed-visual" aria-hidden="true">
            <div className="sealed-rail">
              <span className="sealed-line" />
              <EyeOff />
            </div>
            <div className="sealed-thread">
              <LockKeyhole />
            </div>
            <div className="sealed-rail">
              <EyeOff />
              <span className="sealed-line" />
            </div>
          </div>
          <div className="sealed-copy">
            <h2>
              <span>{t('landing.sealedTitle1')}</span>
              <span>{t('landing.sealedTitle2')}</span>
            </h2>
            <p>{t('landing.sealedBody')}</p>
            <div className="terminal-command">
              <span>$</span>
              <code>agentpool claim --claim &lt;claim-id&gt;</code>
              <span className="terminal-cursor" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="final-cta section-wrap">
          <h2>
            {t('landing.ctaTitle1')}
            <br />
            {t('landing.ctaTitle2')}
          </h2>
          <div>
            <div className="hero-actions">
              <Link className="button button-primary" to={publishHref}>
                {t('landing.ctaPublishPilot')} <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to={runHref}>
                {t('landing.ctaSeeCommands')}
              </Link>
            </div>
            <span>{t('landing.ctaNote')}</span>
          </div>
        </section>
      </main>

      <footer className="landing-footer section-wrap">
        <Brand />
        <nav className="landing-account-links" aria-label={t('landing.footerAccount')}>
          {user ? (
            <Link to="/app">{t('landing.footerConsole')}</Link>
          ) : (
            <Link to="/login">{t('landing.footerHasAccount')}</Link>
          )}
        </nav>
        <nav className="landing-agent-links" aria-label={t('landing.footerAgent')}>
          <a href="/llms.txt">llms.txt</a>
          <a href="/.well-known/agent-skills/index.json">Skills</a>
          <a href="/api/meta/capabilities">capabilities</a>
        </nav>
      </footer>
    </div>
  );
}
