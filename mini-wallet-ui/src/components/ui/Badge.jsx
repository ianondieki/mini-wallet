import { cn } from '../../lib/utils.js';

const STYLES = {
  success: 'bg-success/12 text-success border-success/25',
  pending: 'bg-warning/12 text-warning border-warning/25',
  failed: 'bg-error/12 text-error border-error/25',
  reversed: 'bg-text-muted/12 text-text-muted border-text-muted/25',
  topup: 'bg-primary/12 text-primary border-primary/25',
  transfer: 'bg-info/12 text-info border-info/25',
  withdrawal: 'bg-secondary/12 text-secondary border-secondary/25',
};

const DOT = {
  success: 'bg-success',
  pending: 'bg-warning',
  failed: 'bg-error',
  reversed: 'bg-text-muted',
  topup: 'bg-primary',
  transfer: 'bg-info',
  withdrawal: 'bg-secondary',
};

/**
 * Pill badge. `status` selects a colour preset; pass children for the label
 * (defaults to a title-cased status). Includes a status dot for colorblind cues.
 */
export default function Badge({ status = 'pending', children, className, showDot = true }) {
  const label = children || status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-semibold capitalize tracking-wide',
        STYLES[status] || STYLES.pending,
        className
      )}
    >
      {showDot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[status] || DOT.pending)}
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
}
