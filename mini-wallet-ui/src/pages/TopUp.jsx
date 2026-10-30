import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Smartphone, ShieldCheck, ArrowRight, Info } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Confetti from '../components/ui/Confetti.jsx';
import StepIndicator from '../components/ui/StepIndicator.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useMpesa, useStkStatus } from '../hooks/useMpesa.js';
import { formatCurrency, normalizePhone, cn } from '../lib/utils.js';

const QUICK = [100, 500, 1000, 2000, 5000];
const MIN = 10;
const MAX = 150000;

/** Estimated M-Pesa cost band (illustrative, not charged by this app). */
const feeEstimate = (amount) => {
  if (amount <= 100) return 0;
  if (amount <= 1000) return 13;
  if (amount <= 5000) return 30;
  return 55;
};

function SuccessMark() {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20" role="img" aria-label="Payment successful">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#34d399" strokeWidth="4" className="draw-circle" />
      <path d="M26 41l10 10 18-20" fill="none" stroke="#34d399" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
    </svg>
  );
}

function FailMark() {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20" role="img" aria-label="Payment failed">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#f87171" strokeWidth="4" className="draw-circle" />
      <path d="M30 30l20 20M50 30L30 50" fill="none" stroke="#f87171" strokeWidth="5" strokeLinecap="round" className="draw-check" />
    </svg>
  );
}

export default function TopUp() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { topup, topupMutation } = useMpesa();

  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(user?.phone || '');
  const [error, setError] = useState('');
  const [checkoutId, setCheckoutId] = useState(null);
  const [settled, setSettled] = useState(null);

  const statusQuery = useStkStatus(checkoutId, {
    onSettled: (s) => {
      setSettled(s);
      if (s === 'success') toast.success(`${formatCurrency(Number(amount))} added to your wallet`);
    },
  });

  const numericAmount = Number(amount);
  const fee = feeEstimate(numericAmount);

  const validateStep1 = () => {
    if (!numericAmount || numericAmount < MIN) return setError(`Minimum top-up is KES ${MIN}`), false;
    if (numericAmount > MAX) return setError(`Maximum top-up is KES ${MAX.toLocaleString()}`), false;
    if (!/^(?:\+?254|0)?(?:7|1)\d{8}$/.test(phone.replace(/\s/g, '')))
      return setError('Enter a valid Kenyan phone number'), false;
    setError('');
    return true;
  };

  const goConfirm = () => validateStep1() && setStep(2);

  const sendStk = async () => {
    try {
      const res = await topup({ amount: numericAmount, phone: normalizePhone(phone) });
      setCheckoutId(res.checkoutRequestId);
    } catch (err) {
      toast.error(err.message || 'Couldn’t send the M-Pesa prompt. Try again.');
    }
  };

  const reset = () => {
    setStep(1);
    setCheckoutId(null);
    setSettled(null);
    setAmount('');
  };

  const isPolling = checkoutId && !settled;
  const liveStatus = settled || statusQuery.data?.status || 'pending';

  return (
    <>
      <TopBar
        title="Top up"
        subtitle="Add money from M-Pesa. You’ll confirm with your PIN on your phone."
      />

      <div className="mx-auto max-w-lg">
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
                <label htmlFor="amount" className="label-caps">
                  Amount
                </label>
                <div className="amount-field mt-2">
                  <span className="text-xl font-semibold text-text-muted">KES</span>
                  <input
                    id="amount"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="0"
                    className="w-44 bg-transparent text-center text-4xl font-bold tracking-money outline-none placeholder:text-text-muted/50"
                    aria-label="Top-up amount in KES"
                  />
                </div>

                <div className="mt-4 grid grid-cols-5 gap-2">
                  {QUICK.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setAmount(String(q))}
                      className={cn('chip', Number(amount) === q && 'chip-active')}
                    >
                      {q >= 1000 ? `${q / 1000}k` : q}
                    </button>
                  ))}
                </div>

                <div className="mt-5">
                  <label htmlFor="phone" className="label-caps">
                    M-Pesa phone
                  </label>
                  <input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="07XX XXX XXX"
                    className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-2/80 px-4 text-sm outline-none transition-colors focus:border-primary/50"
                  />
                  <p className="mt-1.5 text-2xs text-text-muted">
                    The STK Push is sent to this number
                  </p>
                </div>

                <div className="mt-5 space-y-2 rounded-xl border border-border bg-surface-2/40 p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">You add</span>
                    <span className="font-semibold tabular-nums">{formatCurrency(numericAmount || 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="inline-flex items-center gap-1 text-text-muted">
                      Est. M-Pesa fee
                      <Info className="h-3 w-3" aria-hidden="true" />
                    </span>
                    <span className="font-medium tabular-nums text-text-secondary">
                      {formatCurrency(fee)}
                    </span>
                  </div>
                  <p className="pt-1 text-2xs leading-relaxed text-text-muted">
                    Fee is charged by Safaricom, not Mini Wallet. Actual fee may vary.
                  </p>
                </div>

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
                {!checkoutId && (
                  <>
                    <p className="mb-4 text-sm text-text-muted">
                      Review the details, then confirm. You’ll get a PIN prompt on your phone.
                    </p>
                    <div className="space-y-2.5 text-sm">
                      <Row label="Amount" value={formatCurrency(numericAmount)} />
                      <Row label="Phone" value={normalizePhone(phone)} mono />
                      <div className="my-2 h-px bg-border" />
                      <Row label="Credited to wallet" value={formatCurrency(numericAmount)} strong />
                    </div>
                    <div className="callout-success mt-4">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>Secure payment via Safaricom M-Pesa STK Push</span>
                    </div>
                    <Button
                      fullWidth
                      size="lg"
                      className="mt-5"
                      loading={topupMutation.isPending}
                      onClick={sendStk}
                    >
                      {topupMutation.isPending ? 'Sending prompt…' : 'Send M-Pesa prompt'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="mt-3 w-full py-2 text-center text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
                    >
                      Edit amount or phone
                    </button>
                  </>
                )}

                {isPolling && (
                  <div className="flex flex-col items-center py-8 text-center">
                    <div className="relative flex h-24 w-24 items-center justify-center">
                      <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-border border-t-primary" />
                      <Smartphone className="h-9 w-9 text-primary" />
                    </div>
                    <p className="mt-5 text-base font-semibold capitalize text-text-primary">
                      Waiting for PIN…
                    </p>
                    <p className="mt-2 max-w-xs text-sm leading-relaxed text-text-muted">
                      Open the M-Pesa prompt on {normalizePhone(phone)} and enter your PIN to finish.
                      This usually takes a few seconds.
                    </p>
                    <p className="mt-4 text-2xs uppercase tracking-wider text-text-muted">
                      Status: {liveStatus}
                    </p>
                  </div>
                )}

                {settled === 'success' && (
                  <div className="relative flex flex-col items-center py-8 text-center">
                    <Confetti />
                    <SuccessMark />
                    <p className="mt-4 text-lg font-semibold">Top-up complete</p>
                    <p className="mt-1.5 text-sm text-text-muted">
                      {formatCurrency(numericAmount)} is now in your wallet.
                    </p>
                    <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
                      <Button fullWidth onClick={() => navigate('/dashboard')}>
                        Go to Home
                      </Button>
                      <Button fullWidth variant="ghost" onClick={reset}>
                        Top up again
                      </Button>
                    </div>
                  </div>
                )}

                {settled === 'failed' && (
                  <div className="flex flex-col items-center py-8 text-center">
                    <FailMark />
                    <p className="mt-4 text-lg font-semibold">Payment didn’t go through</p>
                    <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-muted">
                      {statusQuery.data?.resultDesc ||
                        'The M-Pesa request was cancelled or timed out. No money left your phone.'}
                    </p>
                    <Button variant="ghost" className="mt-6" onClick={reset}>
                      Try again
                    </Button>
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
          strong ? 'text-base font-semibold text-text-primary' : 'font-medium',
          mono && 'font-mono text-xs tracking-wide'
        )}
      >
        {value}
      </span>
    </div>
  );
}
