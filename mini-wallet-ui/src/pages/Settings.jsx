import { useState } from 'react';
import toast from 'react-hot-toast';
import { Camera, Monitor } from 'lucide-react';
import TopBar from '../components/layout/TopBar.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import Input from '../components/ui/Input.jsx';
import Toggle from '../components/ui/Toggle.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { cn } from '../lib/utils.js';

const TABS = ['Profile', 'Security', 'Notifications'];

export default function Settings() {
  const { user } = useAuth();
  const [tab, setTab] = useState('Profile');
  const [name, setName] = useState(user?.name || '');
  const [notif, setNotif] = useState({ email: true, sms: false, push: true });

  return (
    <>
      <TopBar title="Settings" />

      <div className="mb-6 flex gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
              tab === t ? 'bg-primary text-bg' : 'text-text-muted hover:text-text-primary'
            )}
          >
            {t}
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
                className="absolute -bottom-1 -right-1 rounded-full border border-border bg-surface p-1.5 text-text-muted hover:text-primary"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
            </div>
            <div>
              <p className="font-semibold">{user?.name}</p>
              <p className="text-sm text-text-muted">{user?.email}</p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Email" value={user?.email || ''} readOnly className="opacity-70" />
            <Input label="Phone" value={user?.phone || ''} readOnly className="opacity-70" />
            <Button onClick={() => toast.success('Profile updated')}>Save changes</Button>
          </div>
        </Card>
      )}

      {tab === 'Security' && (
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-4 font-semibold">Change password</h2>
            <div className="space-y-4">
              <Input label="Current password" type="password" />
              <Input label="New password" type="password" />
              <Input label="Confirm new password" type="password" />
              <Button onClick={() => toast.success('Password updated')}>Update password</Button>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="mb-4 font-semibold">Active sessions</h2>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-4">
              <span className="rounded-xl bg-primary/10 p-2 text-primary">
                <Monitor className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <p className="text-sm font-medium">This device</p>
                <p className="text-xs text-text-muted">Active now · Web</p>
              </div>
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">Current</span>
            </div>
            <Button variant="danger" className="mt-4" onClick={() => toast('Signed out of all other devices')}>
              Logout all devices
            </Button>
          </Card>
        </div>
      )}

      {tab === 'Notifications' && (
        <Card className="p-6">
          <h2 className="mb-4 font-semibold">Notification preferences</h2>
          <div className="space-y-1">
            {[
              { key: 'email', label: 'Email notifications', desc: 'Receipts and account alerts' },
              { key: 'sms', label: 'SMS alerts', desc: 'Transaction confirmations by text' },
              { key: 'push', label: 'Push notifications', desc: 'Real-time payment updates' },
            ].map((row) => (
              <div key={row.key} className="flex items-center justify-between rounded-xl px-2 py-3 hover:bg-white/5">
                <div>
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-text-muted">{row.desc}</p>
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
