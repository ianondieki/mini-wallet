import { formatDistanceToNow, format } from 'date-fns';

/**
 * Minimal classnames joiner (cn) — filters falsy values and joins with spaces.
 * @param  {...any} classes
 * @returns {string}
 */
export const cn = (...classes) => classes.filter(Boolean).join(' ');

/**
 * Format a number as KES currency.
 * @param {number} value
 * @param {object} [opts]
 * @param {boolean} [opts.withSymbol=true]
 * @returns {string}
 */
export const formatCurrency = (value, { withSymbol = true } = {}) => {
  const n = Number.isFinite(value) ? value : 0;
  const formatted = n.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withSymbol ? `KES ${formatted}` : formatted;
};

/** Absolute date, e.g. "12 Jun 2026, 14:30". */
export const formatDate = (date) => {
  if (!date) return '—';
  try {
    return format(new Date(date), 'dd MMM yyyy, HH:mm');
  } catch {
    return '—';
  }
};

/** Relative date, e.g. "2 hours ago". */
export const formatRelative = (date) => {
  if (!date) return '';
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return '';
  }
};

/** Normalise a Kenyan phone for display/submission (2547XXXXXXXX). */
export const normalizePhone = (input = '') => {
  let p = String(input).replace(/[\s+]/g, '');
  if (/^0(7|1)\d{8}$/.test(p)) p = `254${p.slice(1)}`;
  else if (/^(7|1)\d{8}$/.test(p)) p = `254${p}`;
  return p;
};

/** Score a password 0–4 for the strength meter. */
export const passwordStrength = (pw = '') => {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 12) score += 1;
  return Math.min(score, 4);
};

/**
 * Build a CSV string from rows and trigger a browser download.
 * @param {string} filename
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string}>} columns
 */
export const exportToCsv = (filename, rows, columns) => {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escape(row[c.key])).join(','))
    .join('\n');
  const csv = `${header}\n${body}`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return csv;
};

/** Deterministic accent colour for an avatar from a seed string. */
export const avatarColor = (seed = '') => {
  const palette = ['#f5a623', '#f43f5e', '#f59e0b', '#3b82f6', '#ec4899', '#10b981'];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
};

/** Initials from a name. */
export const initials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('') || '?';
