/**
 * Fixed atmospheric background: large blurred colour orbs that slowly drift
 * and pulse, plus an SVG noise overlay for depth. Sits behind all content.
 */
export default function Background({ dotGrid = false }) {
  return (
    <div className="noise-overlay" aria-hidden="true">
      <div
        className="bg-orb bg-orb animate-drift-1"
        style={{
          width: 520,
          height: 520,
          top: -120,
          left: -80,
          background: 'radial-gradient(circle, rgba(244,63,94,0.55), transparent 70%)',
        }}
      />
      <div
        className="bg-orb animate-drift-2"
        style={{
          width: 480,
          height: 480,
          top: '30%',
          right: -120,
          background: 'radial-gradient(circle, rgba(245,166,35,0.45), transparent 70%)',
        }}
      />
      <div
        className="bg-orb animate-drift-3"
        style={{
          width: 420,
          height: 420,
          bottom: -140,
          left: '25%',
          background: 'radial-gradient(circle, rgba(59,130,246,0.4), transparent 70%)',
        }}
      />
      <div
        className="bg-orb animate-drift-1"
        style={{
          width: 300,
          height: 300,
          bottom: '10%',
          right: '20%',
          animationDelay: '3s',
          background: 'radial-gradient(circle, rgba(245,158,11,0.28), transparent 70%)',
        }}
      />
      {dotGrid && (
        <div className="dot-grid fixed inset-0" style={{ zIndex: 0 }} aria-hidden="true" />
      )}
    </div>
  );
}
