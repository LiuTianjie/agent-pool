import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LoadingState } from './LoadingState';

export function ProtectedRoute({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="正在确认会话" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function PublicOnlyRoute({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingState label="正在确认会话" />;
  if (user) return <Navigate to="/app" replace />;
  return children;
}
