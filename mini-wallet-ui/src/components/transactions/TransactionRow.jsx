import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, PlusCircle, Banknote } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { cn, formatCurrency, formatRelative } from '../../lib/utils.js';

const ICONS = {
  topup: { Icon: PlusCircle, tint: 'text-primary bg-primary/10' },
  withdrawal: { Icon: Banknote, tint: 'text-secondary bg-secondary/10' },
  credit: { Icon: ArrowDownLeft, tint: 'text-success bg-success/10' },
  debit: { Icon: ArrowUpRight, tint: 'text-error bg-error/10' },
};

/** Resolve label + counterparty text from this user's perspective. */
const describe = (t) => {
  if (t.type === 'topup') return { title: 'M-Pesa top-up', sub: t.description || 'Added via STK Push' };
  if (t.type === 'withdrawal') return { title: 'Cash out to M-Pesa', sub: t.phone || 'B2C payout' };
  const other = t.direction === 'credit' ? t.sender : t.receiver;
  return {
    title: t.direction === 'credit' ? `From ${other?.name || 'someone'}` : `To ${other?.name || 'someone'}`,
    sub: t.description || other?.email || 'Wallet transfer',
  };
};

export default function TransactionRow({ transaction: t, index = 0 }) {
  const iconKey = t.type === 'transfer' ? t.direction : t.type;
  const { Icon, tint } = ICONS[iconKey] || ICONS.credit;
  const { title, sub } = describe(t);
  const credit = t.direction === 'credit';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="flex items-center gap-3 rounded-xl px-2 py-3.5 transition-colors hover:bg-white/[0.03]"
    >
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tint)}>
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{title}</p>
        <p className="truncate text-xs text-text-muted">{sub}</p>
      </div>
      <div className="text-right">
        <p
          className={cn(
            'text-sm font-semibold tabular-nums tracking-money',
            credit ? 'text-success' : 'text-text-primary'
          )}
          data-money
        >
          {credit ? '+' : '−'}
          {formatCurrency(t.amount, { withSymbol: false })}
        </p>
        <p className="text-2xs text-text-muted">{formatRelative(t.createdAt)}</p>
      </div>
      <div className="hidden sm:block">
        <Badge status={t.status} />
      </div>
    </motion.div>
  );
}
