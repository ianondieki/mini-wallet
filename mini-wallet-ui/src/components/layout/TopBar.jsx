import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth.js';

/** Time-aware greeting — personal without being gimmicky. */
function greetingForHour(hour) {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Sticky page header with optional personal greeting.
 * Intentionally omits decorative / non-functional controls (fake notification
 * dots, theme toggles) that erode trust in a money product.
 */
export default function TopBar({ title, subtitle, greet = false }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const greeting = useMemo(() => {
    if (!greet) return null;
    const first = (user?.name || '').trim().split(/\s+/)[0];
    const hello = greetingForHour(new Date().getHours());
    return first ? `${hello}, ${first}` : hello;
  }, [greet, user?.name]);

  return (
    <header className="sticky top-0 z-20 -mx-4 mb-6 border-b border-border/40 bg-bg/70 px-4 py-4 backdrop-blur-xl md:-mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {greeting && (
            <p className="mb-0.5 text-sm text-text-muted md:text-[15px]">{greeting}</p>
          )}
          <h1 className="truncate text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 max-w-md text-sm leading-relaxed text-text-muted">{subtitle}</p>
          )}
        </div>

        {/* Mobile-only settings shortcut (Settings is not on bottom nav) */}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="Open settings"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2/60 text-text-muted transition-colors hover:border-border-strong hover:text-text-primary md:hidden"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
