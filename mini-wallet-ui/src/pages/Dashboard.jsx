import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { isAfter, startOfMonth } from 'date-fns';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Activity,
  Plus,
  Send,
  ShieldCheck,
  Phone,
  ArrowRight,
} from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import AnimatedNumber from '../components/ui/AnimatedNumber.jsx';
import StatsCard from '../components/charts/StatsCard.jsx';
import BalanceChart from '../components/charts/BalanceChart.jsx';
import SpendingDonut from '../components/charts/SpendingDonut.jsx';
import CategoryBars from '../components/charts/CategoryBars.jsx';
import TransactionRow from '../components/transactions/TransactionRow.jsx';
import { useWallet } from '../hooks/useWallet.js';
import { useTransactions } from '../hooks/useTransactions.js';
import { useAuth } from '../hooks/useAuth.js';
import { formatCurrency } from '../lib/utils.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { balance, balanceQuery } = useWallet();
  const txQuery = useTransactions({ limit: 50 });

  const transactions = txQuery.data?.transactions ?? [];
  const totalCount = txQuery.data?.pagination?.total ?? transactions.length;

  const stats = useMemo(() => {
    const monthStart = startOfMonth(new Date());
    let sent = 0;
    let received = 0;
    transactions.forEach((t) => {
      if (t.status !== 'success') return;
      if (!isAfter(new Date(t.createdAt), monthStart)) return;
      if (t.direction === 'credit') received += t.amount;
      else sent += t.amount;
    });
    return { sent, received };
  }, [transactions]);

  const recent = transactions.slice(0, 5);

  return (
    <>
      <TopBar
        title="Home"
        greet
        subtitle="Your balance, activity, and shortcuts — all in one place."
      />

      {/* Hero balance */}
      <Card
        gradientBorder
        glow
        elevated
        className="relative overflow-hidden p-6 sm:p-8"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(100% 90% at 90% 0%, rgba(245,166,35,0.14), transparent 55%), radial-gradient(90% 80% at 0% 100%, rgba(232,93,117,0.08), transparent 50%)',
          }}
        />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-stretch lg:justify-between">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="label-caps">Available balance</p>
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-2xs font-semibold text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                Live
              </span>
            </div>

            {balanceQuery.isLoading ? (
              <Skeleton className="mt-3 h-14 w-64" />
            ) : (
              <p
                className="mt-2 text-4xl font-bold tracking-money text-text-primary sm:text-5xl"
                data-money
              >
                <span className="mr-1.5 text-lg font-semibold text-text-muted sm:text-xl">KES</span>
                <AnimatedNumber
                  value={balance}
                  format={(n) => formatCurrency(n, { withSymbol: false })}
                />
              </p>
            )}
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-muted">
              Ready to send, withdraw, or top up via M-Pesa. Balances update as soon as payments
              clear.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => navigate('/topup')}>
                <Plus className="h-4 w-4" /> Top up
              </Button>
              <Button variant="ghost" onClick={() => navigate('/send')}>
                <Send className="h-4 w-4" /> Send money
              </Button>
              <Button variant="subtle" onClick={() => navigate('/withdraw')}>
                Withdraw
              </Button>
            </div>
          </div>

          {/* Account snapshot — real data only, no fake card numbers */}
          <div className="flex w-full max-w-sm flex-col justify-between rounded-2xl border border-white/10 bg-black/25 p-5 backdrop-blur-sm lg:w-72">
            <div>
              <p className="label-caps">Account</p>
              <p className="mt-2 truncate text-base font-semibold text-text-primary">
                {user?.name || 'Your wallet'}
              </p>
              <p className="mt-0.5 truncate text-sm text-text-muted">{user?.email}</p>
            </div>

            <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
              <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                <Phone className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="truncate font-mono text-xs tracking-wide">
                  {user?.phone || 'No phone on file'}
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
                <span className="text-xs">Protected with secure sessions</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-2xs font-semibold uppercase tracking-wider text-text-muted">
                  Currency
                </span>
                <span className="text-sm font-semibold tabular-nums">KES</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Quick stats — real month data only */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatsCard
          icon={ArrowUpRight}
          label="Sent this month"
          value={stats.sent}
          tint="red"
          hint="Successful transfers & withdrawals"
        />
        <StatsCard
          icon={ArrowDownLeft}
          label="Received this month"
          value={stats.received}
          tint="green"
          hint="Top-ups & incoming transfers"
        />
        <StatsCard
          icon={Activity}
          label="All transactions"
          value={totalCount}
          tint="gold"
          currency={false}
          hint="Lifetime + pending history"
        />
      </div>

      {/* Charts */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BalanceChart balance={balance} transactions={transactions} />
        </div>
        <div className="lg:col-span-1">
          <SpendingDonut transactions={transactions} />
        </div>
      </div>

      {/* Recent + categories */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="section-title">Recent activity</h2>
              <p className="mt-0.5 text-2xs text-text-muted">Your latest wallet movements</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/transactions')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary transition-colors hover:text-primary-dim"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {txQuery.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="h-10 w-10 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : recent.length ? (
            <motion.div initial="hidden" animate="show" className="divide-y divide-border/50">
              {recent.map((t, i) => (
                <TransactionRow key={t.id} transaction={t} index={i} />
              ))}
            </motion.div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Plus className="h-6 w-6" />
              </span>
              <div>
                <p className="font-semibold text-text-primary">No activity yet</p>
                <p className="mt-1 max-w-xs text-sm leading-relaxed text-text-muted">
                  Top up with M-Pesa to fund your wallet — your first transaction will show up here.
                </p>
              </div>
              <Button size="sm" className="mt-1" onClick={() => navigate('/topup')}>
                Top up now
              </Button>
            </div>
          )}
        </Card>

        <div className="lg:col-span-1">
          <CategoryBars transactions={transactions} />
        </div>
      </div>
    </>
  );
}
