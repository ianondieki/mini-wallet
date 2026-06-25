import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../context/AuthContext.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { server } from '../mocks/server.js';
import { MOCK_USER } from '../mocks/handlers.js';

const API = 'http://localhost:3000';

/** Make the mount-time silent refresh succeed, so the session is restored. */
export function authenticate(user = MOCK_USER) {
  server.use(
    http.post(`${API}/api/auth/refresh`, () =>
      HttpResponse.json({
        success: true,
        data: { user, accessToken: 'mock-access-token' },
      })
    )
  );
}

function freshClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Holds rendering until the auth session has finished restoring. */
function AuthGate({ children }) {
  const { isRestoring } = useAuth();
  if (isRestoring) return null;
  return children;
}

/**
 * Render a component tree wrapped in the app's providers.
 * @param {React.ReactNode} ui
 * @param {{route?:string, authed?:boolean}} [opts]
 */
export function renderWithProviders(ui, { route = '/', authed = false } = {}) {
  if (authed) authenticate();
  const client = freshClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <AuthGate>{ui}</AuthGate>
          <Toaster />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export * from '@testing-library/react';
