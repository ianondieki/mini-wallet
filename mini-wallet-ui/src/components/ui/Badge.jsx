import { cn } from '../../lib/utils.js';

const STYLES = {
  success: 'bg-success/15 text-success border-success/30',
  pending: 'bg-warning/15 text-warning border-warning/30',
  failed: 'bg-error/15 text-error border-error/30',
  reversed: 'bg-text-muted/15 text-text-muted border-text-muted/30',
  topup: 'bg-primary/15 text-primary border-primary/30',
  transfer: 'bg-secondary/15 text-secondary border-secondary/30',
  withdrawal: 'bg-accent/15 text-accent border-accent/30',
};

/**
 * Pill badge. `status` selects a colour preset; pass children for the label
 * (defaults to a title-cased status).
 */
export default function Badge({ status = 'pending', children, className }) {
  const label = children || status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize',
        STYLES[status] || STYLES.pending,
        className
      )}
    >
      {label}
    </span>
  );
}
