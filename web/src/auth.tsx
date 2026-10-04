import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, post, setCsrfToken, setUnauthenticatedHandler } from './api/client';
import type { Me, Role } from './api/types';

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

interface AuthState {
  me: Me['user'] | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (role: Role) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me['user'] | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const clear = useCallback(() => {
    setCsrfToken(null);
    setMe(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthenticatedHandler(clear);
    get<Me>('/api/auth/me')
      .then((r) => {
        setCsrfToken(r.csrfToken);
        setMe(r.user);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
    return () => setUnauthenticatedHandler(null);
  }, [clear]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      async login(username, password) {
        const r = await post<Me>('/api/auth/login', { username, password });
        setCsrfToken(r.csrfToken);
        setMe(r.user);
      },
      async logout() {
        try {
          await post('/api/auth/logout');
        } finally {
          clear();
        }
      },
      can: (role) => !!me && RANK[me.role] >= RANK[role],
    }),
    [me, loading, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
