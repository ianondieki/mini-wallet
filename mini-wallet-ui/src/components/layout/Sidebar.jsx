import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  Send,
  PlusCircle,
  Banknote,
  Receipt,
  Settings,
  LogOut,
} from 'lucide-react';
import Avatar from '../ui/Avatar.jsx';
import logo from '../../assets/logo.svg';
import { useAuth } from '../../hooks/useAuth.js';
import { cn } from '../../lib/utils.js';

/** Full nav for desktop sidebar. */
export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Home', short: 'Home', icon: LayoutDashboard },
  { to: '/send', label: 'Send', short: 'Send', icon: Send },
  { to: '/topup', label: 'Top up', short: 'Top up', icon: PlusCircle },
  { to: '/withdraw', label: 'Withdraw', short: 'Cash out', icon: Banknote },
  { to: '/transactions', label: 'Activity', short: 'Activity', icon: Receipt },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: Settings, desktopOnly: true },
];

/** Primary mobile destinations (5 max — Settings lives in TopBar). */
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.desktopOnly);

export default function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-20 flex-col border-r border-border/80 p-3 md:flex lg:w-64">
      <div className="mb-8 flex items-center gap-3 px-2 pt-2">
        <img src={logo} alt="" className="h-9 w-9 shrink-0" />
        <div className="hidden min-w-0 lg:block">
          <span className="block text-base font-bold tracking-tight">Mini Wallet</span>
          <span className="block text-2xs text-text-muted">M-Pesa ready</span>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5" aria-label="Primary">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-text-primary'
                  : 'text-text-muted hover:bg-white/[0.04] hover:text-text-primary'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="active-nav"
                    className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon
                  className={cn(
                    'h-5 w-5 shrink-0 transition-colors',
                    isActive ? 'text-primary' : 'text-text-muted group-hover:text-text-secondary'
                  )}
                  strokeWidth={isActive ? 2.25 : 1.75}
                />
                <span className="hidden lg:inline">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2 border-t border-border/80 pt-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-1.5">
          <Avatar name={user?.name} email={user?.email} size="md" />
          <div className="hidden min-w-0 lg:block">
            <p className="truncate text-sm font-medium text-text-primary">{user?.name}</p>
            <p className="truncate text-2xs text-text-muted">{user?.phone || user?.email}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-error/10 hover:text-error"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span className="hidden lg:inline">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
