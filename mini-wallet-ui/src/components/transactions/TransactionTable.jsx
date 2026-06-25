import { motion } from 'framer-motion';
import { Inbox, Plus, Banknote, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { cn, formatCurrency, formatDate } from '../../lib/utils.js';

const counterparty = (t) => {
  if (t.type === 'topup') return 'M-Pesa';
  if (t.type === 'withdrawal') return t.phone || 'M-Pesa';
  const other = t.direction === 'credit' ? t.sender : t.receiver;
  return other?.name || other?.email || '—';
};

/** Icon + tint per transaction kind, from the current user's perspective. */
const typeMeta = (t) => {
  if (t.type === 'topup') return { Icon: Plus, color: '#f5a623' };
  if (t.type === 'withdrawal') return { Icon: Banknote, color: '#fbbf24' };
  if (t.direction === 'credit') return { Icon: ArrowDownLeft, color: '#10b981' };
  return { Icon: ArrowUpRight, color: '#f43f5e' };
};

function TypeIcon({ t }) {
  const { Icon, color } = typeMeta(t);
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
      style={{ background: `${color}1a`, color }}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="rounded-2xl bg-white/5 p-4">
        <Inbox className="h-8 w-8 text-text-muted" />
      </span>
      <p className="font-medium">No transactions found</p>
      <p className="max-w-xs text-sm text-text-muted">
        Try adjusting your filters, or top up your wallet to get started.
      </p>
    </div>
  );
}

/**
 * Responsive transaction list: a real table on desktop, stacked cards on
 * mobile. Amounts are coloured by direction. Rows are clickable to open a
 * detail view when `onRowClick` is provided.
 */
export default function TransactionTable({ transactions = [], onRowClick }) {
  if (!transactions.length) return <EmptyState />;

  const clickable = typeof onRowClick === 'function';

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-2/60 text-left text-xs uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">From / To</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Receipt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {transactions.map((t, i) => {
              const credit = t.direction === 'credit';
              return (
                <motion.tr
                  key={t.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: Math.min(i * 0.025, 0.3) }}
                  whileHover={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
                  onClick={clickable ? () => onRowClick(t) : undefined}
                  className={cn('transition-colors', clickable && 'cursor-pointer')}
                >
                  <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                    {formatDate(t.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <TypeIcon t={t} />
                      <Badge status={t.type}>{t.type}</Badge>
                    </span>
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-3">{t.description || '—'}</td>
                  <td className="max-w-[160px] truncate px-4 py-3 text-text-muted">
                    {counterparty(t)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-semibold tabular-nums',
                      credit ? 'text-success' : 'text-error'
                    )}
                  >
                    {credit ? '+' : '-'}
                    {formatCurrency(t.amount, { withSymbol: false })}
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={t.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {t.mpesaReceiptNumber || '—'}
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {transactions.map((t) => {
          const credit = t.direction === 'credit';
          return (
            <div
              key={t.id}
              onClick={clickable ? () => onRowClick(t) : undefined}
              className={cn(
                'rounded-xl border border-border bg-surface-2/40 p-4',
                clickable && 'cursor-pointer active:bg-white/5'
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <TypeIcon t={t} />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.description || counterparty(t)}</p>
                    <p className="text-xs text-text-muted">{formatDate(t.createdAt)}</p>
                  </div>
                </div>
                <p
                  className={cn(
                    'font-semibold tabular-nums',
                    credit ? 'text-success' : 'text-error'
                  )}
                >
                  {credit ? '+' : '-'}
                  {formatCurrency(t.amount, { withSymbol: false })}
                </p>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Badge status={t.type}>{t.type}</Badge>
                <Badge status={t.status} />
                {t.mpesaReceiptNumber && (
                  <span className="ml-auto font-mono text-xs text-text-muted">
                    {t.mpesaReceiptNumber}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export { counterparty, typeMeta };
