import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Banknote, ShieldCheck, ArrowRight, Clock } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useWallet } from '../hooks/useWallet.js';
import { useMpesa } from '../hooks/useMpesa.js';
import { formatCurrency, normalizePhone } from '../lib/utils.js';

const MIN = 10;
const MAX = 150000;
const PHONE_RE = /^(?:\+?254|0)?(?:7|1)\d{8}$/;

function SuccessMark() {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20" role="img" aria-label="Withdrawal initiated">
      <circle cx="40" cy="40" r="36" fill="none" stroke="#10b981" strokeWidth="4" className="draw-circle" />
      <path d="M26 41l10 10 18-20" fill="none" stroke="#10b981" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
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

  // Quick-fill by share of balance.
  const quick = [0.25, 0.5, 1].map((f) => Math.floor(balance * f)).filter((v) => v >= MIN);

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
      toast.success('Withdrawal initiated');
    } catch (err) {
      // Surface the backend's reason (insufficient funds, B2C failure, etc.).
      toast.error(err.message || 'Withdrawal failed');
      setError(err.message || 'Withdrawal failed');
      setStep(1);
    }
  };

  return (
    <>
      <TopBar title="Withdraw" />

      <div className="mx-auto max-w-lg">
        {/* Balance banner */}
        <Card className="mb-6 flex items-center justify-between p-4">
          <span className="label-caps">Available balance</span>
          {balanceQuery.isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : (
            <span className="text-lg font-bold tabular-nums">{formatCurrency(balance)}</span>
          )}
        </Card>

        <div className="mb-6 flex items-center justify-center gap-2 text-xs text-text-muted">
          <span className={step >= 1 ? 'text-primary' : ''}>1 · Details</span>
          <span className="h-px w-8 bg-border" />
          <span className={step >= 2 ? 'text-primary' : ''}>2 · Confirm</span>
        </div>

        <AnimatePresence mode="wait">
          {/* ── STEP 1 ── */}
          {step === 1 && (
            <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Card gradientBorder className="p-6">
                <label htmlFor="wamount" className="label-caps">Amount to withdraw</label>
                <div
                  className={`mt-2 flex items-center justify-center gap-2 rounded-2xl border bg-surface-2/60 py-6 ${
                    overBalance ? 'border-error/60' : 'border-border'
                  }`}
                >
                  <span className="text-2xl font-semibold text-text-muted">KES</span>
                  <input
                    id="wamount"
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="0"
                    className="w-40 bg-transparent text-center text-4xl font-bold tracking-tight outline-none placeholder:text-text-muted"
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
                            className="rounded-xl border border-border bg-surface-2/60 py-2 text-sm font-medium text-text-muted transition-colors hover:border-primary/50 hover:text-primary"
                          >
                            {label}
                          </button>
                        ) : null
                    )}
                  </div>
                )}

                <div className="mt-5">
                  <label htmlFor="wphone" className="label-caps">M-Pesa phone</label>
                  <input
                    id="wphone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="2547XXXXXXXX"
                    className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-2/60 px-4 text-sm outline-none focus:border-primary/50"
                  />
                </div>

                <div className="mt-5 rounded-xl border border-border bg-surface-2/40 p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Withdrawal</span>
                    <span className="font-medium">{formatCurrency(numericAmount || 0)}</span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-text-muted">Balance after</span>
                    <span className={`font-medium ${overBalance ? 'text-error' : ''}`}>
                      {formatCurrency(Math.max(0, balance - (numericAmount || 0)))}
                    </span>
                  </div>
                </div>

                {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}

                <Button fullWidth size="lg" className="mt-5" onClick={goConfirm}>
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </Card>
            </motion.div>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Card gradientBorder className="relative overflow-hidden p-6">
                {!done ? (
                  <>
                    <div className="space-y-2 text-sm">
                      <Row label="Amount" value={formatCurrency(numericAmount)} />
                      <Row label="To phone" value={normalizePhone(phone)} />
                      <div className="my-2 h-px bg-border" />
                      <Row label="Balance after" value={formatCurrency(balance - numericAmount)} strong />
                    </div>
                    <div className="mt-4 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-xs text-primary">
                      <ShieldCheck className="h-4 w-4" /> Funds are sent to your M-Pesa via Safaricom B2C
                    </div>
                    <Button fullWidth size="lg" className="mt-5" loading={withdrawMutation.isPending} onClick={submit}>
                      {withdrawMutation.isPending ? 'Processing…' : 'Confirm Withdrawal'}
                    </Button>
                    <button type="button" onClick={() => setStep(1)} className="mt-3 w-full text-center text-xs text-text-muted hover:text-text-primary">
                      Back to details
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col items-center py-6 text-center">
                    <SuccessMark />
                    <p className="mt-4 text-lg font-semibold">Withdrawal initiated</p>
                    <p className="mt-1 max-w-xs text-sm text-text-muted">
                      {formatCurrency(numericAmount)} is on its way to {normalizePhone(phone)}. Your
                      balance has been debited; M-Pesa confirms the payout shortly.
                    </p>
                    <div className="mt-4 flex items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1 text-xs text-warning">
                      <Clock className="h-3.5 w-3.5" /> Processing via M-Pesa
                    </div>
                    <Button className="mt-6" onClick={() => navigate('/transactions')}>
                      View Transactions
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
