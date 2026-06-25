import { useMemo } from 'react';

const COLORS = ['#f5a623', '#f43f5e', '#f59e0b', '#10b981', '#3b82f6'];

/** Pure-CSS confetti burst from the centre. Renders once on mount. */
export default function Confetti({ count = 28 }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = (Math.PI * 2 * i) / count + Math.random();
        const dist = 80 + Math.random() * 120;
        return {
          id: i,
          color: COLORS[i % COLORS.length],
          cx: `${Math.cos(angle) * dist}px`,
          cy: `${Math.sin(angle) * dist}px`,
          cr: `${Math.random() * 540}deg`,
          delay: `${Math.random() * 0.1}s`,
        };
      }),
    [count]
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti"
          style={{
            background: p.color,
            '--cx': p.cx,
            '--cy': p.cy,
            '--cr': p.cr,
            animationDelay: p.delay,
          }}
        />
      ))}
    </div>
  );
}
