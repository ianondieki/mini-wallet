import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from './test-utils.jsx';
import TransactionDetail from '../components/transactions/TransactionDetail.jsx';

const received = {
  id: 'txn_received',
  type: 'transfer',
  flow: 'transfer',
  status: 'success',
  amount: 500,
  direction: 'credit',
  description: 'Order 91',
  sender: { name: 'Grace Hopper', email: 'grace@example.com' },
  receiver: { name: 'Ada Lovelace', email: 'ada@example.com' },
  createdAt: new Date().toISOString(),
};

describe('Refunds', () => {
  it('offers a refund on a payment this customer received', async () => {
    renderWithProviders(<TransactionDetail transaction={received} />, { authed: true });
    expect(
      await screen.findByRole('button', { name: /refund KES 500\.00/i })
    ).toBeInTheDocument();
  });

  it('does not offer one on a payment this customer sent', async () => {
    const sent = { ...received, direction: 'debit' };
    renderWithProviders(<TransactionDetail transaction={sent} />, { authed: true });
    await screen.findByText('Order 91');
    // Only the payee can refund, so the sender is never shown the button.
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
  });

  it('does not offer one on a top-up or a withdrawal', async () => {
    const topup = { ...received, type: 'topup', flow: 'deposit' };
    renderWithProviders(<TransactionDetail transaction={topup} />, { authed: true });
    await screen.findByText('Order 91');
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
  });

  it('refunds everything outstanding when no amount is given', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionDetail transaction={received} />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /refund KES 500\.00/i }));
    await user.type(screen.getByLabelText(/reason/i), 'out of stock');
    await user.click(screen.getByRole('button', { name: /^refund$/i }));

    expect(await screen.findByText(/KES 500\.00 returned/i)).toBeInTheDocument();
  });

  it('refuses an amount larger than what was received', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionDetail transaction={received} />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /refund KES 500\.00/i }));
    await user.type(await screen.findByLabelText(/amount — up to/i), '900');

    expect(await screen.findByText(/enter an amount up to KES 500\.00/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^refund$/i })).toBeDisabled();
  });

  it('says so when a payment has already been given back in full', async () => {
    const spent = { ...received, id: 'txn_spent' };
    renderWithProviders(<TransactionDetail transaction={spent} />, { authed: true });

    expect(
      await screen.findByText(/you have given all KES 500\.00 of this back/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
  });
});
