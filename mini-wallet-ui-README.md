# Mini Wallet — Web Dashboard

A production-ready React dashboard for a Mini Wallet & M-Pesa payment product.
Dark, glassmorphic fintech UI with animated backgrounds, built to talk to the
companion Node/Express + MongoDB backend (`mini-wallet-backend`).

Stack: **React 18 · Vite 5 · Tailwind CSS v3 · Framer Motion 11 · React Router 6 ·
TanStack Query 5 · Axios · React Hook Form + Zod · Recharts 2 · lucide-react ·
react-hot-toast · date-fns**. Tested with **Vitest · React Testing Library · MSW v2**.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Point the app at your backend
cp .env.example .env          # VITE_API_URL=http://localhost:3000

# 3. Run the dev server
npm run dev                   # http://localhost:5173

# 4. Production build / preview
npm run build
npm run preview
```

> Requires Node 18+ (Node 20 recommended).

---

## Connecting to the backend

The app reads the API base URL from `VITE_API_URL` (default
`http://localhost:3000`). Start the backend first, then the frontend.

Auth is split across two tokens, matching the backend:

- **Access token** — held in memory only (React state + an Axios module
  variable). Never written to `localStorage`, so an XSS payload can't read it.
- **Refresh token** — an `httpOnly` cookie set and rotated by the backend.
  Axios is configured with `withCredentials: true` so the cookie travels
  automatically.

On every `401`, a single-flight interceptor calls `POST /api/auth/refresh`
once, replays the queued requests with the new token, and on refresh failure
clears the session and routes to `/login`. Auth endpoints (login/register)
are excluded from this retry so their `401`s surface as real credential errors.
On app mount the app performs one silent refresh to restore a returning
session.

### API contract consumed

| Area | Endpoint |
| --- | --- |
| Auth | `POST /api/auth/register · login · refresh · logout`, `GET /api/auth/me` |
| Wallet | `GET /api/wallet/balance`, `GET /api/wallet/transactions`, `GET /api/wallet/recipients`, `POST /api/wallet/transfer` |
| M-Pesa | `POST /api/mpesa/topup`, `GET /api/mpesa/status/:checkoutRequestId` |

All responses use the envelope `{ success, data, message?, code? }`. Transfers
send an `Idempotency-Key` header (a UUID generated once per Send page mount).

---

## Pages

- **Login** (`/login`) — dot-grid background, glass card, animated floating
  labels, show/hide password, shake animation on bad credentials, redirect to
  the originally requested page on success.
- **Register** (`/register`) — Zod validation, Kenyan phone format helper, live
  4-segment password-strength meter, submit gated on a valid form.
- **Dashboard** (`/dashboard`) — hero balance card with a count-up number and
  pulsing glow border, three quick-stat cards (sent/received this month, total
  transactions), a Recharts balance-trend area chart with 7D/30D/All toggle,
  and the five most recent transactions with skeleton + empty states.
- **Top Up** (`/topup`) — two-step STK Push flow: amount entry with quick-select
  chips and fee estimate → confirm → live status polling every 3s with a
  progress ring, a drawn checkmark + CSS confetti on success, and a retry path
  on failure. Balance auto-refreshes via query invalidation.
- **Send Money** (`/send`) — debounced (400ms) recipient search with an avatar
  dropdown, amount + quick-selects, optional description, live "you're sending"
  preview, self-transfer and insufficient-balance guards, and a glass
  confirmation modal before submit.
- **Transactions** (`/transactions`) — search + type/status/date filters,
  responsive table (desktop) / card list (mobile), client-side pagination,
  colour-coded amounts, status pills, empty state, and a frontend CSV export.
- **Settings** (`/settings`) — tabbed Profile / Security / Notifications with an
  editable name, read-only email/phone, change-password form, active-session
  card, and animated notification toggles.

The app shell provides a desktop sidebar (collapses to icons at `md`, full at
`lg`) with an animated active indicator, a top bar, and a mobile bottom nav.
Routes are guarded — unauthenticated users are sent to `/login`, authenticated
users are kept out of the auth pages.

---

## Design language

- Palette: bg `#0a0a0f`, surface `#111118`, border `#1e1e2e`, primary
  `#00d4aa`, secondary `#7c3aed`, accent `#f59e0b`. Font: Inter.
- All six required background effects: animated gradient mesh, drifting blurred
  orbs, SVG noise overlay, dot-grid (auth pages), glow borders on hover/focus,
  glassmorphism cards.
- Motion: page fade/slide transitions, staggered card entrances, count-up
  numbers, button press/hover springs, modal scale-in, shimmer skeletons,
  checkmark draw, confetti burst. Honors `prefers-reduced-motion`.

---

## Testing

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run coverage    # coverage report (text + html)
```

**35 tests across 5 suites**, all passing. API calls are intercepted by **MSW
v2** (`src/mocks/handlers.js`) using the same response envelope as the real
backend, so the tests exercise the actual integration code.

- `auth.test.jsx` — form render, empty-submit validation, wrong-credentials
  error, redirect on success, phone-format validation, strength meter, register
  success + duplicate-email error.
- `dashboard.test.jsx` — balance render, loading skeleton, zero balance, recent
  transactions, empty state, quick stats.
- `topup.test.jsx` — quick-amount fill, min/max validation, phone pre-fill,
  step transition, STK pending state, status polling → success, failure state.
- `transfer.test.jsx` — debounced search + dropdown, recipient chip,
  self-transfer guard, confirm modal + cancel, insufficient-balance error,
  successful transfer with idempotency-key header.
- `transactions.test.jsx` — table render, type/status filters, pagination,
  credit/debit colours, empty state, CSV export.

---

## Project structure

```
src/
├── assets/            logo.svg
├── components/
│   ├── ui/            Background, Button, Input, Card, Badge, Modal,
│   │                  Skeleton, Toggle, Avatar, AnimatedNumber, Confetti
│   ├── layout/        AppShell, Sidebar, TopBar, BottomNav
│   ├── charts/        StatsCard, BalanceChart
│   └── transactions/  TransactionRow, TransactionFilters, TransactionTable
├── context/           AuthContext.jsx
├── hooks/             useAuth, useWallet, useTransactions, useMpesa
├── lib/               axios.js, queryClient.js, utils.js
├── mocks/             handlers.js, server.js   (MSW)
├── pages/             Login, Register, Dashboard, TopUp, Send,
│                      Transactions, Settings
├── tests/             setup.js, test-utils.jsx, *.test.jsx
├── App.jsx            providers + router + route guards
├── main.jsx
└── index.css          Tailwind layers + design tokens + background FX
```

---

## Notes

- `npm install` may report advisories from transitive dev dependencies; they do
  not affect the production bundle.
- The production build is split into vendor chunks (react, charts, motion, data,
  forms) so no single chunk trips Vite's size warning.
- For local end-to-end runs, the backend requires MongoDB as a **replica set**
  (transactions depend on multi-document sessions) — see the backend README.
