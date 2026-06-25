import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils.js';
import { NAV_ITEMS } from './Sidebar.jsx';

/** Fixed bottom navigation for mobile (<md). 44px+ tap targets. */
export default function BottomNav() {
  return (
    <nav
      aria-label="Primary mobile"
      className="glass fixed inset-x-0 bottom-0 z-30 flex border-t border-border md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          aria-label={label}
          className={({ isActive }) =>
            cn(
              'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors',
              isActive ? 'text-primary' : 'text-text-muted'
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span
                  layoutId="active-bottom"
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
                />
              )}
              <Icon className="h-5 w-5" />
              {label.split(' ')[0]}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
