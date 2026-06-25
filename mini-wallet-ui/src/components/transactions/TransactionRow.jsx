import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, PlusCircle, Banknote } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { cn, formatCurrency, formatRelative } from '../../lib/utils.js';

const ICONS = {
  topup: { Icon: PlusCircle, tint: 'text-primary bg-primary/10' },
  withdrawal: { Icon: Banknote, tint: 'text-accent bg-accent/10' },
  credit: { Icon: ArrowDownLeft, tint: 'text-success bg-success/10' },
  debit: { Icon: ArrowUpRight, tint: 'text-error bg-error/10' },
};

/** Resolve label + counterparty text from this user's perspective. */
const describe = (t) => {
  if (t.type === 'topup') return { title: 'Wallet top-up', sub: t.description || 'Via M-Pesa' };
  if (t.type === 'withdrawal') return { title: 'Withdrawal', sub: t.phone || 'To M-Pesa' };
  const other = t.direction === 'credit' ? t.sender : t.receiver;
  return {
    title: t.direction === 'credit' ? `From ${other?.name || 'someone'}` : `To ${other?.name || 'someone'}`,
    sub: t.description || other?.email || 'Transfer',
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
      transition={{ delay: index * 0.05 }}
      className="flex items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-white/5"
    >
      <span className={cn('rounded-xl p-2.5', tint)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-text-muted">{sub}</p>
      </div>
      <div className="text-right">
        <p className={cn('text-sm font-semibold tabular-nums', credit ? 'text-success' : 'text-error')}>
          {credit ? '+' : '-'}
          {formatCurrency(t.amount, { withSymbol: false })}
        </p>
        <p className="text-[11px] text-text-muted">{formatRelative(t.createdAt)}</p>
      </div>
      <div className="hidden sm:block">
        <Badge status={t.status} />
      </div>
    </motion.div>
  );
}
