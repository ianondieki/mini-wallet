import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import { server } from '../mocks/server.js';
import Send from '../pages/Send.jsx';

const API = 'http://localhost:3000';

const selectGrace = async (user) => {
  const search = await screen.findByLabelText(/recipient/i);
  await user.type(search, 'grace');
  const result = await screen.findByText(/grace hopper/i, {}, { timeout: 2000 });
  await user.click(result);
};

describe('Send Money', () => {
  it('debounces the recipient search and shows dropdown results', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    const search = await screen.findByLabelText(/recipient/i);
    await user.type(search, 'grace');
    // Result appears only after the 400ms debounce + fetch resolve.
    expect(await screen.findByText(/grace hopper/i, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/grace@example.com/i)).toBeInTheDocument();
  });

  it('fills the chip when a recipient is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    await selectGrace(user);
    expect(screen.getByRole('button', { name: /remove recipient/i })).toBeInTheDocument();
  });

  it('prevents a self-transfer', async () => {
    server.use(
      http.get(`${API}/api/wallet/recipients`, () =>
        HttpResponse.json({
          success: true,
          data: { recipients: [{ id: 'me', name: 'Ada Lovelace', email: 'ada@example.com' }] },
        })
      )
    );
    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    const search = await screen.findByLabelText(/recipient/i);
    await user.type(search, 'ada');
    await user.click(await screen.findByText(/ada lovelace/i, {}, { timeout: 2000 }));
    expect(await screen.findByText(/cannot send money to yourself/i)).toBeInTheDocument();
  });

  it('shows a confirmation modal before submitting and cancels correctly', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    await selectGrace(user);
    await user.type(screen.getByLabelText(/^amount$/i), '500');
    await user.click(screen.getByRole('button', { name: /^send money$/i }));

    expect(await screen.findByRole('dialog', { name: /confirm transfer/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /confirm transfer/i })).not.toBeInTheDocument()
    );
  });

  it('shows an insufficient-balance error', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    await selectGrace(user);
    await user.type(screen.getByLabelText(/^amount$/i), '99999');
    expect(await screen.findByText(/insufficient balance/i)).toBeInTheDocument();
  });

  it('completes a transfer and attaches an idempotency key', async () => {
    let capturedKey = null;
    server.use(
      http.post(`${API}/api/wallet/transfer`, async ({ request }) => {
        capturedKey = request.headers.get('Idempotency-Key');
        const body = await request.json();
        return HttpResponse.json(
          {
            success: true,
            message: 'Transfer successful',
            data: { transaction: { id: 'txn_new', amount: body.amount, status: 'success' } },
          },
          { status: 201 }
        );
      })
    );

    const user = userEvent.setup();
    renderWithProviders(<Send />, { authed: true });
    await selectGrace(user);
    await user.type(screen.getByLabelText(/^amount$/i), '500');
    await user.click(screen.getByRole('button', { name: /^send money$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm transfer/i }));

    expect(await screen.findByText(/sent to grace hopper/i)).toBeInTheDocument();
    await waitFor(() => expect(capturedKey).toBeTruthy());
    expect(capturedKey).toMatch(/[0-9a-f-]{36}/i);
  });
});
