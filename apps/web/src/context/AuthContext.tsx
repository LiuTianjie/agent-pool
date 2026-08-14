import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../lib/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  register(displayName: string, email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  setUser(user: User): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '暂时无法连接 Agent Pool';
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.session();
      setUserState(result.user);
      setError(null);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        setUserState(null);
        setError(null);
      } else {
        setError(errorMessage(requestError));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login({ email, password });
    setUserState(result.user);
    setError(null);
  }, []);

  const register = useCallback(async (displayName: string, email: string, password: string) => {
    const result = await api.register({ displayName, email, password });
    setError(null);
    return result.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUserState(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      error,
      login,
      register,
      logout,
      refresh,
      setUser: setUserState,
    }),
    [user, loading, error, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
