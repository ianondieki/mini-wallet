import { motion } from 'framer-motion';
import { cn } from '../../lib/utils.js';

/**
 * Stable cache of motion-wrapped tags. Calling `motion(tag)` inside render
 * returns a NEW component identity each time, forcing React to remount the
 * whole subtree on every render (which drops input focus mid-typing).
 * Caching keeps the component identity stable across renders.
 */
const motionCache = { div: motion.div };
const getMotionTag = (tag) => {
  if (!motionCache[tag]) motionCache[tag] = motion(tag);
  return motionCache[tag];
};

/**
 * Glassmorphism card. `gradientBorder` adds the masked gradient ring;
 * `glow` adds the slow pulsing primary glow; `hoverGlow` lights up on hover.
 */
export default function Card({
  children,
  className,
  gradientBorder = false,
  glow = false,
  hoverGlow = false,
  as = 'div',
  ...props
}) {
  const MotionTag = getMotionTag(as);
  return (
    <MotionTag
      className={cn(
        'glass rounded-2xl',
        gradientBorder && 'gradient-border',
        glow && 'animate-pulse-glow',
        hoverGlow && 'glow-hover',
        className
      )}
      {...props}
    >
      {children}
    </MotionTag>
  );
}
