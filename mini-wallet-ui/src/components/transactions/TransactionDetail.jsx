import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { Undo2 } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import { counterparty, typeMeta } from './TransactionTable.jsx';
import { useWalletExtras, useRefundable } from '../../hooks/useWallet.js';
import { cn, formatCurrency, formatDate } from '../../lib/utils.js';

/** Flows that can be given back. Everything else is reversed through support. */
const REFUNDABLE_FLOWS = new Set(['transfer', 'transfer.split']);

/**
 * Give money back.
 *
 * Offered only on a payment this customer *received*, because only the payee
 * can refund. The outstanding figure comes from the server rather than from
 * the row's amount: after a partial refund those two differ, and the one the
 * server will enforce is the one worth showing.
 */
function RefundPanel({ transaction: t }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const key = useRef(uuidv4());
  const { refund, refundMutation } = useWalletExtras();

  const eligible =
    t.direction === 'credit' && t.status === 'success' && REFUNDABLE_FLOWS.has(t.flow);
  const quote = useRefundable(t.id, eligible);

  if (!eligible || quote.isError) return null;
  if (quote.isLoading || !quote.data) return null;

  const refundable = Number(quote.data.refundable.amount);
  const alreadyRefunded = Number(quote.data.alreadyRefunded.amount);

  if (quote.data.fullyRefunded) {
    return (
      <p className="mt-4 rounded-xl border border-border bg-surface-2/40 px-4 py-3 text-xs text-text-muted">
        You have given all {formatCurrency(Number(quote.data.received.amount))} of this back.
      </p>
    );
  }

  const numeric = amount === '' ? refundable : Number(amount);
  const valid = numeric >= 1 && numeric <= refundable;

  const submit = async () => {
    try {
      const result = await refund({
        entryId: t.id,
        // Empty means "everything outstanding", which the server resolves —
        // so a figure that moves between render and submit cannot go stale.
        amount: amount === '' ? undefined : numeric,
        reason: reason.trim() || undefined,
        idempotencyKey: key.current,
      });
      key.current = uuidv4();
      setAmount('');
      setReason('');
      setOpen(false);
      toast.success(`${formatCurrency(Number(result.returned.amount))} returned`);
    } catch (err) {
      toast.error(err.message || 'Refund failed');
    }
  };

  if (!open) {
    return (
      <div className="mt-4">
        <Button variant="ghost" fullWidth onClick={() => setOpen(true)}>
          <Undo2 className="h-4 w-4" /> Refund {formatCurrency(refundable)}
        </Button>
        {alreadyRefunded > 0 && (
          <p className="mt-2 text-center text-xs text-text-muted">
            {formatCurrency(alreadyRefunded)} already refunded
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
      <div>
        <label htmlFor="refund-amount" className="label-caps">
          Amount — up to {formatCurrency(refundable)}
        </label>
        <input
          id="refund-amount"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          placeholder={String(refundable)}
          className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
        />
        <p className="mt-1 text-xs text-text-muted">
          Leave it blank to return everything outstanding. Partial refunds can
          be repeated.
        </p>
      </div>
      <div>
        <label htmlFor="refund-reason" className="label-caps">Reason (optional)</label>
        <input
          id="refund-reason"
          value={reason}
          maxLength={140}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Out of stock"
          className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
        />
      </div>
      {quote.data.feeReturnedOnFullRefund && (
        <p className="text-xs text-text-muted">
          A full refund within {quote.data.feeRefundWindowHours}h also returns
          the {formatCurrency(Number(quote.data.originalFee.amount))} fee they paid.
        </p>
      )}
      {!valid && amount !== '' && (
        <p role="alert" className="text-sm text-error">
          Enter an amount up to {formatCurrency(refundable)}
        </p>
      )}
      <div className="flex gap-3">
        <Button variant="ghost" fullWidth size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          fullWidth
          size="sm"
          loading={refundMutation.isPending}
          disabled={!valid}
          onClick={submit}
        >
          Refund
        </Button>
      </div>
    </div>
  );
}

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

      <RefundPanel transaction={t} />
    </div>
  );
}
