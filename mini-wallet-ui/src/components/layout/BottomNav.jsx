import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils.js';
import { MOBILE_NAV_ITEMS } from './Sidebar.jsx';

/**
 * Fixed bottom navigation for mobile (<md).
 * Five primary destinations with 44px+ targets; Settings is in TopBar.
 */
export default function BottomNav() {
  return (
    <nav
      aria-label="Primary mobile"
      className="glass fixed inset-x-0 bottom-0 z-30 border-t border-border/80 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex">
        {MOBILE_NAV_ITEMS.map(({ to, short, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={short}
            className={({ isActive }) =>
              cn(
                'relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-2xs font-medium transition-colors',
                isActive ? 'text-primary' : 'text-text-muted'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="active-bottom"
                    className="absolute top-0 h-0.5 w-7 rounded-full bg-primary"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <span
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-xl transition-colors',
                    isActive && 'bg-primary/12'
                  )}
                >
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2.25 : 1.75} />
                </span>
                <span className="leading-none">{short}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
