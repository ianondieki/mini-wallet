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

export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/send', label: 'Send Money', icon: Send },
  { to: '/topup', label: 'Top Up', icon: PlusCircle },
  { to: '/withdraw', label: 'Withdraw', icon: Banknote },
  { to: '/transactions', label: 'Transactions', icon: Receipt },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-20 flex-col border-r border-border p-3 md:flex lg:w-64">
      <div className="mb-8 flex items-center gap-3 px-2 pt-2">
        <img src={logo} alt="Mini Wallet logo" className="h-9 w-9" />
        <span className="hidden text-lg font-bold tracking-tight lg:inline">
          Mini Wallet
        </span>
      </div>

      <nav className="flex-1 space-y-1" aria-label="Primary">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                isActive
                  ? 'bg-white/5 text-text-primary'
                  : 'text-text-muted hover:bg-white/5 hover:text-text-primary'
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
                <Icon className="h-5 w-5 shrink-0" />
                <span className="hidden lg:inline">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2 border-t border-border pt-3">
        <div className="flex items-center gap-3 px-2">
          <Avatar name={user?.name} email={user?.email} size="md" />
          <div className="hidden min-w-0 lg:block">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-text-muted">{user?.phone}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-muted transition-colors hover:bg-error/10 hover:text-error"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span className="hidden lg:inline">Logout</span>
        </button>
      </div>
    </aside>
  );
}
