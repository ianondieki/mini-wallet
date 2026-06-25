import { motion } from 'framer-motion';
import Badge from '../ui/Badge.jsx';
import { counterparty, typeMeta } from './TransactionTable.jsx';
import { cn, formatCurrency, formatDate } from '../../lib/utils.js';

function DetailRow({ label, value, mono }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={cn('text-right text-sm font-medium break-all', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  );
}

/**
 * Full detail of a single transaction, rendered inside a Modal.
 * @param {{transaction: object}} props
 */
export default function TransactionDetail({ transaction: t }) {
  if (!t) return null;
  const credit = t.direction === 'credit';
  const { Icon, color } = typeMeta(t);

  return (
    <div>
      {/* Hero amount */}
      <div className="flex flex-col items-center py-2 text-center">
        <motion.span
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="inline-flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{ background: `${color}1a`, color }}
        >
          <Icon className="h-7 w-7" />
        </motion.span>
        <p className={cn('mt-3 text-3xl font-bold tabular-nums', credit ? 'text-success' : 'text-error')}>
          {credit ? '+' : '-'}
          {formatCurrency(t.amount)}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Badge status={t.type}>{t.type}</Badge>
          <Badge status={t.status} />
        </div>
      </div>

      {/* Detail rows */}
      <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface-2/40 px-4">
        <DetailRow label="Date" value={formatDate(t.createdAt)} />
        <DetailRow label={credit ? 'From' : 'To'} value={counterparty(t)} />
        <DetailRow label="Description" value={t.description} />
        <DetailRow label="Direction" value={credit ? 'Money in' : 'Money out'} />
        <DetailRow label="M-Pesa receipt" value={t.mpesaReceiptNumber} mono />
        <DetailRow label="Reference" value={t.id} mono />
      </div>
    </div>
  );
}
