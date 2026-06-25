import { useMutation } from '@tanstack/react-query';
import { useAuthContext } from '../context/AuthContext.jsx';
import { queryClient } from '../lib/queryClient.js';

/**
 * Auth hook. Exposes the context plus React Query mutations for login,
 * register and logout so components get pending/error state for free.
 */
export function useAuth() {
  const ctx = useAuthContext();

  const loginMutation = useMutation({
    mutationFn: ctx.login,
  });

  const registerMutation = useMutation({
    mutationFn: ctx.register,
  });

  const logoutMutation = useMutation({
    mutationFn: ctx.logout,
    onSuccess: () => queryClient.clear(),
  });

  return {
    user: ctx.user,
    isAuthenticated: ctx.isAuthenticated,
    isRestoring: ctx.isRestoring,
    setUser: ctx.setUser,
    login: loginMutation.mutateAsync,
    register: registerMutation.mutateAsync,
    logout: logoutMutation.mutateAsync,
    loginMutation,
    registerMutation,
    logoutMutation,
  };
}

export default useAuth;
