import { Bell, Moon } from 'lucide-react';

/**
 * Sticky top bar. The dark-mode toggle is presentational — this product is
 * dark by default (the indicator communicates the active theme).
 */
export default function TopBar({ title }) {
  return (
    <header className="sticky top-0 z-20 mb-6 flex items-center justify-between">
      <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Notifications"
          className="relative rounded-xl border border-border bg-surface-2/60 p-2.5 text-text-muted transition-colors hover:text-text-primary"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-bg" />
        </button>
        <button
          type="button"
          aria-label="Theme: dark"
          aria-pressed="true"
          className="rounded-xl border border-border bg-surface-2/60 p-2.5 text-primary"
        >
          <Moon className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
