import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders, screen, waitFor, within } from './test-utils.jsx';
import { server } from '../mocks/server.js';
import Transactions from '../pages/Transactions.jsx';

const API = 'http://localhost:3000';
const ok = (data) => HttpResponse.json({ success: true, data });

describe('Transactions', () => {
  it('renders the transaction table', async () => {
    renderWithProviders(<Transactions />, { authed: true });
    const table = await screen.findByRole('table');
    expect(within(table).getByText(/receipt/i)).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByText(/wallet top-up/i).length).toBeGreaterThan(0));
  });

  it('filters by type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Transactions />, { authed: true });
    await screen.findByRole('table');
    await waitFor(() => expect(screen.getAllByText(/transfer #/i).length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: /top up/i }));
    await waitFor(() => expect(screen.queryAllByText(/transfer #/i)).toHaveLength(0));
    const table = screen.getByRole('table');
    expect(within(table).getAllByText(/wallet top-up/i).length).toBeGreaterThan(0);
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Transactions />, { authed: true });
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: /^failed$/i }));
    await waitFor(() => {
      const table = screen.getByRole('table');
      // Exactly the 4 failed records carry a Failed status badge.
      expect(within(table).getAllByText(/^failed$/i)).toHaveLength(4);
    });
  });

  it('paginates to the next page', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Transactions />, { authed: true });
    await screen.findByRole('table');

    const pageTwo = await screen.findByRole('button', { name: '2' });
    await user.click(pageTwo);
    // "Transfer #11" only exists on the second page (record index 10).
    await waitFor(() => expect(screen.getAllByText(/transfer #11/i).length).toBeGreaterThan(0));
  });

  it('colours credit amounts green and debit amounts red', async () => {
    renderWithProviders(<Transactions />, { authed: true });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByText(/wallet top-up/i).length).toBeGreaterThan(0));
    expect(table.querySelectorAll('.text-success').length).toBeGreaterThan(0);
    expect(table.querySelectorAll('.text-error').length).toBeGreaterThan(0);
  });

  it('shows an empty state when no transactions match', async () => {
    server.use(
      http.get(`${API}/api/wallet/transactions`, () =>
        ok({ transactions: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } })
      )
    );
    renderWithProviders(<Transactions />, { authed: true });
    expect(await screen.findByText(/no transactions found/i)).toBeInTheDocument();
  });

  it('exports a CSV file', async () => {
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    global.URL.createObjectURL = createUrl;
    global.URL.revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    renderWithProviders(<Transactions />, { authed: true });
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: /export csv/i }));
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });
});
