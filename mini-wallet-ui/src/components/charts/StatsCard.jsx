import { motion } from 'framer-motion';
import Card from '../ui/Card.jsx';
import AnimatedNumber from '../ui/AnimatedNumber.jsx';
import { cn, formatCurrency } from '../../lib/utils.js';

const TINTS = {
  red: 'text-error bg-error/10',
  green: 'text-success bg-success/10',
  purple: 'text-secondary bg-secondary/10',
  gold: 'text-primary bg-primary/10',
};

/**
 * Quick-stat card with an icon and animated figure.
 * Omits fabricated % change badges — only real metrics build trust.
 */
export default function StatsCard({
  icon: Icon,
  label,
  value,
  tint = 'green',
  currency = true,
  hint,
}) {
  return (
    <Card hoverGlow className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className={cn('rounded-xl p-2.5', TINTS[tint])}>
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>
      <p className="label-caps">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-money tabular-nums text-text-primary">
        {currency ? (
          <AnimatedNumber value={value} format={(n) => formatCurrency(n)} />
        ) : (
          <AnimatedNumber value={value} format={(n) => Math.round(n).toString()} />
        )}
      </p>
      {hint && <p className="mt-1 text-2xs text-text-muted">{hint}</p>}
    </Card>
  );
}
