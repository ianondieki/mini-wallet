import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import { server } from '../mocks/server.js';
import TopUp from '../pages/TopUp.jsx';

const API = 'http://localhost:3000';
const ok = (data) => HttpResponse.json({ success: true, data });

const advanceToConfirm = async (user, amount = '1000') => {
  const input = await screen.findByLabelText(/top-up amount/i);
  await user.clear(input);
  await user.type(input, amount);
  await user.click(screen.getByRole('button', { name: /continue/i }));
};

describe('TopUp', () => {
  it('fills the input when a quick-amount button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    await user.click(await screen.findByRole('button', { name: '500' }));
    expect(screen.getByLabelText(/top-up amount/i)).toHaveValue('500');
  });

  it('validates the minimum amount', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    const input = await screen.findByLabelText(/top-up amount/i);
    await user.type(input, '5');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/minimum top-up is KES 10/i)).toBeInTheDocument();
  });

  it('validates the maximum amount', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    const input = await screen.findByLabelText(/top-up amount/i);
    await user.type(input, '200000');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/maximum top-up is KES 150,000/i)).toBeInTheDocument();
  });

  it('pre-fills the phone number from the user context', async () => {
    renderWithProviders(<TopUp />, { authed: true });
    expect(await screen.findByLabelText(/m-pesa phone/i)).toHaveValue('254712345678');
  });

  it('transitions from step 1 to step 2 on valid input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    await advanceToConfirm(user);
    expect(await screen.findByRole('button', { name: /confirm & send stk push/i })).toBeInTheDocument();
  });

  it('shows the pending state after sending the STK push', async () => {
    server.use(http.get(`${API}/api/mpesa/status/:id`, () => ok({ status: 'pending' })));
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    await advanceToConfirm(user);
    await user.click(await screen.findByRole('button', { name: /confirm & send stk push/i }));
    expect(await screen.findByText(/check your phone/i)).toBeInTheDocument();
  });

  it('polls status and shows the success animation when confirmed', async () => {
    // Default handler returns pending then success on the 2nd poll (3s interval),
    // so reaching success proves the poll fired again.
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    await advanceToConfirm(user);
    await user.click(await screen.findByRole('button', { name: /confirm & send stk push/i }));
    expect(await screen.findByText(/top-up complete/i, {}, { timeout: 6000 })).toBeInTheDocument();
  }, 8000);

  it('shows the failure state when payment fails', async () => {
    server.use(
      http.get(`${API}/api/mpesa/status/:id`, () =>
        ok({ status: 'failed', amount: 1000, resultDesc: 'Request cancelled by user' })
      )
    );
    const user = userEvent.setup();
    renderWithProviders(<TopUp />, { authed: true });
    await advanceToConfirm(user);
    await user.click(await screen.findByRole('button', { name: /confirm & send stk push/i }));
    expect(await screen.findByText(/payment failed/i)).toBeInTheDocument();
    expect(await screen.findByText(/cancelled by user/i)).toBeInTheDocument();
  });
});
