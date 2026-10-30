import { Check } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * Visual step progress for multi-step money flows (top-up, withdraw).
 * Clearer than plain text labels alone.
 */
export default function StepIndicator({ steps = [], current = 1 }) {
  return (
    <ol className="mb-6 flex items-center justify-center gap-0" aria-label="Progress">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={cn(
                  'step-dot',
                  done && 'step-dot-done',
                  active && 'step-dot-active',
                  !done && !active && 'step-dot-idle'
                )}
                aria-current={active ? 'step' : undefined}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : n}
              </span>
              <span
                className={cn(
                  'text-2xs font-medium',
                  active || done ? 'text-text-primary' : 'text-text-muted'
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  'mx-2 mb-5 h-px w-10 sm:w-14',
                  n < current ? 'bg-primary/50' : 'bg-border'
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
