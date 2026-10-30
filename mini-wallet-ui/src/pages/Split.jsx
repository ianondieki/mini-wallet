import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { Users, Plus, X, Check, HandCoins, Send as SendIcon, Clock } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Modal from '../components/ui/Modal.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useWallet, useWalletExtras, useRecipientSearch } from '../hooks/useWallet.js';
import { useRequests } from '../hooks/useRequests.js';
import { formatCurrency, formatRelative, cn } from '../lib/utils.js';

/**
 * Group money: splitting a bill you already paid, and paying several people
 * at once. The two directions of the same screen, which is why they share it
 * — the question "who owes whom" has one answer and it belongs in one place.
 */

/** Debounce a changing value by `delay` ms. */
function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Pick several people by name or email. */
function PeoplePicker({ people, onAdd, onRemove }) {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const debounced = useDebounced(query, 400);
  const results = useRecipientSearch(debounced.trim().length >= 2 ? debounced : '');

  const add = (person) => {
    if (person.email === user?.email) return setError('You are already at the table');
    if (people.some((p) => p.email === person.email)) return setError(`${person.name} is already on this bill`);
    setError('');
    setQuery('');
    return onAdd(person);
  };

  return (
    <div>
      <label htmlFor="split-people" className="label-caps">Who else</label>
      <div className="relative mt-2">
        <input
          id="split-people"
          value={query}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setError('');
          }}
          placeholder="Search by email or name"
          className="h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
        />
        {debounced.trim().length >= 2 && (results.data?.length ?? 0) > 0 && (
          <div className="glass absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-border">
            {results.data.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => add(r)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
              >
                <Avatar name={r.name} email={r.email} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="truncate text-xs text-text-muted">{r.email}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {people.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {people.map((p) => (
            <span
              key={p.email}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/40 bg-primary/10 py-1 pl-1 pr-2"
            >
              <Avatar name={p.name} email={p.email} size="sm" />
              <span className="truncate text-sm font-medium">{p.name}</span>
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => onRemove(p.email)}
                className="shrink-0 text-text-muted hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}

/**
 * The composer. One form, two directions:
 *
 *  - **ask**  — you paid, so the bill divides between everyone at the table
 *               (you included) and only the others get a request.
 *  - **pay**  — you are paying them, so the whole amount divides between the
 *               people you named and leaves your own share out of it.
 *
 * That asymmetry is the thing people get wrong when they do this by hand, so
 * the preview below spells out exactly who is charged what.
 */
function Composer({ open, onClose, balance, requests, extras }) {
  const [mode, setMode] = useState('ask');
  const [people, setPeople] = useState([]);
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const key = useRef(uuidv4());

  const numeric = Number(total);
  // `ask` divides by heads at the table; `pay` divides by payees only.
  const heads = mode === 'ask' ? people.length + 1 : people.length;
  const perHead = heads > 0 && numeric > 0 ? numeric / heads : 0;
  const askingFor = mode === 'ask' ? perHead * people.length : numeric;

  const minPeople = mode === 'ask' ? 1 : 2;
  const valid =
    people.length >= minPeople &&
    numeric >= 1 &&
    (mode === 'ask' || numeric <= balance);
  const pending = requests.create.isPending || extras.splitMutation.isPending;

  const reset = () => {
    setPeople([]);
    setTotal('');
    setNote('');
    key.current = uuidv4();
  };

  const submit = async () => {
    try {
      if (mode === 'ask') {
        const result = await requests.create.mutateAsync({
          participants: people.map((p) => p.email),
          total: numeric,
          note: note.trim() || undefined,
        });
        toast.success(
          `Asked ${people.length} ${people.length === 1 ? 'person' : 'people'} for ${formatCurrency(
            Number(result.requested.amount)
          )}`
        );
      } else {
        await extras.split({
          recipients: people.map((p) => p.email),
          amount: numeric,
          description: note.trim() || undefined,
          idempotencyKey: key.current,
        });
        toast.success(`${formatCurrency(numeric)} split between ${people.length} people`);
      }
      reset();
      onClose();
    } catch (err) {
      toast.error(err.message || 'That did not go through');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Split a bill">
      <div className="space-y-4">
        {/* Direction */}
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-2/40 p-1">
          {[
            { id: 'ask', label: 'I paid — they owe me', icon: HandCoins },
            { id: 'pay', label: "I'm paying them", icon: SendIcon },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={cn(
                'flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                mode === id ? 'bg-primary text-bg' : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        <PeoplePicker
          people={people}
          onAdd={(p) => setPeople((list) => [...list, p])}
          onRemove={(email) => setPeople((list) => list.filter((p) => p.email !== email))}
        />

        <div>
          <label htmlFor="split-total" className="label-caps">
            {mode === 'ask' ? 'Total bill' : 'Total to send'}
          </label>
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-4">
            <span className="text-lg font-semibold text-text-muted">KES</span>
            <input
              id="split-total"
              inputMode="numeric"
              value={total}
              onChange={(e) => setTotal(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="0"
              className="h-14 w-full bg-transparent text-2xl font-bold outline-none placeholder:text-text-muted"
            />
          </div>
          {mode === 'pay' && (
            <p className="mt-2 text-right text-xs text-text-muted">
              Balance {formatCurrency(balance)}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="split-note" className="label-caps">What for (optional)</label>
          <input
            id="split-note"
            value={note}
            maxLength={140}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Dinner at Mama Oliech"
            className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
          />
        </div>

        {/* The preview. Rounding is settled on the server by largest
            remainder, so this is "about" by a shilling at most. */}
        {perHead > 0 && people.length >= minPeople && (
          <div className="rounded-xl border border-border bg-surface-2/40 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">
                {mode === 'ask' ? `Split ${heads} ways` : `Split between ${heads}`}
              </span>
              <span className="font-semibold tabular-nums">
                ≈ {formatCurrency(perHead)} each
              </span>
            </div>
            {mode === 'ask' && (
              <div className="mt-1 flex justify-between text-xs">
                <span className="text-text-muted">Your own share stays yours</span>
                <span className="tabular-nums">{formatCurrency(perHead)}</span>
              </div>
            )}
            <div className="mt-2 flex justify-between border-t border-border pt-2">
              <span className="text-text-muted">
                {mode === 'ask' ? "You're asking for" : 'Leaving your wallet'}
              </span>
              <span className="font-bold tabular-nums text-accent">
                {formatCurrency(askingFor)}
              </span>
            </div>
          </div>
        )}

        {mode === 'pay' && numeric > balance && (
          <p role="alert" className="text-sm text-error">Insufficient balance</p>
        )}
        {people.length < minPeople && (
          <p className="text-xs text-text-muted">
            {mode === 'ask'
              ? 'Add at least one other person.'
              : 'Paying one person is an ordinary transfer — use Send for that.'}
          </p>
        )}

        <div className="flex gap-3">
          <Button variant="ghost" fullWidth onClick={onClose}>Cancel</Button>
          <Button fullWidth loading={pending} disabled={!valid} onClick={submit}>
            {mode === 'ask' ? 'Send requests' : 'Pay them'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One row in either list. */
function RequestRow({ request, onApprove, onDecline, onCancel, busy }) {
  const incoming = request.role === 'payer';
  const amount = Number(request.amount.amount);
  const dead = !request.actionable;

  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0">
        <Avatar name={request.counterparty?.name} email={request.counterparty?.email} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {request.counterparty?.name ?? 'Someone'}
          </p>
          <p className="truncate text-xs text-text-muted">
            {request.note || (incoming ? 'asked you for money' : 'you asked for money')} ·{' '}
            {formatRelative(request.createdAt)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn('text-sm font-bold tabular-nums', incoming ? 'text-error' : 'text-success')}>
            {incoming ? '−' : '+'}
            {formatCurrency(amount)}
          </p>
          {dead && (
            <p className="flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-text-muted">
              <Clock className="h-3 w-3" /> {request.state}
            </p>
          )}
        </div>

        {!dead && (
          <div className="flex w-full shrink-0 gap-2 sm:w-auto">
            {incoming ? (
              <>
                <Button size="sm" loading={busy} onClick={() => onApprove(request)}>
                  <Check className="h-4 w-4" /> Pay
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDecline(request)}>
                  Decline
                </Button>
              </>
            ) : (
              <Button size="sm" variant="subtle" onClick={() => onCancel(request)}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export default function Split() {
  const { balance } = useWallet();
  const extras = useWalletExtras();
  const requests = useRequests();
  const [composerOpen, setComposerOpen] = useState(false);
  const [tab, setTab] = useState('incoming');

  const act = async (fn, success) => {
    try {
      const result = await fn();
      toast.success(typeof success === 'function' ? success(result) : success);
    } catch (err) {
      toast.error(err.message || 'That did not go through');
    }
  };

  const rows = tab === 'incoming' ? requests.incoming : requests.outgoing;

  return (
    <>
      <TopBar title="Split" />

      <div className="mx-auto max-w-3xl space-y-5">
        <Card gradientBorder className="p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="label-caps">You&apos;re owed</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-success">
                {formatCurrency(requests.owedToYou)}
              </p>
            </div>
            <div className="min-w-0 text-right">
              <p className="label-caps">You owe</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-error">
                {formatCurrency(requests.youOwe)}
              </p>
            </div>
          </div>
          <Button className="mt-5" onClick={() => setComposerOpen(true)}>
            <Plus className="h-4 w-4" /> Split a bill
          </Button>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex border-b border-border">
            {[
              { id: 'incoming', label: `Asked of you (${requests.incoming.filter((r) => r.actionable).length})` },
              { id: 'outgoing', label: `Your requests (${requests.outgoing.filter((r) => r.actionable).length})` },
            ].map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'min-w-0 flex-1 px-4 py-3 text-sm font-medium transition-colors',
                  tab === id
                    ? 'border-b-2 border-primary text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>

          {requests.listQuery.isLoading && (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 rounded-xl" />
              <Skeleton className="h-12 rounded-xl" />
            </div>
          )}

          {!requests.listQuery.isLoading && rows.length === 0 && (
            <div className="p-10 text-center">
              <Users className="mx-auto h-9 w-9 text-text-muted" />
              <p className="mt-3 text-sm text-text-muted">
                {tab === 'incoming'
                  ? 'Nobody has asked you for money.'
                  : 'You have not asked anyone for money.'}
              </p>
            </div>
          )}

          <AnimatePresence>
            {rows.map((request) => (
              <RequestRow
                key={request.requestId}
                request={request}
                busy={requests.approve.isPending}
                onApprove={(r) =>
                  act(
                    () => requests.approve.mutateAsync(r.requestId),
                    (result) => `${formatCurrency(Number(result.paid.amount))} paid`
                  )
                }
                onDecline={(r) =>
                  act(() => requests.decline.mutateAsync({ requestId: r.requestId }), 'Declined')
                }
                onCancel={(r) =>
                  act(() => requests.cancel.mutateAsync({ requestId: r.requestId }), 'Request withdrawn')
                }
              />
            ))}
          </AnimatePresence>
        </Card>
      </div>

      <Composer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        balance={balance}
        requests={requests}
        extras={extras}
      />
    </>
  );
}
