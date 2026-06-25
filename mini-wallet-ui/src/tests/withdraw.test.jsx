import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import Withdraw from '../pages/Withdraw.jsx';

describe('Withdraw', () => {
  it('blocks a withdrawal that exceeds the balance', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Withdraw />, { authed: true });

    // Wait for the balance (12,500) to load so the guard has real data.
    await screen.findAllByText(/12,500/);

    const amount = screen.getByRole("textbox", { name: /withdrawal amount/i });
    await user.type(amount, '20000');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds your balance/i);
    // Still on step 1 — the Continue button is present, Confirm is not.
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
  });

  it('completes a valid withdrawal and shows the initiated state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Withdraw />, { authed: true });

    await screen.findAllByText(/12,500/);

    const amount = screen.getByRole("textbox", { name: /withdrawal amount/i });
    await user.type(amount, '1000');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    const confirm = await screen.findByRole('button', { name: /confirm withdrawal/i });
    await user.click(confirm);

    await waitFor(async () =>
      expect((await screen.findAllByText(/withdrawal initiated/i)).length).toBeGreaterThan(0)
    );
  });
});
