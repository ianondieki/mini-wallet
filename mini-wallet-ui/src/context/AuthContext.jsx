import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api, { setAccessToken, setAuthFailureHandler } from '../lib/axios.js';

const AuthContext = createContext(null);

/**
 * Provides auth state to the app. The access token is held in React state
 * (memory); the refresh token is an httpOnly cookie. On mount we attempt a
 * silent refresh so a returning user with a valid cookie stays logged in.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [isRestoring, setIsRestoring] = useState(true);

  const applySession = useCallback((nextUser, nextToken) => {
    setUser(nextUser);
    setToken(nextToken);
    setAccessToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    setAccessToken(null);
  }, []);

  // Restore session on first load.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await api.post('/api/auth/refresh');
        if (active) applySession(data.data.user, data.data.accessToken);
      } catch {
        if (active) clearSession();
      } finally {
        if (active) setIsRestoring(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [applySession, clearSession]);

  // When the axios layer exhausts a refresh, drop the session.
  useEffect(() => {
    setAuthFailureHandler(() => clearSession());
    return () => setAuthFailureHandler(null);
  }, [clearSession]);

  const login = useCallback(
    async ({ email, password }) => {
      const { data } = await api.post('/api/auth/login', { email, password });
      applySession(data.data.user, data.data.accessToken);
      return data.data.user;
    },
    [applySession]
  );

  const register = useCallback(
    async (payload) => {
      const { data } = await api.post('/api/auth/register', payload);
      applySession(data.data.user, data.data.accessToken);
      return data.data.user;
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* ignore — clear locally regardless */
    }
    clearSession();
  }, [clearSession]);

  const value = {
    user,
    token,
    isRestoring,
    isAuthenticated: Boolean(token && user),
    login,
    register,
    logout,
    setUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access auth state. Throws if used outside the provider. */
export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}

export default AuthContext;
