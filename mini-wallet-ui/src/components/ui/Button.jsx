import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const VARIANTS = {
  primary:
    'bg-primary text-bg font-semibold hover:bg-primary-dim shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_8px_20px_-8px_rgba(245,166,35,0.55)]',
  secondary: 'bg-secondary text-white font-semibold hover:bg-secondary/90',
  ghost:
    'bg-white/[0.04] text-text-primary hover:bg-white/[0.08] border border-border hover:border-border-strong',
  danger: 'bg-error/90 text-bg font-semibold hover:bg-error',
  subtle: 'bg-transparent text-text-muted hover:text-text-primary hover:bg-white/[0.04]',
};

const SIZES = {
  sm: 'h-9 min-h-[36px] px-3.5 text-sm',
  md: 'h-11 min-h-[44px] px-5 text-sm',
  lg: 'h-12 min-h-[48px] px-6 text-base',
};

/**
 * Primary button. Forwards arbitrary props (onClick, type, disabled, aria-*).
 * Min heights meet 44px touch targets on md/lg.
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
      whileHover={isDisabled ? undefined : { scale: 1.015 }}
      whileTap={isDisabled ? undefined : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      disabled={isDisabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl transition-colors',
        'disabled:opacity-45 disabled:cursor-not-allowed select-none',
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
