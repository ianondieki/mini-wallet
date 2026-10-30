import { useState } from 'react';
import toast from 'react-hot-toast';
import { Camera, Monitor, Shield } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Input from '../components/ui/Input.jsx';
import Toggle from '../components/ui/Toggle.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { cn } from '../lib/utils.js';

const TABS = [
  { id: 'Profile', desc: 'Your details' },
  { id: 'Security', desc: 'Password & sessions' },
  { id: 'Notifications', desc: 'Alerts you get' },
];

export default function Settings() {
  const { user } = useAuth();
  const [tab, setTab] = useState('Profile');
  const [name, setName] = useState(user?.name || '');
  const [notif, setNotif] = useState({ email: true, sms: false, push: true });

  return (
    <>
      <TopBar title="Settings" subtitle="Manage your profile, security, and how we reach you." />

      <div
        className="mb-6 flex gap-1 rounded-xl border border-border bg-surface-2/70 p-1"
        role="tablist"
        aria-label="Settings sections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 rounded-lg px-2 py-2.5 text-sm font-medium transition-colors',
              tab === t.id
                ? 'bg-primary text-bg shadow-soft'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            {t.id}
          </button>
        ))}
      </div>

      {tab === 'Profile' && (
        <Card className="p-6">
          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar name={user?.name} email={user?.email} size="lg" />
              <button
                type="button"
                aria-label="Upload avatar"
                onClick={() => toast('Avatar upload isn’t available in this demo yet.')}
                className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-text-muted transition-colors hover:text-primary"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-text-primary">{user?.name}</p>
              <p className="truncate text-sm text-text-muted">{user?.email}</p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Email" value={user?.email || ''} readOnly className="opacity-70" />
            <Input label="Phone" value={user?.phone || ''} readOnly className="opacity-70" />
            <p className="text-2xs leading-relaxed text-text-muted">
              Email and phone are locked after signup. Contact support to change them.
            </p>
            <Button onClick={() => toast.success('Profile saved')}>Save changes</Button>
          </div>
        </Card>
      )}

      {tab === 'Security' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <h2 className="font-semibold">Change password</h2>
            </div>
            <div className="space-y-4">
              <Input label="Current password" type="password" autoComplete="current-password" />
              <Input label="New password" type="password" autoComplete="new-password" />
              <Input label="Confirm new password" type="password" autoComplete="new-password" />
              <Button onClick={() => toast.success('Password updated')}>Update password</Button>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="mb-1 font-semibold">Active sessions</h2>
            <p className="mb-4 text-sm text-text-muted">
              Devices currently signed into your wallet.
            </p>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-4">
              <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
                <Monitor className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">This device</p>
                <p className="text-xs text-text-muted">Active now · Web browser</p>
              </div>
              <span className="rounded-full bg-success/12 px-2.5 py-0.5 text-2xs font-semibold text-success">
                Current
              </span>
            </div>
            <Button
              variant="danger"
              className="mt-4"
              onClick={() => toast('Signed out of all other devices')}
            >
              Sign out other devices
            </Button>
          </Card>
        </div>
      )}

      {tab === 'Notifications' && (
        <Card className="p-6">
          <h2 className="mb-1 font-semibold">Notification preferences</h2>
          <p className="mb-4 text-sm text-text-muted">
            Choose how you want to hear about money moving in your wallet.
          </p>
          <div className="space-y-1">
            {[
              {
                key: 'email',
                label: 'Email notifications',
                desc: 'Receipts, security alerts, and monthly summaries',
              },
              {
                key: 'sms',
                label: 'SMS alerts',
                desc: 'Critical transfer confirmations by text',
              },
              {
                key: 'push',
                label: 'Push notifications',
                desc: 'Real-time top-up and payment updates',
              },
            ].map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4 rounded-xl px-2 py-3.5 transition-colors hover:bg-white/[0.03]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs leading-relaxed text-text-muted">{row.desc}</p>
                </div>
                <Toggle
                  checked={notif[row.key]}
                  onChange={(v) => setNotif((n) => ({ ...n, [row.key]: v }))}
                  label={row.label}
                />
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
