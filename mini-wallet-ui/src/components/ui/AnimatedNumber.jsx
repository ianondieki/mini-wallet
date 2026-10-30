import { useEffect, useRef, useState } from 'react';

/**
 * Counts up from 0 → value on mount (and when value changes), using
 * requestAnimationFrame. A timeout fallback guarantees the final value is
 * shown even when rAF is throttled. Animations are skipped in test mode and
 * when the user prefers reduced motion.
 *
 * @param {{value:number, format?:(n:number)=>string, duration?:number}} props
 */
export default function AnimatedNumber({ value = 0, format = (n) => n.toFixed(2), duration = 0.7 }) {
  const target = Number.isFinite(value) ? value : 0;
  const formatRef = useRef(format);
  formatRef.current = format;

  const skipAnimation =
    import.meta.env.MODE === 'test' ||
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  const [display, setDisplay] = useState(() => formatRef.current(skipAnimation ? target : 0));

  useEffect(() => {
    const fmt = formatRef.current;

    if (skipAnimation) {
      setDisplay(fmt(target));
      return undefined;
    }

    const durationMs = Math.max(0, duration * 1000);
    const start = performance.now();
    let raf;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      setDisplay(fmt(target));
    };

    const tick = (now) => {
      if (settled) return;
      const t = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(fmt(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else settle();
    };

    raf = requestAnimationFrame(tick);
    const fallback = setTimeout(settle, durationMs + 80);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
      // Always land on the real value if the effect is torn down mid-flight.
      settle();
    };
  }, [target, duration, skipAnimation]);

  return (
    <span className="tabular-nums" data-money>
      {display}
    </span>
  );
}
