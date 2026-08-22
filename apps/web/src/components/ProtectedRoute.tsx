import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { safeAppPath } from '../lib/navigation';
import { LoadingState } from './LoadingState';

export function ProtectedRoute({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="正在确认会话" />;
  if (!user) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname)}`}
        replace
        state={{ from: location.pathname }}
      />
    );
  }
  return children;
}

export function PublicOnlyRoute({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="正在确认会话" />;
  if (user) {
    const next =
      safeAppPath(new URLSearchParams(location.search).get('next')) ||
      safeAppPath((location.state as { from?: string } | null)?.from) ||
      '/app';
    return <Navigate to={next} replace />;
  }
  return children;
}
