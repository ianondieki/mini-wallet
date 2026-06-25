import { motion } from 'framer-motion';
import { cn } from '../../lib/utils.js';

/**
 * Accessible animated toggle switch.
 * @param {{checked:boolean,onChange:(v:boolean)=>void,label?:string,id?:string}} props
 */
export default function Toggle({ checked, onChange, label, id }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-white/10'
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-white shadow',
          checked ? 'ml-6' : 'ml-1'
        )}
      />
    </button>
  );
}
