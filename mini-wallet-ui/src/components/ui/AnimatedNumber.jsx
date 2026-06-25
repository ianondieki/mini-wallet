import { useEffect, useRef, useState } from 'react';

/**
 * Counts up from 0 → value on mount (and when value changes), using
 * requestAnimationFrame. A timeout fallback guarantees the final value is
 * shown even in environments where rAF doesn't tick (e.g. jsdom under test),
 * so the displayed figure is always correct.
 *
 * @param {{value:number, format?:(n:number)=>string, duration?:number}} props
 */
export default function AnimatedNumber({ value = 0, format = (n) => n.toFixed(2), duration = 1 }) {
  const [display, setDisplay] = useState(() => format(0));
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const fmt = formatRef.current;
    const durationMs = Math.max(0, duration * 1000);
    const start = performance.now();
    let raf;

    const tick = (now) => {
      const t = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(fmt(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(fmt(value));
    };

    raf = requestAnimationFrame(tick);
    // Guarantee the final value regardless of rAF cadence.
    const fallback = setTimeout(() => setDisplay(fmt(value)), durationMs + 50);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
    };
  }, [value, duration]);

  return <span>{display}</span>;
}
