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
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Brand } from './Brand';

const NAV = [
  { to: '/app', label: '控制台', icon: Gauge, end: true },
  { to: '/app/pools/new', label: '发布任务池', icon: Plus },
  { to: '/app/run', label: '运行 Agent', icon: RadioTower },
  { to: '/app/wallet', label: 'PULSE 账本', icon: WalletCards },
  { to: '/app/settings', label: '设置', icon: Settings },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const signOut = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="app-frame">
      <header className="mobile-header">
        <Brand compact />
        <button
          className="icon-button"
          type="button"
          aria-label={mobileOpen ? '关闭导航' : '打开导航'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X /> : <Menu />}
        </button>
      </header>

      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
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
      <main className="app-content" key={location.pathname}>
        <Outlet />
      </main>
    </div>
  );
}
