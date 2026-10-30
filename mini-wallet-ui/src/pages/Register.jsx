import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import Background from '../components/ui/Background.jsx';
import Card from '../components/ui/Card.jsx';
import Input from '../components/ui/Input.jsx';
import Button from '../components/ui/Button.jsx';
import logo from '../assets/logo.svg';
import { useAuth } from '../hooks/useAuth.js';
import { normalizePhone, passwordStrength, cn } from '../lib/utils.js';

const phoneRegex = /^(?:\+?254|0)?(?:7|1)\d{8}$/;

const schema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Enter a valid email'),
    phone: z
      .string()
      .refine((v) => phoneRegex.test(v.replace(/\s/g, '')), 'Use a Kenyan number, e.g. 07XX XXX XXX'),
    password: z
      .string()
      .min(8, 'At least 8 characters')
      .regex(/[a-z]/, 'Add a lowercase letter')
      .regex(/[A-Z]/, 'Add an uppercase letter')
      .regex(/\d/, 'Add a number'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

const STRENGTH = ['', 'Weak', 'Fair', 'Good', 'Strong'];
const STRENGTH_COLOR = ['bg-white/10', 'bg-error', 'bg-warning', 'bg-accent', 'bg-success'];

export default function Register() {
  const navigate = useNavigate();
  const { register: registerUser } = useAuth();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), mode: 'onChange' });

  const pwScore = passwordStrength(watch('password') || '');

  const onSubmit = async (values) => {
    try {
      await registerUser({
        name: values.name,
        email: values.email,
        phone: normalizePhone(values.phone),
        password: values.password,
      });
      toast.success('You’re in — wallet ready to go.');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      toast.error(err.message || 'We couldn’t create your account. Try again.');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 py-10">
      <Background dotGrid />
      <motion.div
        className="relative z-10 w-full max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card gradientBorder elevated className="p-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <img src={logo} alt="" className="mb-3 h-12 w-12" />
            <span className="text-xl font-bold tracking-tight">Mini Wallet</span>
            <h1 className="mt-5 text-lg font-semibold tracking-tight">Create your account</h1>
            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-muted">
              One wallet for M-Pesa top-ups, peer transfers, and withdrawals.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <Input label="Full name" autoComplete="name" error={errors.name?.message} {...register('name')} />
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Phone"
              type="tel"
              autoComplete="tel"
              error={errors.phone?.message}
              hint="Kenyan mobile — used for M-Pesa top-ups and cash-outs"
              {...register('phone')}
            />
            <div>
              <Input
                label="Password"
                type="password"
                autoComplete="new-password"
                error={errors.password?.message}
                {...register('password')}
              />
              <div className="mt-2.5 flex items-center gap-2 px-0.5">
                <div className="flex flex-1 gap-1" role="meter" aria-label="Password strength" aria-valuenow={pwScore} aria-valuemin={0} aria-valuemax={4}>
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        'h-1.5 flex-1 rounded-full transition-colors',
                        i < pwScore ? STRENGTH_COLOR[pwScore] : 'bg-white/10'
                      )}
                    />
                  ))}
                </div>
                <span className="w-12 text-right text-2xs font-medium text-text-muted">
                  {STRENGTH[pwScore]}
                </span>
              </div>
            </div>
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />

            <Button type="submit" fullWidth size="lg" loading={isSubmitting} disabled={!isValid}>
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-5 text-center text-2xs leading-relaxed text-text-muted">
            By continuing you agree to use this wallet responsibly. Your session is protected with
            short-lived access tokens.
          </p>

          <p className="mt-4 text-center text-sm text-text-muted">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-semibold text-primary transition-colors hover:text-primary-dim"
            >
              Sign in
            </Link>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
