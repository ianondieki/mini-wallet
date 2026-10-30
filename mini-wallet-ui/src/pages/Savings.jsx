import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { PiggyBank, Lock, Plus, ArrowDownLeft, ArrowUpRight, Trash2, Target } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Modal from '../components/ui/Modal.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import { useSavings, useWithdrawalQuote } from '../hooks/useSavings.js';
import { formatCurrency, formatDate, cn } from '../lib/utils.js';

const QUICK = [500, 1000, 2500, 5000];

/** Thin progress bar for a goal with a target. */
function Progress({ bps }) {
  const pct = Math.min(100, (bps ?? 0) / 100);
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
      <motion.div
        className="h-full rounded-full bg-primary"
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
    </div>
  );
}

/** Create-a-goal form. A goal starts empty, so this moves no money. */
function NewGoal({ open, onClose, onCreate, pending }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [lockDays, setLockDays] = useState(0);
  const [penaltyBps, setPenaltyBps] = useState(0);

  const submit = async () => {
    const lock =
      lockDays > 0
        ? {
            until: new Date(Date.now() + lockDays * 86_400_000).toISOString(),
            penaltyBps: Number(penaltyBps),
          }
        : undefined;
    await onCreate({
      name: name.trim(),
      target: target ? Number(target) : undefined,
      deadline: deadline || undefined,
      lock,
    });
    setName('');
    setTarget('');
    setDeadline('');
    setLockDays(0);
    setPenaltyBps(0);
  };

  return (
    <Modal open={open} onClose={onClose} title="New savings goal">
      <div className="space-y-4">
        <div>
          <label htmlFor="goal-name" className="label-caps">What are you saving for?</label>
          <input
            id="goal-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rent, school fees, a new phone…"
            className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label htmlFor="goal-target" className="label-caps">Target (optional)</label>
            <input
              id="goal-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="50000"
              className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="goal-deadline" className="label-caps">By when (optional)</label>
            <input
              id="goal-deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
            />
          </div>
        </div>

        {/* The commitment device. Opt-in, and capped at 20% by the server. */}
        <div className="rounded-xl border border-border bg-surface-2/40 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4 text-primary" /> Stop me raiding it
          </p>
          <p className="mt-1 text-xs text-text-muted">
            A promise to your future self. Taking money out before the lock
            expires costs a fee you set now — so make it hurt just enough.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="min-w-0 text-xs text-text-muted">
              Lock for
              <select
                value={lockDays}
                onChange={(e) => setLockDays(Number(e.target.value))}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-text-primary outline-none"
              >
                <option value={0}>No lock</option>
                <option value={30}>30 days</option>
                <option value={90}>3 months</option>
                <option value={180}>6 months</option>
                <option value={365}>1 year</option>
              </select>
            </label>
            <label className="min-w-0 text-xs text-text-muted">
              Early-exit fee
              <select
                value={penaltyBps}
                disabled={lockDays === 0}
                onChange={(e) => setPenaltyBps(Number(e.target.value))}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-text-primary outline-none disabled:opacity-40"
              >
                <option value={0}>None</option>
                <option value={100}>1%</option>
                <option value={250}>2.5%</option>
                <option value={500}>5%</option>
                <option value={1000}>10%</option>
              </select>
            </label>
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="ghost" fullWidth onClick={onClose}>Cancel</Button>
          <Button fullWidth loading={pending} disabled={!name.trim()} onClick={submit}>
            Create goal
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Move money in or out of a goal.
 *
 * On the way out of a locked goal the penalty is quoted by the server and
 * echoed back on submit, so a quote that has gone stale is refused rather
 * than quietly repriced.
 */
function MoveMoney({ goal, mode, onClose, savings, spendable }) {
  const [amount, setAmount] = useState('');
  const key = useRef(uuidv4());
  const numeric = Number(amount);
  const quote = useWithdrawalQuote(mode === 'out' ? goal?.goalId : null, numeric);

  if (!goal) return null;
  const saved = Number(goal.saved.amount);
  const ceiling = mode === 'in' ? spendable : saved;
  const valid = numeric >= 1 && numeric <= ceiling;
  const pending = savings.contribute.isPending || savings.withdraw.isPending;
  const penalty = Number(quote.data?.penalty?.amount ?? 0);

  const submit = async () => {
    try {
      if (mode === 'in') {
        await savings.contribute.mutateAsync({
          goalId: goal.goalId,
          amount: numeric,
          idempotencyKey: key.current,
        });
        toast.success(`${formatCurrency(numeric)} set aside for ${goal.name}`);
      } else {
        const result = await savings.withdraw.mutateAsync({
          goalId: goal.goalId,
          amount: numeric,
          // Absent when nothing is owed, so an unlocked goal does not have to
          // round-trip a zero just to prove it.
          confirmPenalty: quote.data ? penalty : undefined,
          idempotencyKey: key.current,
        });
        const received = Number(result.received.amount);
        toast.success(
          penalty > 0
            ? `${formatCurrency(received)} released, ${formatCurrency(penalty)} early-exit fee`
            : `${formatCurrency(received)} back in your wallet`
        );
      }
      key.current = uuidv4();
      setAmount('');
      onClose();
    } catch (err) {
      toast.error(err.message || 'That did not go through');
    }
  };

  return (
    <Modal open={Boolean(goal)} onClose={onClose} title={mode === 'in' ? `Add to ${goal.name}` : `Take from ${goal.name}`}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-4">
          <span className="text-lg font-semibold text-text-muted">KES</span>
          <input
            inputMode="numeric"
            aria-label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="0"
            className="h-14 w-full bg-transparent text-2xl font-bold outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {QUICK.filter((q) => q <= ceiling).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setAmount(String(q))}
                className="rounded-lg border border-border bg-surface-2/60 px-3 py-1 text-xs text-text-muted hover:text-primary"
              >
                {q >= 1000 ? `${q / 1000}k` : q}
              </button>
            ))}
          </div>
          <span className="text-xs text-text-muted">
            {mode === 'in' ? 'Spendable' : 'In this goal'} {formatCurrency(ceiling)}
          </span>
        </div>

        {mode === 'out' && quote.data?.early && numeric > 0 && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <Lock className="h-4 w-4" /> This goal is locked until {formatDate(quote.data.lockedUntil)}
            </p>
            <div className="mt-2 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-text-muted">Early-exit fee ({quote.data.penaltyBps / 100}%)</span>
                <span className="font-semibold">−{formatCurrency(penalty)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">You receive</span>
                <span className="font-semibold text-accent">
                  {formatCurrency(Number(quote.data.youReceive.amount))}
                </span>
              </div>
            </div>
          </div>
        )}

        {numeric > ceiling && (
          <p role="alert" className="text-sm text-error">
            {mode === 'in' ? 'More than you have to spare' : 'More than this goal holds'}
          </p>
        )}

        <div className="flex gap-3">
          <Button variant="ghost" fullWidth onClick={onClose}>Cancel</Button>
          <Button fullWidth loading={pending} disabled={!valid} onClick={submit}>
            {mode === 'in' ? 'Set aside' : 'Withdraw'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Savings() {
  const savings = useSavings();
  const [newOpen, setNewOpen] = useState(false);
  const [moving, setMoving] = useState({ goal: null, mode: 'in' });

  const create = async (body) => {
    try {
      await savings.createGoal.mutateAsync(body);
      toast.success('Goal created');
      setNewOpen(false);
    } catch (err) {
      toast.error(err.message || 'Could not create that goal');
    }
  };

  const close = async (goal) => {
    try {
      await savings.closeGoal.mutateAsync(goal.goalId);
      toast.success(`${goal.name} closed`);
    } catch (err) {
      toast.error(err.message || 'Could not close that goal');
    }
  };

  return (
    <>
      <TopBar title="Savings" />

      <div className="mx-auto max-w-3xl space-y-5">
        {/* Saved vs spendable: the whole point of a vault is that these are
            two different numbers, so they are shown together. */}
        <Card gradientBorder className="p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="label-caps">Set aside</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-primary">
                {formatCurrency(savings.totalSaved)}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Held in {savings.goals.length} {savings.goals.length === 1 ? 'goal' : 'goals'} ·
                not spendable until you move it back
              </p>
            </div>
            <div className="min-w-0 text-right">
              <p className="label-caps">Spendable</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatCurrency(savings.spendable)}
              </p>
            </div>
          </div>
          <Button className="mt-5" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New goal
          </Button>
        </Card>

        {savings.goalsQuery.isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        )}

        {!savings.goalsQuery.isLoading && savings.goals.length === 0 && (
          <Card className="p-10 text-center">
            <PiggyBank className="mx-auto h-10 w-10 text-text-muted" />
            <p className="mt-3 font-medium">Nothing set aside yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-text-muted">
              A goal is a pocket inside your wallet. Money you move into one
              stops being spendable, which is the point.
            </p>
          </Card>
        )}

        <AnimatePresence>
          {savings.goals.map((goal) => {
            const saved = Number(goal.saved.amount);
            const target = goal.target ? Number(goal.target.amount) : null;
            return (
              <motion.div
                key={goal.goalId}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <Card hoverGlow className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold">
                        <span className="truncate">{goal.name}</span>
                        {goal.locked && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
                            <Lock className="h-3 w-3" /> {goal.breakPenaltyBps / 100}% to break
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-2xl font-bold tabular-nums">
                        {formatCurrency(saved)}
                        {target && (
                          <span className="ml-2 text-sm font-normal text-text-muted">
                            of {formatCurrency(target)}
                          </span>
                        )}
                      </p>
                      {goal.deadline && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                          <Target className="h-3 w-3" /> by {formatDate(goal.deadline)}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" onClick={() => setMoving({ goal, mode: 'in' })}>
                        <ArrowDownLeft className="h-4 w-4" /> Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saved <= 0}
                        onClick={() => setMoving({ goal, mode: 'out' })}
                      >
                        <ArrowUpRight className="h-4 w-4" /> Take out
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        aria-label={`Close ${goal.name}`}
                        onClick={() => close(goal)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {target && (
                    <>
                      <Progress bps={goal.progressBps} />
                      <p className="mt-2 text-xs text-text-muted">
                        {(goal.progressBps / 100).toFixed(1)}% there ·{' '}
                        {formatCurrency(Number(goal.remaining.amount))} to go
                      </p>
                    </>
                  )}
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <NewGoal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={create}
        pending={savings.createGoal.isPending}
      />
      <MoveMoney
        goal={moving.goal}
        mode={moving.mode}
        spendable={savings.spendable}
        savings={savings}
        onClose={() => setMoving({ goal: null, mode: 'in' })}
      />
    </>
  );
}
