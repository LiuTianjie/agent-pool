import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import { safeAppPath } from '../lib/navigation';
import { LoadingState } from './LoadingState';

export function ProtectedRoute({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  if (loading) return <LoadingState label={t('common.confirmingSession')} />;
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
  const { t } = useI18n();
  const location = useLocation();
  if (loading) return <LoadingState label={t('common.confirmingSession')} />;
  if (user) {
    const next =
      safeAppPath(new URLSearchParams(location.search).get('next')) ||
      safeAppPath((location.state as { from?: string } | null)?.from) ||
      '/app';
    return <Navigate to={next} replace />;
  }
  return children;
}
