/**
 * Fixed atmospheric background: soft brand washes + restrained drifting orbs
 * and a light noise grain. Intentionally calm so money content stays legible.
 */
export default function Background({ dotGrid = false }) {
  return (
    <div className="noise-overlay" aria-hidden="true">
      {/* Ambient brand washes — static, low contrast */}
      <div className="bg-vignette" />

      {/* Soft drifting orbs — lower opacity than before for less visual noise */}
      <div
        className="bg-orb animate-drift-1"
        style={{
          width: 480,
          height: 480,
          top: -160,
          left: -100,
          background: 'radial-gradient(circle, rgba(245,166,35,0.22), transparent 68%)',
        }}
      />
      <div
        className="bg-orb animate-drift-2"
        style={{
          width: 420,
          height: 420,
          top: '38%',
          right: -140,
          background: 'radial-gradient(circle, rgba(232,93,117,0.14), transparent 70%)',
        }}
      />
      <div
        className="bg-orb animate-drift-3"
        style={{
          width: 380,
          height: 380,
          bottom: -120,
          left: '20%',
          background: 'radial-gradient(circle, rgba(96,165,250,0.12), transparent 70%)',
        }}
      />
      <div
        className="bg-orb animate-drift-1"
        style={{
          width: 260,
          height: 260,
          bottom: '18%',
          right: '18%',
          animationDelay: '4s',
          background: 'radial-gradient(circle, rgba(251,191,36,0.1), transparent 70%)',
        }}
      />

      {dotGrid && (
        <div className="dot-grid fixed inset-0" style={{ zIndex: 0 }} aria-hidden="true" />
      )}
    </div>
  );
}
