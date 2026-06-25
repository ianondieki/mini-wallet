import { useState, useMemo } from 'react';
import { isAfter, startOfWeek, startOfMonth } from 'date-fns';
import { Download, ArrowDownLeft, ArrowUpRight, Wallet } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Button from '../components/ui/Button.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import Modal from '../components/ui/Modal.jsx';
import TransactionFilters from '../components/transactions/TransactionFilters.jsx';
import TransactionTable from '../components/transactions/TransactionTable.jsx';
import TransactionDetail from '../components/transactions/TransactionDetail.jsx';
import { useTransactions } from '../hooks/useTransactions.js';
import { cn, exportToCsv, formatCurrency, formatDate } from '../lib/utils.js';

const EMPTY = { search: '', type: '', status: '', date: '' };
const PAGE_SIZE = 10;

export default function Transactions() {
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);

  // Type/status are server-side; search/date are applied client-side.
  const query = useTransactions({ page, limit: PAGE_SIZE, type: filters.type, status: filters.status });
  const all = query.data?.transactions ?? [];
  const pagination = query.data?.pagination ?? { totalPages: 1, total: 0 };

  // Summary across the loaded rows (successful only).
  const summary = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    all.forEach((t) => {
      if (t.status !== 'success') return;
      if (t.direction === 'credit') inflow += t.amount;
      else outflow += t.amount;
    });
    return { inflow, outflow, net: inflow - outflow };
  }, [all]);

  const visible = useMemo(() => {
    let rows = all;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (t) =>
          (t.description || '').toLowerCase().includes(q) ||
          (t.mpesaReceiptNumber || '').toLowerCase().includes(q) ||
          (t.sender?.name || '').toLowerCase().includes(q) ||
          (t.receiver?.name || '').toLowerCase().includes(q)
      );
    }
    if (filters.date) {
      const start = filters.date === 'week' ? startOfWeek(new Date()) : startOfMonth(new Date());
      rows = rows.filter((t) => isAfter(new Date(t.createdAt), start));
    }
    return rows;
  }, [all, filters.search, filters.date]);

  const patch = (p) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };

  const handleExport = () => {
    exportToCsv(
      `transactions-${Date.now()}.csv`,
      visible.map((t) => ({
        date: formatDate(t.createdAt),
        type: t.type,
        description: t.description || '',
        direction: t.direction,
        amount: t.amount,
        status: t.status,
        receipt: t.mpesaReceiptNumber || '',
      })),
      [
        { key: 'date', label: 'Date' },
        { key: 'type', label: 'Type' },
        { key: 'description', label: 'Description' },
        { key: 'direction', label: 'Direction' },
        { key: 'amount', label: 'Amount (KES)' },
        { key: 'status', label: 'Status' },
        { key: 'receipt', label: 'Receipt' },
      ]
    );
  };

  return (
    <>
      <TopBar title="Transactions" />

      {/* Summary across loaded rows */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <SummaryCard icon={ArrowDownLeft} label="Money in" value={summary.inflow} tone="success" />
        <SummaryCard icon={ArrowUpRight} label="Money out" value={summary.outflow} tone="error" />
        <SummaryCard icon={Wallet} label="Net flow" value={summary.net} tone="primary" signed />
      </div>

      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-text-muted">{pagination.total} total transactions</p>
        <Button variant="ghost" size="sm" onClick={handleExport} disabled={!visible.length}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="mb-6">
        <TransactionFilters filters={filters} onChange={patch} onClear={() => setFilters(EMPTY)} />
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <TransactionTable transactions={visible} onRowClick={setSelected} />
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-1">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg px-3 py-1.5 text-sm text-text-muted disabled:opacity-40 hover:text-text-primary"
          >
            Prev
          </button>
          {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPage(n)}
              aria-current={page === n}
              className={cn(
                'h-9 w-9 rounded-lg text-sm transition-colors',
                page === n ? 'bg-primary text-bg' : 'text-text-muted hover:bg-white/5'
              )}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            disabled={page === pagination.totalPages}
            onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            className="rounded-lg px-3 py-1.5 text-sm text-text-muted disabled:opacity-40 hover:text-text-primary"
          >
            Next
          </button>
        </div>
      )}

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title="Transaction detail">
        <TransactionDetail transaction={selected} />
      </Modal>
    </>
  );
}

function SummaryCard({ icon: Icon, label, value, tone, signed }) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'error' ? 'text-error' : 'text-primary';
  const tintBg =
    tone === 'success' ? 'bg-success/10' : tone === 'error' ? 'bg-error/10' : 'bg-primary/10';
  const prefix = signed && value > 0 ? '+' : '';
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-2/40 p-4">
      <span className={cn('inline-flex h-10 w-10 items-center justify-center rounded-xl', tintBg, toneClass)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="label-caps">{label}</p>
        <p className={cn('text-lg font-bold tabular-nums', signed && toneClass)}>
          {prefix}
          {formatCurrency(value, { withSymbol: false })}
        </p>
      </div>
    </div>
  );
}
