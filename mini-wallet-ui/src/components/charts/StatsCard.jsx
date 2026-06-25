import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';
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
 * Quick-stat card with an icon, animated figure and percentage-change badge.
 */
export default function StatsCard({
  icon: Icon,
  label,
  value,
  tint = 'green',
  change = 0,
  currency = true,
}) {
  const up = change >= 0;
  return (
    <Card hoverGlow className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className={cn('rounded-xl p-2', TINTS[tint])}>
          <Icon className="h-5 w-5" />
        </span>
        {change !== null && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              up ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
            )}
          >
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(change)}%
          </span>
        )}
      </div>
      <p className="label-caps">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">
        {currency ? (
          <AnimatedNumber value={value} format={(n) => formatCurrency(n)} />
        ) : (
          <AnimatedNumber value={value} format={(n) => Math.round(n).toString()} />
        )}
      </p>
    </Card>
  );
}
