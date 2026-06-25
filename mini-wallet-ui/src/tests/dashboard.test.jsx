import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import { server } from '../mocks/server.js';
import Dashboard from '../pages/Dashboard.jsx';

const API = 'http://localhost:3000';

const ok = (data) => HttpResponse.json({ success: true, data });

describe('Dashboard', () => {
  it('renders the balance card with the fetched amount', async () => {
    renderWithProviders(<Dashboard />, { authed: true });
    // Animated number settles on the mocked balance (12,500.00) after ~1s.
    await waitFor(() => expect(screen.getByText(/12,500\.00/)).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(screen.getByText(/total balance/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton while the balance is fetching', async () => {
    server.use(
      http.get(`${API}/api/wallet/balance`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return ok({ balance: 12500, currency: 'KES' });
      })
    );
    const { container } = renderWithProviders(<Dashboard />, { authed: true });
    await waitFor(() => expect(container.querySelector('.skeleton')).toBeInTheDocument());
  });

  it('shows KES 0.00 when the balance is zero', async () => {
    server.use(http.get(`${API}/api/wallet/balance`, () => ok({ balance: 0, currency: 'KES' })));
    renderWithProviders(<Dashboard />, { authed: true });
    await waitFor(() => expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0));
  });

  it('renders recent transactions from mock data', async () => {
    renderWithProviders(<Dashboard />, { authed: true });
    expect(await screen.findByText(/recent transactions/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/wallet top-up/i).length).toBeGreaterThan(0));
  });

  it('shows an empty state when there are no transactions', async () => {
    server.use(
      http.get(`${API}/api/wallet/transactions`, () =>
        ok({ transactions: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } })
      )
    );
    renderWithProviders(<Dashboard />, { authed: true });
    expect(await screen.findByText(/no transactions yet/i)).toBeInTheDocument();
  });

  it('shows quick stats computed from transactions', async () => {
    renderWithProviders(<Dashboard />, { authed: true });
    expect(await screen.findByText(/sent this month/i)).toBeInTheDocument();
    expect(screen.getByText(/received this month/i)).toBeInTheDocument();
    expect(screen.getByText(/total transactions/i)).toBeInTheDocument();
  });
});
