import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { Search, X, Check, Wallet } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Modal from '../components/ui/Modal.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useWallet, useRecipientSearch } from '../hooks/useWallet.js';
import { formatCurrency, cn } from '../lib/utils.js';

const QUICK = [100, 500, 1000, 2000];

/** Debounce a changing value by `delay` ms. */
function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function Send() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { balance, transfer, transferMutation } = useWallet();

  const [query, setQuery] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [searchError, setSearchError] = useState('');

  const idempotencyKey = useRef(uuidv4());

  const debouncedQuery = useDebounced(query, 400);
  const showDropdown = debouncedQuery.trim().length >= 2 && !recipient;
  const searchResults = useRecipientSearch(showDropdown ? debouncedQuery : '');

  const numericAmount = Number(amount);
  const canSend =
    recipient && numericAmount >= 1 && numericAmount <= balance && !transferMutation.isPending;

  const selectRecipient = (r) => {
    if (r.email === user?.email) {
      setSearchError('You cannot send money to yourself');
      return;
    }
    setSearchError('');
    setRecipient(r);
    setQuery('');
  };

  const handleSubmit = () => {
    if (recipient?.email === user?.email) return setSearchError('You cannot send money to yourself');
    if (numericAmount > balance) return setSearchError('Insufficient balance');
    setSearchError('');
    setConfirmOpen(true);
  };

  const confirmTransfer = async () => {
    try {
      await transfer({
        recipientEmail: recipient.email,
        amount: numericAmount,
        description: description.trim() || undefined,
        idempotencyKey: idempotencyKey.current,
      });
      setConfirmOpen(false);
      toast.success(`${formatCurrency(numericAmount)} sent to ${recipient.name}`);
      navigate('/dashboard');
    } catch (err) {
      setConfirmOpen(false);
      toast.error(err.message || 'Transfer failed. Nothing was sent.');
    }
  };

  return (
    <>
      <TopBar
        title="Send money"
        subtitle="Instant wallet-to-wallet transfer. Free, with a confirmation step."
      />

      <div className="mx-auto max-w-lg">
        <Card className="mb-4 flex items-center justify-between gap-3 p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" />
            </span>
            <div>
              <p className="text-2xs font-semibold uppercase tracking-wider text-text-muted">
                Your balance
              </p>
              <p className="text-sm font-semibold tabular-nums">{formatCurrency(balance)}</p>
            </div>
          </div>
        </Card>

        <Card gradientBorder className="p-6">
          <label htmlFor="recipient" className="label-caps">
            Recipient
          </label>
          <div className="relative mt-2">
            <div className="glow-focus flex items-center gap-2 rounded-xl border border-border bg-surface-2/80 px-3">
              <Search className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                id="recipient"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchError('');
                }}
                placeholder="Search by name or email"
                autoComplete="off"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-text-muted"
              />
            </div>

            <AnimatePresence>
              {showDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="glass absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-border shadow-elevated"
                >
                  {searchResults.isLoading && (
                    <p className="px-4 py-3 text-sm text-text-muted">Searching…</p>
                  )}
                  {!searchResults.isLoading && (searchResults.data?.length ?? 0) === 0 && (
                    <p className="px-4 py-3 text-sm text-text-muted">
                      No users found. Try another name or email.
                    </p>
                  )}
                  {searchResults.data?.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => selectRecipient(r)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                    >
                      <Avatar name={r.name} email={r.email} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.name}</p>
                        <p className="truncate text-xs text-text-muted">{r.email}</p>
                      </div>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {recipient && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/35 bg-primary/10 py-1 pl-1 pr-2.5">
              <Avatar name={recipient.name} email={recipient.email} size="sm" />
              <span className="text-sm font-medium">{recipient.name}</span>
              <button
                type="button"
                aria-label="Remove recipient"
                onClick={() => setRecipient(null)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="mt-6">
            <label htmlFor="send-amount" className="label-caps">
              Amount
            </label>
            <div className="amount-field mt-2 !justify-start !px-4 !py-0">
              <span className="text-lg font-semibold text-text-muted">KES</span>
              <input
                id="send-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
                className="h-14 w-full bg-transparent text-2xl font-bold tracking-money outline-none placeholder:text-text-muted/50"
              />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {QUICK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setAmount(String(q))}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                      Number(amount) === q
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border bg-surface-2/60 text-text-muted hover:text-primary'
                    )}
                  >
                    {q >= 1000 ? `${q / 1000}k` : q}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5">
            <label htmlFor="desc" className="label-caps">
              Note <span className="normal-case tracking-normal text-text-muted">(optional)</span>
            </label>
            <input
              id="desc"
              value={description}
              maxLength={100}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Lunch, rent share…"
              className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/80 px-4 text-sm outline-none transition-colors focus:border-primary/50"
            />
            <p className="mt-1 text-right text-2xs text-text-muted">{description.length}/100</p>
          </div>

          {recipient && numericAmount > 0 && (
            <div className="mt-4 rounded-xl border border-border bg-surface-2/40 px-4 py-3 text-center text-sm">
              <span className="text-text-muted">You’re sending </span>
              <span className="font-semibold tabular-nums text-primary">
                {formatCurrency(numericAmount)}
              </span>
              <span className="text-text-muted"> to </span>
              <span className="font-semibold text-text-primary">{recipient.name}</span>
            </div>
          )}

          {numericAmount > balance && (
            <p role="alert" className="mt-3 text-center text-sm text-error">
              Insufficient balance
            </p>
          )}

          {searchError && (
            <p role="alert" className="mt-3 text-sm text-error">
              {searchError}
            </p>
          )}

          <Button fullWidth size="lg" className="mt-5" disabled={!canSend} onClick={handleSubmit}>
            Review transfer
          </Button>
          <p className="mt-3 text-center text-2xs leading-relaxed text-text-muted">
            Instant · no transfer fee · you’ll confirm before it sends
          </p>
        </Card>
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm transfer">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">From</span>
            <span className="text-right font-medium">Your wallet · {formatCurrency(balance)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">To</span>
            <span className="text-right font-medium">
              {recipient?.name}
              <span className="block text-xs font-normal text-text-muted">{recipient?.email}</span>
            </span>
          </div>
          {description.trim() && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-text-muted">Note</span>
              <span className="max-w-[60%] truncate text-right font-medium">{description.trim()}</span>
            </div>
          )}
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-muted">Amount</span>
            <span className="text-lg font-bold tabular-nums text-primary">
              {formatCurrency(numericAmount)}
            </span>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <Button variant="ghost" fullWidth onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button fullWidth loading={transferMutation.isPending} onClick={confirmTransfer}>
            <Check className="h-4 w-4" /> Send now
          </Button>
        </div>
      </Modal>
    </>
  );
}
