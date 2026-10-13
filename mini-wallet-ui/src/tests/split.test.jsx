import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import Split from '../pages/Split.jsx';

/**
 * Pick someone in the composer by their email address.
 *
 * By email rather than by name on purpose: a name shown in the dropdown may
 * also be a counterparty on a request already in the list behind the modal,
 * and clicking the wrong one of those silently does nothing.
 */
const pick = async (user, email) => {
  const search = await screen.findByLabelText(/who else/i);
  await user.clear(search);
  await user.type(search, email.split('@')[0]);
  const option = await screen.findByText(email, {}, { timeout: 2000 });
  await user.click(option.closest('button'));
  // Wait for this person's own chip, not just any chip — a second pick must
  // not race past on the first one's remove button.
  await screen.findByLabelText(new RegExp(`^Remove ${email.split('@')[0]}`, 'i'));
};

/** The value shown under a label in the summary card. */
const underLabel = (label) => screen.getByText(label).parentElement;

describe('Split and money requests', () => {
  it('shows what you are owed and what you owe', async () => {
    renderWithProviders(<Split />, { authed: true });
    await screen.findByText(/dinner at mama oliech/i);
    expect(underLabel("You're owed")).toHaveTextContent('KES 750.00');
    expect(underLabel('You owe')).toHaveTextContent('KES 400.00');
  });

  it('lists an incoming request with pay and decline', async () => {
    renderWithProviders(<Split />, { authed: true });
    expect(await screen.findByText(/dinner at mama oliech/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^pay$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('pays an incoming request and drops it from the actionable list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /^pay$/i }));
    expect(await screen.findByText(/KES 400\.00 paid/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^pay$/i })).not.toBeInTheDocument()
    );
  });

  it('declines an incoming request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /decline/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /decline/i })).not.toBeInTheDocument()
    );
    // The row stays, labelled with the answer given — a declined bill is not
    // the same as one nobody ever saw.
    expect(await screen.findByText('declined')).toBeInTheDocument();
  });

  it('divides a bill between everyone at the table, the requester included', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /split a bill/i }));
    await pick(user, 'katherine@example.com');
    await user.type(screen.getByLabelText(/total bill/i), '1200');

    // Two at the table, so 600 each — and only Katherine is asked.
    expect(await screen.findByText(/KES 600\.00 each/)).toBeInTheDocument();
    expect(screen.getByText(/your own share stays yours/i)).toBeInTheDocument();
    expect(underLabel(/you're asking for/i)).toHaveTextContent('KES 600.00');
  });

  it('leaves the payer out of the maths when paying rather than asking', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /split a bill/i }));
    await user.click(screen.getByRole('button', { name: /i'm paying them/i }));
    await pick(user, 'katherine@example.com');
    await pick(user, 'alan@example.com');
    await user.type(screen.getByLabelText(/total to send/i), '1200');

    // Only the two payees share it; the sender's own wallet funds the lot.
    expect(await screen.findByText(/KES 600\.00 each/)).toBeInTheDocument();
    expect(screen.queryByText(/your own share stays yours/i)).not.toBeInTheDocument();
    expect(underLabel(/leaving your wallet/i)).toHaveTextContent('KES 1,200.00');
  });

  it('sends one person to Send rather than splitting a payment to them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /split a bill/i }));
    await user.click(screen.getByRole('button', { name: /i'm paying them/i }));
    await pick(user, 'katherine@example.com');
    await user.type(screen.getByLabelText(/total to send/i), '500');

    expect(screen.getByText(/paying one person is an ordinary transfer/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay them/i })).toBeDisabled();
  });

  it('refuses to split more than the balance when paying', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /split a bill/i }));
    await user.click(screen.getByRole('button', { name: /i'm paying them/i }));
    await pick(user, 'katherine@example.com');
    await pick(user, 'alan@example.com');
    await user.type(screen.getByLabelText(/total to send/i), '99999');

    expect(await screen.findByText(/insufficient balance/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay them/i })).toBeDisabled();
  });

  it('sends the requests and reports what was asked for', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /split a bill/i }));
    await pick(user, 'katherine@example.com');
    await user.type(screen.getByLabelText(/total bill/i), '1000');
    await user.click(screen.getByRole('button', { name: /send requests/i }));

    expect(
      await screen.findByText(/asked 1 person for KES 500\.00/i)
    ).toBeInTheDocument();
  });

  it('lets the requester withdraw their own request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Split />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /your requests/i }));
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(await screen.findByText(/request withdrawn/i)).toBeInTheDocument();
  });
});
