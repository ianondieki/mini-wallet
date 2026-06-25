import { avatarColor, initials, cn } from '../../lib/utils.js';

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
};

/** Circular avatar showing initials over a seed-derived colour. */
export default function Avatar({ name = '', email = '', size = 'md', className }) {
  const seed = email || name;
  const color = avatarColor(seed);
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full font-semibold text-bg',
        SIZES[size],
        className
      )}
      style={{ background: color }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
