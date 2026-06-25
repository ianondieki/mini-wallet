import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import { queryClient } from './lib/queryClient.js';
import { AuthProvider } from './context/AuthContext.jsx';
import { useAuth } from './hooks/useAuth.js';
import AppShell from './components/layout/AppShell.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TopUp from './pages/TopUp.jsx';
import Withdraw from './pages/Withdraw.jsx';
import Send from './pages/Send.jsx';
import Transactions from './pages/Transactions.jsx';
import Settings from './pages/Settings.jsx';

/** Full-screen loader shown while the session is being restored. */
function SessionLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <Loader2 className="h-7 w-7 animate-spin text-primary" />
    </div>
  );
}

/** Gate that requires authentication; preserves intended destination. */
function RequireAuth({ children }) {
  const { isAuthenticated, isRestoring } = useAuth();
  const location = useLocation();
  if (isRestoring) return <SessionLoader />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

/** Public-only gate: sends authenticated users to the dashboard. */
function PublicOnly({ children }) {
  const { isAuthenticated, isRestoring } = useAuth();
  if (isRestoring) return <SessionLoader />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/send" element={<Send />} />
        <Route path="/topup" element={<TopUp />} />
        <Route path="/withdraw" element={<Withdraw />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'rgba(22,22,31,0.9)',
                color: '#f1f5f9',
                border: '1px solid #1e1e2e',
                backdropFilter: 'blur(12px)',
              },
              success: { iconTheme: { primary: '#f5a623', secondary: '#0a0a0f' } },
              error: { iconTheme: { primary: '#ef4444', secondary: '#0a0a0f' } },
            }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
