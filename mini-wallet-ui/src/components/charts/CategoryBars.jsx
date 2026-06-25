import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Plus, ArrowDownLeft, ArrowUpRight, Banknote } from 'lucide-react';
import Card from '../ui/Card.jsx';
import { formatCurrency } from '../../lib/utils.js';

/**
 * Horizontal share-of-volume bars per transaction category, animated on mount.
 * Mirrors the "Budget" panel — a glanceable breakdown of where money goes.
 */
const CATS = [
  { key: 'topup', label: 'Top-ups', color: '#f5a623', Icon: Plus },
  { key: 'received', label: 'Received', color: '#10b981', Icon: ArrowDownLeft },
  { key: 'sent', label: 'Sent', color: '#f43f5e', Icon: ArrowUpRight },
  { key: 'withdrawal', label: 'Withdrawals', color: '#fbbf24', Icon: Banknote },
];

export default function CategoryBars({ transactions = [] }) {
  const rows = useMemo(() => {
    const totals = { topup: 0, received: 0, sent: 0, withdrawal: 0 };
    transactions.forEach((t) => {
      if (t.status !== 'success') return;
      if (t.type === 'topup') totals.topup += t.amount;
      else if (t.type === 'withdrawal') totals.withdrawal += t.amount;
      else if (t.direction === 'credit') totals.received += t.amount;
      else totals.sent += t.amount;
    });
    const max = Math.max(1, ...Object.values(totals));
    return CATS.map((c) => ({
      ...c,
      value: totals[c.key],
      pct: Math.round((totals[c.key] / max) * 100),
    }));
  }, [transactions]);

  const hasData = rows.some((r) => r.value > 0);

  return (
    <Card className="flex flex-col p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="label-caps">Spending breakdown</p>
        <span className="text-xs text-text-muted">by volume</span>
      </div>
      <p className="mb-4 text-sm text-text-muted">Relative to your largest category</p>

      {hasData ? (
        <ul className="space-y-4">
          {rows.map((r, i) => (
            <li key={r.key}>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span
                    className="rounded-lg p-1.5"
                    style={{ background: `${r.color}1a`, color: r.color }}
                  >
                    <r.Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-text-muted">{r.label}</span>
                </span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(r.value, { withSymbol: false })}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: r.color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${r.pct}%` }}
                  transition={{ duration: 0.8, delay: i * 0.08, ease: 'easeOut' }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
          <span className="rounded-2xl bg-white/5 p-4 text-2xl">🧮</span>
          <p className="text-sm text-text-muted">No spending to break down yet.</p>
        </div>
      )}
    </Card>
  );
}
