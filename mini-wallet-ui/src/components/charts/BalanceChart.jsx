import { useState, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { format } from 'date-fns';
import Card from '../ui/Card.jsx';
import { cn, formatCurrency } from '../../lib/utils.js';

const RANGES = [
  { key: '7D', days: 7 },
  { key: '30D', days: 30 },
  { key: 'All', days: 90 },
];

/** Glass tooltip matching the app surface. */
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass rounded-lg px-3 py-2 text-xs">
      <p className="text-text-muted">{label}</p>
      <p className="font-semibold text-primary">{formatCurrency(payload[0].value)}</p>
    </div>
  );
}

/**
 * Balance trend area chart. Derives a synthetic daily series from the
 * current balance + recent transactions so the chart reflects real data
 * without a dedicated history endpoint.
 */
export default function BalanceChart({ balance = 0, transactions = [] }) {
  const [range, setRange] = useState('7D');
  const days = RANGES.find((r) => r.key === range)?.days ?? 7;

  const data = useMemo(() => {
    // Walk backwards from today's balance, undoing each day's net movement.
    const byDay = new Map();
    transactions.forEach((t) => {
      const day = format(new Date(t.createdAt), 'yyyy-MM-dd');
      const signed = t.direction === 'credit' ? t.amount : -t.amount;
      byDay.set(day, (byDay.get(day) || 0) + (t.status === 'success' ? signed : 0));
    });

    const series = [];
    let running = balance;
    for (let i = 0; i < days; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = format(d, 'yyyy-MM-dd');
      series.push({ date: format(d, 'MMM d'), balance: Math.max(0, running) });
      running -= byDay.get(key) || 0;
    }
    return series.reverse();
  }, [balance, transactions, days]);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="label-caps">Balance trend</p>
          <p className="text-sm text-text-muted">Last {range}</p>
        </div>
        <div className="flex gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={cn(
                'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
                range === r.key ? 'bg-primary text-bg' : 'text-text-muted hover:text-text-primary'
              )}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f5a623" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#f5a623" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              minTickGap={20}
            />
            <YAxis
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)}
            />
            <Tooltip content={<ChartTooltip />} />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="#f5a623"
              strokeWidth={2.5}
              fill="url(#balanceFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
