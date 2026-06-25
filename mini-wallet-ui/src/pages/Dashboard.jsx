import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { isAfter, startOfMonth } from 'date-fns';
import { ArrowUpRight, ArrowDownLeft, Activity, Plus, Send, Wifi } from 'lucide-react';
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

/** Derive a stable, masked "card number" from the user id for display flair. */
function maskedCard(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const last4 = String(Math.abs(hash) % 10000).padStart(4, '0');
  return `7383  ••••  ••••  ${last4}`;
}

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
      <TopBar title="Dashboard" />

      {/* Hero balance — styled as a virtual card */}
      <Card
        gradientBorder
        glow
        className="relative overflow-hidden p-6 sm:p-8"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(120% 120% at 80% 0%, rgba(245,166,35,0.20), transparent 50%), radial-gradient(120% 120% at 0% 100%, rgba(244,63,94,0.16), transparent 50%)',
          }}
        />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="label-caps">Total balance</p>
            {balanceQuery.isLoading ? (
              <Skeleton className="mt-2 h-12 w-56" />
            ) : (
              <p className="mt-1 text-4xl font-bold tracking-tight sm:text-5xl">
                <span className="text-text-muted">KES </span>
                <AnimatedNumber value={balance} format={(n) => formatCurrency(n, { withSymbol: false })} />
              </p>
            )}
            <p className="mt-2 text-sm text-text-muted">Available to spend or transfer</p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => navigate('/topup')}>
                <Plus className="h-4 w-4" /> Top Up
              </Button>
              <Button variant="ghost" onClick={() => navigate('/send')}>
                <Send className="h-4 w-4" /> Send Money
              </Button>
            </div>
          </div>

          {/* Card-information mini-panel — premium gold card */}
          <div
            className="relative w-full max-w-xs shrink-0 overflow-hidden rounded-2xl p-5 shadow-card"
            style={{
              background:
                'linear-gradient(135deg, #fbbf24 0%, #f5a623 45%, #d98c1a 100%)',
            }}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background:
                  'radial-gradient(120% 80% at 100% 0%, rgba(255,255,255,0.55), transparent 60%)',
              }}
            />
            <div className="relative text-black">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-black/70">
                  Wallet card
                </span>
                <Wifi className="h-4 w-4 rotate-90 text-black/70" />
              </div>
              <p className="mt-4 font-mono text-sm font-medium tracking-widest text-black/90">
                {maskedCard(user?.id || user?.email || 'wallet')}
              </p>
              <div className="mt-5 flex items-end justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-black/60">
                    Holder
                  </p>
                  <p className="truncate text-sm font-semibold">{user?.name || 'You'}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-black/60">
                    Currency
                  </p>
                  <p className="text-sm font-semibold">KES 🇰🇪</p>
                </div>
              </div>
              <div className="mt-4">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/15 px-2.5 py-0.5 text-xs font-semibold text-black/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-black/70" />
                  Active
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Quick stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatsCard icon={ArrowUpRight} label="Sent this month" value={stats.sent} tint="red" change={-4} />
        <StatsCard icon={ArrowDownLeft} label="Received this month" value={stats.received} tint="green" change={12} />
        <StatsCard icon={Activity} label="Total transactions" value={totalCount} tint="gold" change={8} currency={false} />
      </div>

      {/* Activities chart + Statistics donut */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BalanceChart balance={balance} transactions={transactions} />
        </div>
        <div className="lg:col-span-1">
          <SpendingDonut transactions={transactions} />
        </div>
      </div>

      {/* Recent transactions + spending breakdown */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent transactions</h2>
            <button
              type="button"
              onClick={() => navigate('/transactions')}
              className="text-xs font-medium text-primary hover:underline"
            >
              View all →
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
            <motion.div initial="hidden" animate="show" className="divide-y divide-border/60">
              {recent.map((t, i) => (
                <TransactionRow key={t.id} transaction={t} index={i} />
              ))}
            </motion.div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="rounded-2xl bg-white/5 p-4 text-2xl">💸</span>
              <p className="font-medium">No transactions yet</p>
              <p className="text-sm text-text-muted">Top up your wallet to see activity here.</p>
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
