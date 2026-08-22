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
import { Brand } from './Brand';

const NAV = [
  { to: '/app', label: '控制台', icon: Gauge, end: true },
  { to: '/app/pools/new', label: '发布任务', icon: Plus },
  { to: '/app/run', label: '接活', icon: RadioTower },
  { to: '/app/wallet', label: '积分', icon: WalletCards },
  { to: '/app/settings', label: '设置', icon: Settings },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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
        跳到正文
      </a>
      <header className="mobile-header">
        <Brand compact />
        <button
          ref={menuButtonRef}
          className="icon-button"
          type="button"
          aria-label={mobileOpen ? '关闭导航' : '打开导航'}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X /> : <Menu />}
        </button>
      </header>

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}
      >
        <div className="sidebar-top">
          <Brand compact />
        </div>
        <nav className="app-nav" aria-label="主要导航">
          {NAV.map(({ to, label, icon: Icon, end }) => (
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
          <button className="icon-button" type="button" aria-label="退出登录" onClick={signOut}>
            <LogOut />
          </button>
        </div>
      </aside>
      {mobileOpen ? (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main className="app-content" id="app-main">
        <Outlet />
      </main>
    </div>
  );
}
