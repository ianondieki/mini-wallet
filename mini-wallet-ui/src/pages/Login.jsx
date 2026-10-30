import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { ShieldCheck, Lock } from 'lucide-react';
import Background from '../components/ui/Background.jsx';
import Card from '../components/ui/Card.jsx';
import Input from '../components/ui/Input.jsx';
import Button from '../components/ui/Button.jsx';
import logo from '../assets/logo.svg';
import { useAuth } from '../hooks/useAuth.js';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [shake, setShake] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), mode: 'onBlur' });

  const onSubmit = async (values) => {
    try {
      await login(values);
      const to = location.state?.from?.pathname || '/dashboard';
      navigate(to, { replace: true });
    } catch (err) {
      setShake(true);
      setTimeout(() => setShake(false), 500);
      toast.error(err.message || 'We couldn’t sign you in. Check your email and password.');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <Background dotGrid />
      <motion.div
        className="relative z-10 w-full max-w-md"
        animate={shake ? { x: [0, -10, 10, -8, 8, 0] } : { x: 0 }}
        transition={{ duration: 0.45 }}
      >
        <Card
          gradientBorder
          elevated
          className="p-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="mb-7 flex flex-col items-center text-center">
            <img src={logo} alt="" className="mb-3 h-12 w-12" />
            <span className="text-xl font-bold tracking-tight">Mini Wallet</span>
            <h1 className="mt-5 text-lg font-semibold tracking-tight text-text-primary">
              Welcome back
            </h1>
            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-muted">
              Sign in to send money, top up with M-Pesa, and track your balance.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              error={errors.password?.message}
              {...register('password')}
            />

            <div className="flex justify-end">
              <button
                type="button"
                className="text-xs font-medium text-primary transition-colors hover:text-primary-dim"
                onClick={() =>
                  toast('Password reset isn’t available in this demo. Contact support if needed.')
                }
              >
                Forgot password?
              </button>
            </div>

            <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="mt-5 flex items-center justify-center gap-4 text-2xs text-text-muted">
            <span className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" /> Encrypted session
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> Secure refresh tokens
            </span>
          </div>

          <p className="mt-6 text-center text-sm text-text-muted">
            New here?{' '}
            <Link
              to="/register"
              className="font-semibold text-primary transition-colors hover:text-primary-dim"
            >
              Create an account
            </Link>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
