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
      .refine((v) => phoneRegex.test(v.replace(/\s/g, '')), 'Use format 2547XXXXXXXX'),
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
      toast.success('Account created — welcome!');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      toast.error(err.message || 'Registration failed');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <Background dotGrid />
      <motion.div className="relative z-10 w-full max-w-md" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card gradientBorder className="p-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <img src={logo} alt="" className="mb-3 h-12 w-12" />
            <span className="text-xl font-bold tracking-tight">Mini Wallet</span>
            <div className="mt-4 flex items-center gap-1.5">
              <span className="h-1.5 w-6 rounded-full bg-primary" />
              <span className="text-xs text-text-muted">Step 1 of 1</span>
            </div>
            <h1 className="mt-3 text-lg font-semibold">Create your account</h1>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <Input label="Full name" error={errors.name?.message} {...register('name')} />
            <Input label="Email" type="email" error={errors.email?.message} {...register('email')} />
            <Input
              label="Phone"
              error={errors.phone?.message}
              hint="Kenyan number, e.g. 0712345678 or 254712345678"
              {...register('phone')}
            />
            <div>
              <Input
                label="Password"
                type="password"
                error={errors.password?.message}
                {...register('password')}
              />
              <div className="mt-2 flex items-center gap-2">
                <div className="flex flex-1 gap-1">
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
                <span className="w-12 text-right text-xs text-text-muted">{STRENGTH[pwScore]}</span>
              </div>
            </div>
            <Input
              label="Confirm password"
              type="password"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />

            <Button type="submit" fullWidth size="lg" loading={isSubmitting} disabled={!isValid}>
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-primary hover:underline">
              Login
            </Link>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
