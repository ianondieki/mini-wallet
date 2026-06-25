import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import Card from '../ui/Card.jsx';
import { formatCurrency } from '../../lib/utils.js';

/**
 * Buckets every successful transaction into one of four categories from the
 * current user's perspective and renders a donut of volume share. Mirrors the
 * "Statistics" panel: a quick read on where money moves.
 */
const SLICES = [
  { key: 'topup', label: 'Top-ups', color: '#f5a623' },
  { key: 'received', label: 'Received', color: '#10b981' },
  { key: 'sent', label: 'Sent', color: '#f43f5e' },
  { key: 'withdrawal', label: 'Withdrawals', color: '#fbbf24' },
];

function DonutTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="glass rounded-lg px-3 py-2 text-xs">
      <p className="text-text-muted">{p.name}</p>
      <p className="font-semibold" style={{ color: p.payload.color }}>
        {formatCurrency(p.value)}
      </p>
    </div>
  );
}

export default function SpendingDonut({ transactions = [] }) {
  const { data, total } = useMemo(() => {
    const totals = { topup: 0, received: 0, sent: 0, withdrawal: 0 };
    transactions.forEach((t) => {
      if (t.status !== 'success') return;
      if (t.type === 'topup') totals.topup += t.amount;
      else if (t.type === 'withdrawal') totals.withdrawal += t.amount;
      else if (t.direction === 'credit') totals.received += t.amount;
      else totals.sent += t.amount;
    });
    const rows = SLICES.map((s) => ({
      name: s.label,
      value: totals[s.key],
      color: s.color,
    })).filter((r) => r.value > 0);
    const sum = rows.reduce((acc, r) => acc + r.value, 0);
    return { data: rows, total: sum };
  }, [transactions]);

  return (
    <Card className="flex flex-col p-5">
      <p className="label-caps">Statistics</p>
      <p className="text-sm text-text-muted">Volume by type</p>

      {data.length ? (
        <>
          <div className="relative mt-2 h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={74}
                  paddingAngle={2}
                  stroke="none"
                >
                  {data.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<DonutTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="label-caps">Total</span>
              <span className="text-sm font-bold tabular-nums">
                {formatCurrency(total, { withSymbol: false })}
              </span>
            </div>
          </div>

          <ul className="mt-4 space-y-2">
            {data.map((d) => (
              <li key={d.name} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
                  <span className="text-text-muted">{d.name}</span>
                </span>
                <span className="font-medium tabular-nums">
                  {total ? Math.round((d.value / total) * 100) : 0}%
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
          <span className="rounded-2xl bg-white/5 p-4 text-2xl">📊</span>
          <p className="text-sm text-text-muted">No activity to chart yet.</p>
        </div>
      )}
    </Card>
  );
}
