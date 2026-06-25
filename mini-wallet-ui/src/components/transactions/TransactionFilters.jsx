import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const TYPES = [
  { value: '', label: 'All' },
  { value: 'topup', label: 'Top Up' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'withdrawal', label: 'Withdrawal' },
];
const STATUSES = [
  { value: '', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
];
const DATES = [
  { value: '', label: 'Any time' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
];

function Segmented({ label, options, value, onChange, name }) {
  return (
    <div>
      <p className="label-caps mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              value === o.value ? 'bg-primary text-bg' : 'text-text-muted hover:text-text-primary'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Filter bar for the transactions page. Controlled — emits changes upward.
 * @param {{filters:object, onChange:(patch:object)=>void, onClear:()=>void}} props
 */
export default function TransactionFilters({ filters, onChange, onClear }) {
  const hasFilters = filters.search || filters.type || filters.status || filters.date;

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-surface-2/40 p-4">
      <div className="glow-focus flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3">
        <Search className="h-4 w-4 text-text-muted" />
        <input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          placeholder="Search description or reference…"
          aria-label="Search transactions"
          className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-text-muted"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Segmented
          label="Type"
          name="type"
          options={TYPES}
          value={filters.type}
          onChange={(v) => onChange({ type: v })}
        />
        <Segmented
          label="Status"
          name="status"
          options={STATUSES}
          value={filters.status}
          onChange={(v) => onChange({ status: v })}
        />
        <Segmented
          label="Date range"
          name="date"
          options={DATES}
          value={filters.date}
          onChange={(v) => onChange({ date: v })}
        />
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
        >
          <X className="h-3.5 w-3.5" /> Clear filters
        </button>
      )}
    </div>
  );
}
