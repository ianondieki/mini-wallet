import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor, within } from './test-utils.jsx';
import Savings from '../pages/Savings.jsx';

describe('Savings', () => {
  it('shows set-aside and spendable as two separate numbers', async () => {
    renderWithProviders(<Savings />, { authed: true });
    // The whole point of a vault: saved money is not spendable money, so the
    // screen must never collapse them into one figure.
    expect(await screen.findByText(/KES 24,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/KES 12,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/not spendable until you move it back/i)).toBeInTheDocument();
  });

  it('lists each goal with its progress against the target', async () => {
    renderWithProviders(<Savings />, { authed: true });
    expect(await screen.findByText('Rent')).toBeInTheDocument();
    expect(screen.getByText(/of KES 45,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/40\.0% there/)).toBeInTheDocument();
    expect(screen.getByText(/KES 27,000\.00 to go/)).toBeInTheDocument();
  });

  it('marks a locked goal with what breaking it costs', async () => {
    renderWithProviders(<Savings />, { authed: true });
    expect(await screen.findByText('Emergency fund')).toBeInTheDocument();
    expect(screen.getByText(/5% to break/)).toBeInTheDocument();
  });

  it('moves money into a goal and reflects the new balance', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Savings />, { authed: true });

    const rent = (await screen.findByText('Rent')).closest('div.glass');
    await user.click(within(rent).getByRole('button', { name: /add/i }));

    const amount = await screen.findByLabelText(/^amount$/i);
    await user.type(amount, '2000');
    await user.click(screen.getByRole('button', { name: /set aside/i }));

    await waitFor(() => expect(screen.getByText(/KES 20,000\.00/)).toBeInTheDocument());
  });

  it('quotes the early-exit fee before a locked goal is broken into', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Savings />, { authed: true });

    const fund = (await screen.findByText('Emergency fund')).closest('div.glass');
    await user.click(within(fund).getByRole('button', { name: /take out/i }));

    const amount = await screen.findByLabelText(/^amount$/i);
    await user.type(amount, '1000');

    // 5% of 1,000 — quoted by the server, shown before the customer commits.
    expect(await screen.findByText(/−KES 50\.00/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/KES 950\.00/)).toBeInTheDocument();
    expect(screen.getByText(/this goal is locked until/i)).toBeInTheDocument();
  });

  it('refuses to take out more than a goal holds', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Savings />, { authed: true });

    const fund = (await screen.findByText('Emergency fund')).closest('div.glass');
    await user.click(within(fund).getByRole('button', { name: /take out/i }));

    const amount = await screen.findByLabelText(/^amount$/i);
    await user.type(amount, '9999');

    expect(await screen.findByText(/more than this goal holds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /withdraw/i })).toBeDisabled();
  });

  it('creates a goal with an optional lock', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Savings />, { authed: true });

    await user.click(await screen.findByRole('button', { name: /new goal/i }));
    await user.type(await screen.findByLabelText(/what are you saving for/i), 'Laptop');
    await user.type(screen.getByLabelText(/target/i), '90000');
    await user.selectOptions(screen.getByLabelText(/lock for/i), '90');
    await user.selectOptions(screen.getByLabelText(/early-exit fee/i), '500');
    await user.click(screen.getByRole('button', { name: /create goal/i }));

    expect(await screen.findByText('Laptop')).toBeInTheDocument();
  });

  it('refuses to close a goal that still holds money', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Savings />, { authed: true });

    const rent = (await screen.findByText('Rent')).closest('div.glass');
    await user.click(within(rent).getByRole('button', { name: /close rent/i }));

    // The customer decides where the money goes, not us.
    expect(
      await screen.findByText(/withdraw the money in this goal before closing it/i)
    ).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });
});
