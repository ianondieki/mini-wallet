import { forwardRef, useState, useId } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * Text/password input with an animated floating label. Forwards the ref so it
 * works with react-hook-form's register().
 */
const Input = forwardRef(function Input(
  { label, type = 'text', error, hint, className, id, ...props },
  ref
) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && show ? 'text' : type;

  return (
    <div className="w-full">
      <div
        className={cn(
          'glow-focus relative rounded-xl border bg-surface-2/80 transition-colors',
          error ? 'border-error/50' : 'border-border'
        )}
      >
        <input
          ref={ref}
          id={inputId}
          type={inputType}
          placeholder=" "
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(
            'peer h-14 w-full rounded-xl bg-transparent px-4 pt-5 pb-1.5 text-sm text-text-primary',
            'placeholder-transparent outline-none',
            isPassword && 'pr-12',
            className
          )}
          {...props}
        />
        {label && (
          <label
            htmlFor={inputId}
            className={cn(
              'pointer-events-none absolute left-4 top-4 text-text-muted transition-all duration-200',
              'peer-focus:top-2 peer-focus:text-[11px] peer-focus:font-medium peer-focus:text-primary',
              'peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[11px] peer-[:not(:placeholder-shown)]:font-medium'
            )}
          >
            {label}
          </label>
        )}
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text-primary"
          >
            {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-1.5 px-1 text-xs text-error">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${inputId}-hint`} className="mt-1.5 px-1 text-xs leading-relaxed text-text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
});

export default Input;
