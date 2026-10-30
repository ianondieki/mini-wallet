import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { ShieldCheck, ArrowRight, Clock, AlertTriangle } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import StepIndicator from '../components/ui/StepIndicator.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useWallet } from '../hooks/useWallet.js';
import { useMpesa } from '../hooks/useMpesa.js';
import { formatCurrency, normalizePhone, cn } from '../lib/utils.js';

const MIN = 10;
const MAX = 150000;
const PHONE_RE = /^(?:\+?254|0)?(?:7|1)\d{8}$/;

function SuccessMark() {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20" role="img" aria-label="Withdrawal initiated">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#34d399" strokeWidth="4" className="draw-circle" />
      <path d="M26 41l10 10 18-20" fill="none" stroke="#34d399" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
    </svg>
  );
}

export default function Withdraw() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { balance, balanceQuery } = useWallet();
  const { withdraw, withdrawMutation } = useMpesa();

  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(user?.phone || '');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const numericAmount = Number(amount);
  const cleanedPhone = phone.replace(/\s/g, '');
  const overBalance = numericAmount > balance;

  const quick = [0.25, 0.5, 1]
    .map((f) => Math.floor(balance * f))
    .filter((v) => v >= MIN);

  const validateStep1 = () => {
    if (!numericAmount || numericAmount < MIN) {
      setError(`Minimum withdrawal is KES ${MIN}`);
      return false;
    }
    if (numericAmount > MAX) {
      setError(`Maximum withdrawal is KES ${MAX.toLocaleString()}`);
      return false;
    }
    if (overBalance) {
      setError(`That exceeds your balance of ${formatCurrency(balance)}`);
      return false;
    }
    if (!PHONE_RE.test(cleanedPhone)) {
      setError('Enter a valid Kenyan phone number');
      return false;
    }
    setError('');
    return true;
  };

  const goConfirm = () => validateStep1() && setStep(2);

  const submit = async () => {
    try {
      await withdraw({ amount: numericAmount, phone: normalizePhone(phone) });
      setDone(true);
      toast.success('Withdrawal started — check M-Pesa shortly');
    } catch (err) {
      toast.error(err.message || 'Withdrawal failed');
      setError(err.message || 'Withdrawal failed');
      setStep(1);
    }
  };

  return (
    <>
      <TopBar
        title="Withdraw"
        subtitle="Cash out to M-Pesa. Your wallet is debited first, then Safaricom pays out."
      />

      <div className="mx-auto max-w-lg">
        <Card className="mb-6 flex items-center justify-between gap-4 p-4">
          <div>
            <span className="label-caps">Available to withdraw</span>
            <p className="mt-0.5 text-2xs text-text-muted">After successful top-ups & transfers</p>
          </div>
          {balanceQuery.isLoading ? (
            <Skeleton className="h-7 w-28" />
          ) : (
            <span className="text-xl font-bold tabular-nums tracking-money">
              {formatCurrency(balance)}
            </span>
          )}
        </Card>

        <StepIndicator steps={['Amount', 'Confirm']} current={step} />

        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
            >
              <Card gradientBorder className="p-6">
                <label htmlFor="wamount" className="label-caps">
                  Amount to withdraw
                </label>
                <div
                  className={cn(
                    'amount-field mt-2',
                    overBalance && 'border-error/50'
                  )}
                >
                  <span className="text-xl font-semibold text-text-muted">KES</span>
                  <input
                    id="wamount"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="0"
                    className="w-44 bg-transparent text-center text-4xl font-bold tracking-money outline-none placeholder:text-text-muted/50"
                    aria-label="Withdrawal amount in KES"
                  />
                </div>

                {quick.length > 0 && (
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {[['25%', quick[0]], ['50%', quick[1]], ['Max', quick[2]]].map(
                      ([label, val]) =>
                        val ? (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setAmount(String(val))}
                            className={cn('chip', Number(amount) === val && 'chip-active')}
                          >
                            {label}
                          </button>
                        ) : null
                    )}
                  </div>
                )}

                <div className="mt-5">
                  <label htmlFor="wphone" className="label-caps">
                    M-Pesa phone
                  </label>
                  <input
                    id="wphone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="07XX XXX XXX"
                    className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-2/80 px-4 text-sm outline-none transition-colors focus:border-primary/50"
                  />
                </div>

                <div className="mt-5 space-y-2 rounded-xl border border-border bg-surface-2/40 p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">You’ll receive</span>
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(numericAmount || 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Balance after</span>
                    <span
                      className={cn(
                        'font-medium tabular-nums',
                        overBalance && 'text-error'
                      )}
                    >
                      {formatCurrency(Math.max(0, balance - (numericAmount || 0)))}
                    </span>
                  </div>
                </div>

                {overBalance && numericAmount > 0 && (
                  <div className="callout-warning mt-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Amount is higher than your available balance.</span>
                  </div>
                )}

                {error && (
                  <p role="alert" className="mt-3 text-sm text-error">
                    {error}
                  </p>
                )}

                <Button fullWidth size="lg" className="mt-5" onClick={goConfirm}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </Card>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
            >
              <Card gradientBorder className="relative overflow-hidden p-6">
                {!done ? (
                  <>
                    <p className="mb-4 text-sm leading-relaxed text-text-muted">
                      Confirm to debit your wallet and send cash to M-Pesa. Payouts usually arrive
                      within a minute.
                    </p>
                    <div className="space-y-2.5 text-sm">
                      <Row label="Amount" value={formatCurrency(numericAmount)} />
                      <Row label="To phone" value={normalizePhone(phone)} mono />
                      <div className="my-2 h-px bg-border" />
                      <Row
                        label="Balance after"
                        value={formatCurrency(balance - numericAmount)}
                        strong
                      />
                    </div>
                    <div className="callout-primary mt-4">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>Paid out via Safaricom B2C. Failed payouts reverse automatically.</span>
                    </div>
                    <Button
                      fullWidth
                      size="lg"
                      className="mt-5"
                      loading={withdrawMutation.isPending}
                      onClick={submit}
                    >
                      {withdrawMutation.isPending ? 'Processing…' : 'Confirm withdrawal'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="mt-3 w-full py-2 text-center text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
                    >
                      Edit amount or phone
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col items-center py-8 text-center">
                    <SuccessMark />
                    <p className="mt-4 text-lg font-semibold">Withdrawal started</p>
                    <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-muted">
                      {formatCurrency(numericAmount)} is on its way to {normalizePhone(phone)}. Your
                      wallet is already debited; M-Pesa will confirm the payout shortly.
                    </p>
                    <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1.5 text-2xs font-semibold text-warning">
                      <Clock className="h-3.5 w-3.5" /> Processing via M-Pesa
                    </div>
                    <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
                      <Button fullWidth onClick={() => navigate('/transactions')}>
                        View activity
                      </Button>
                      <Button fullWidth variant="ghost" onClick={() => navigate('/dashboard')}>
                        Go to Home
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function Row({ label, value, strong, mono }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-text-muted">{label}</span>
      <span
        className={cn(
          'text-right tabular-nums',
          strong ? 'text-base font-semibold' : 'font-medium',
          mono && 'font-mono text-xs tracking-wide'
        )}
      >
        {value}
      </span>
    </div>
  );
}
