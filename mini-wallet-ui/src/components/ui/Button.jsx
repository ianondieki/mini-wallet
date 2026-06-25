import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const VARIANTS = {
  primary:
    'bg-primary text-bg font-semibold hover:bg-primary-dim shadow-[0_0_24px_-6px_rgba(245,166,35,0.6)]',
  secondary: 'bg-secondary text-white font-semibold hover:bg-secondary/90',
  ghost: 'bg-white/5 text-text-primary hover:bg-white/10 border border-border',
  danger: 'bg-error/90 text-white font-semibold hover:bg-error',
  subtle: 'bg-transparent text-text-muted hover:text-text-primary',
};

const SIZES = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-12 px-6 text-base',
};

/**
 * Primary button. Forwards arbitrary props (onClick, type, disabled, aria-*).
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  className,
  ...props
}) {
  const isDisabled = disabled || loading;
  return (
    <motion.button
      whileHover={isDisabled ? undefined : { scale: 1.02 }}
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      disabled={isDisabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed select-none',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </motion.button>
  );
}
