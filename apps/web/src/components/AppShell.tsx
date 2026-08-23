import {
  CircleUserRound,
  Gauge,
  LogOut,
  Menu,
  Plus,
  RadioTower,
  Settings,
  WalletCards,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import { Brand } from './Brand';
import { LanguageSwitcher } from './LanguageSwitcher';

export function AppShell() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const nav = [
    { to: '/app', label: t('nav.console'), icon: Gauge, end: true },
    { to: '/app/pools/new', label: t('nav.publish'), icon: Plus },
    { to: '/app/run', label: t('nav.run'), icon: RadioTower },
    { to: '/app/wallet', label: t('nav.wallet'), icon: WalletCards },
    { to: '/app/settings', label: t('nav.settings'), icon: Settings },
  ];

  const signOut = async () => {
    await logout();
    navigate('/');
  };

  useEffect(() => {
    if (!mobileOpen) return;

    const focusables = (): HTMLElement[] => {
      const sidebar = sidebarRef.current;
      if (!sidebar) return [];
      return [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    };

    const items = focusables();
    items[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#app-main">
        {t('common.skipToContent')}
      </a>
      <header className="mobile-header">
        <Brand compact />
        <div className="mobile-header-actions">
          <LanguageSwitcher compact />
          <button
            ref={menuButtonRef}
            className="icon-button"
            type="button"
            aria-label={mobileOpen ? t('nav.close') : t('nav.open')}
            aria-expanded={mobileOpen}
            aria-controls="app-sidebar"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}
      >
        <div className="sidebar-top">
          <Brand compact />
          <LanguageSwitcher />
        </div>
        <nav className="app-nav" aria-label={t('nav.primary')}>
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => (isActive ? 'nav-item nav-item-active' : 'nav-item')}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-account">
          <CircleUserRound aria-hidden="true" />
          <div>
            <strong>{user?.displayName}</strong>
            <span>{user?.email}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={t('nav.signOut')}
            onClick={signOut}
          >
            <LogOut />
          </button>
        </div>
      </aside>
      {mobileOpen ? (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label={t('nav.close')}
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main className="app-content" id="app-main">
        <Outlet />
      </main>
    </div>
  );
}
