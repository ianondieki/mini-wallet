import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { Search, X, Check } from 'lucide-react';
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

  // One idempotency key per page mount (resets on remount / success navigation).
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
      toast.error(err.message || 'Transfer failed');
    }
  };

  return (
    <>
      <TopBar title="Send Money" />

      <div className="mx-auto max-w-lg">
        <Card gradientBorder className="p-6">
          {/* Recipient search */}
          <label htmlFor="recipient" className="label-caps">Recipient</label>
          <div className="relative mt-2">
            <div className="glow-focus flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3">
              <Search className="h-4 w-4 text-text-muted" />
              <input
                id="recipient"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchError('');
                }}
                placeholder="Search by email or name"
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
                  className="glass absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-border"
                >
                  {searchResults.isLoading && (
                    <p className="px-4 py-3 text-sm text-text-muted">Searching…</p>
                  )}
                  {!searchResults.isLoading && (searchResults.data?.length ?? 0) === 0 && (
                    <p className="px-4 py-3 text-sm text-text-muted">No users found</p>
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
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 py-1 pl-1 pr-3">
              <Avatar name={recipient.name} email={recipient.email} size="sm" />
              <span className="text-sm font-medium">{recipient.name}</span>
              <button type="button" aria-label="Remove recipient" onClick={() => setRecipient(null)} className="text-text-muted hover:text-text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Amount */}
          <div className="mt-6">
            <label htmlFor="send-amount" className="label-caps">Amount</label>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-4">
              <span className="text-lg font-semibold text-text-muted">KES</span>
              <input
                id="send-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
                className="h-14 w-full bg-transparent text-2xl font-bold outline-none placeholder:text-text-muted"
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex gap-2">
                {QUICK.map((q) => (
                  <button key={q} type="button" onClick={() => setAmount(String(q))} className="rounded-lg border border-border bg-surface-2/60 px-3 py-1 text-xs text-text-muted hover:text-primary">
                    {q >= 1000 ? `${q / 1000}k` : q}
                  </button>
                ))}
              </div>
              <span className="text-xs text-text-muted">Balance {formatCurrency(balance)}</span>
            </div>
          </div>

          {/* Description */}
          <div className="mt-5">
            <label htmlFor="desc" className="label-caps">Description (optional)</label>
            <input
              id="desc"
              value={description}
              maxLength={100}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's it for?"
              className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
            />
            <p className="mt-1 text-right text-xs text-text-muted">{description.length}/100</p>
          </div>

          {recipient && numericAmount > 0 && (
            <p className="mt-4 text-center text-sm text-text-muted">
              You're sending{' '}
              <span className="font-semibold text-accent">{formatCurrency(numericAmount)}</span> to{' '}
              <span className="font-semibold text-text-primary">{recipient.name}</span>
            </p>
          )}

          {numericAmount > balance && (
            <p role="alert" className="mt-3 text-center text-sm text-error">
              Insufficient balance
            </p>
          )}

          {searchError && <p role="alert" className="mt-3 text-sm text-error">{searchError}</p>}

          <Button fullWidth size="lg" className="mt-5" disabled={!canSend} onClick={handleSubmit}>
            Send Money
          </Button>
        </Card>
      </div>

      {/* Confirmation modal */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Transfer">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">From</span>
            <span className="font-medium">Your Wallet · {formatCurrency(balance)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-muted">To</span>
            <span className="text-right font-medium">
              {recipient?.name}
              <span className="block text-xs text-text-muted">{recipient?.email}</span>
            </span>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Amount</span>
            <span className="text-lg font-bold text-accent">{formatCurrency(numericAmount)}</span>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <Button variant="ghost" fullWidth onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button fullWidth loading={transferMutation.isPending} onClick={confirmTransfer}>
            <Check className="h-4 w-4" /> Confirm Transfer
          </Button>
        </div>
      </Modal>
    </>
  );
}
