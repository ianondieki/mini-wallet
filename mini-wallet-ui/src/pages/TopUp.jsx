import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Smartphone, ShieldCheck, ArrowRight } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Confetti from '../components/ui/Confetti.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useMpesa, useStkStatus } from '../hooks/useMpesa.js';
import { formatCurrency, normalizePhone } from '../lib/utils.js';

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
      <circle cx="40" cy="40" r="36" fill="none" stroke="#10b981" strokeWidth="4" className="draw-circle" />
      <path d="M26 41l10 10 18-20" fill="none" stroke="#10b981" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
    </svg>
  );
}

function FailMark() {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20" role="img" aria-label="Payment failed">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#ef4444" strokeWidth="4" className="draw-circle" />
      <path d="M30 30l20 20M50 30L30 50" fill="none" stroke="#ef4444" strokeWidth="5" strokeLinecap="round" className="draw-check" />
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
  const [settled, setSettled] = useState(null); // 'success' | 'failed'

  const statusQuery = useStkStatus(checkoutId, {
    onSettled: (s) => {
      setSettled(s);
      if (s === 'success') toast.success(`${formatCurrency(Number(amount))} added to your wallet!`);
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
      toast.error(err.message || 'Failed to send STK push');
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
      <TopBar title="Top Up" />

      <div className="mx-auto max-w-lg">
        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2 text-xs text-text-muted">
          <span className={step >= 1 ? 'text-primary' : ''}>1 · Details</span>
          <span className="h-px w-8 bg-border" />
          <span className={step >= 2 ? 'text-primary' : ''}>2 · Confirm</span>
        </div>

        <AnimatePresence mode="wait">
          {/* ── STEP 1 ─────────────────────────────────────────────── */}
          {step === 1 && (
            <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Card gradientBorder className="p-6">
                <label htmlFor="amount" className="label-caps">Amount</label>
                <div className="mt-2 flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface-2/60 py-6">
                  <span className="text-2xl font-semibold text-text-muted">KES</span>
                  <input
                    id="amount"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="0"
                    className="w-40 bg-transparent text-center text-4xl font-bold tracking-tight outline-none placeholder:text-text-muted"
                    aria-label="Top-up amount in KES"
                  />
                </div>

                <div className="mt-4 grid grid-cols-5 gap-2">
                  {QUICK.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setAmount(String(q))}
                      className="rounded-xl border border-border bg-surface-2/60 py-2 text-sm font-medium text-text-muted transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      {q >= 1000 ? `${q / 1000}k` : q}
                    </button>
                  ))}
                </div>

                <div className="mt-5">
                  <label htmlFor="phone" className="label-caps">M-Pesa phone</label>
                  <input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="2547XXXXXXXX"
                    className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
                  />
                </div>

                <div className="mt-5 rounded-xl border border-border bg-surface-2/40 p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Amount</span>
                    <span className="font-medium">{formatCurrency(numericAmount || 0)}</span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-text-muted">Est. M-Pesa fee</span>
                    <span className="font-medium">{formatCurrency(fee)}</span>
                  </div>
                </div>

                {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}

                <Button fullWidth size="lg" className="mt-5" onClick={goConfirm}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </Card>
            </motion.div>
          )}

          {/* ── STEP 2 ─────────────────────────────────────────────── */}
          {step === 2 && (
            <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Card gradientBorder className="relative overflow-hidden p-6">
                {/* Idle / confirm */}
                {!checkoutId && (
                  <>
                    <div className="space-y-2 text-sm">
                      <Row label="Amount" value={formatCurrency(numericAmount)} />
                      <Row label="Phone" value={normalizePhone(phone)} />
                      <div className="my-2 h-px bg-border" />
                      <Row label="Total" value={formatCurrency(numericAmount)} strong />
                    </div>
                    <div className="mt-4 flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-xs text-success">
                      <ShieldCheck className="h-4 w-4" /> Secure payment via Safaricom M-Pesa
                    </div>
                    <Button fullWidth size="lg" className="mt-5" loading={topupMutation.isPending} onClick={sendStk}>
                      {topupMutation.isPending ? 'Sending prompt…' : 'Confirm & Send STK Push'}
                    </Button>
                    <button type="button" onClick={() => setStep(1)} className="mt-3 w-full text-center text-xs text-text-muted hover:text-text-primary">
                      Back to details
                    </button>
                  </>
                )}

                {/* Polling */}
                {isPolling && (
                  <div className="flex flex-col items-center py-6 text-center">
                    <div className="relative flex h-24 w-24 items-center justify-center">
                      <span className="absolute inset-0 animate-spin rounded-full border-4 border-border border-t-primary" />
                      <Smartphone className="h-10 w-10 text-primary" />
                    </div>
                    <p className="mt-5 font-medium capitalize">{liveStatus}…</p>
                    <p className="mt-1 max-w-xs text-sm text-text-muted">
                      Check your phone for the M-Pesa PIN prompt and enter your PIN to complete the top-up.
                    </p>
                  </div>
                )}

                {/* Success */}
                {settled === 'success' && (
                  <div className="relative flex flex-col items-center py-6 text-center">
                    <Confetti />
                    <SuccessMark />
                    <p className="mt-4 text-lg font-semibold">Top-up complete</p>
                    <p className="mt-1 text-sm text-text-muted">
                      {formatCurrency(numericAmount)} added to your wallet.
                    </p>
                    <Button className="mt-6" onClick={() => navigate('/dashboard')}>
                      Back to Dashboard
                    </Button>
                  </div>
                )}

                {/* Failure */}
                {settled === 'failed' && (
                  <div className="flex flex-col items-center py-6 text-center">
                    <FailMark />
                    <p className="mt-4 text-lg font-semibold">Payment failed</p>
                    <p className="mt-1 text-sm text-text-muted">
                      {statusQuery.data?.resultDesc || 'The transaction was not completed.'}
                    </p>
                    <Button variant="ghost" className="mt-6" onClick={reset}>
                      Try Again
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

function Row({ label, value, strong }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className={strong ? 'text-base font-semibold' : 'font-medium'}>{value}</span>
    </div>
  );
}
