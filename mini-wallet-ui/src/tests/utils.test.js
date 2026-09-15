import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  formatCurrency,
  normalizePhone,
  passwordStrength,
  exportToCsv,
  initials,
} from '../lib/utils.js';

// jsdom doesn't implement the Blob-download APIs exportToCsv uses for the
// side-effect; stub them so we can assert on the returned CSV string.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

describe('formatCurrency', () => {
  it('formats numbers as KES with two decimals', () => {
    expect(formatCurrency(1000)).toBe('KES 1,000.00');
    expect(formatCurrency(0)).toBe('KES 0.00');
  });
  it('falls back to 0 for non-finite values', () => {
    expect(formatCurrency(undefined)).toBe('KES 0.00');
    expect(formatCurrency(NaN)).toBe('KES 0.00');
  });
  it('omits the symbol when asked', () => {
    expect(formatCurrency(50, { withSymbol: false })).toBe('50.00');
  });
});

describe('normalizePhone', () => {
  it('normalises local and international formats to 2547XXXXXXXX', () => {
    expect(normalizePhone('0712345678')).toBe('254712345678');
    expect(normalizePhone('712345678')).toBe('254712345678');
    expect(normalizePhone('+254712345678')).toBe('254712345678');
  });
});

describe('passwordStrength', () => {
  it('scores from weak to strong', () => {
    expect(passwordStrength('abc')).toBeLessThan(2);
    expect(passwordStrength('Abcdef1!xyz')).toBe(4);
  });
});

describe('exportToCsv', () => {
  const cols = [
    { key: 'name', label: 'Name' },
    { key: 'amount', label: 'Amount' },
  ];

  it('builds a header + rows', () => {
    const csv = exportToCsv('t.csv', [{ name: 'Ada', amount: 100 }], cols);
    expect(csv).toBe('Name,Amount\nAda,100');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    const csv = exportToCsv('t.csv', [{ name: 'Doe, John', amount: 'a"b' }], cols);
    expect(csv).toContain('"Doe, John"');
    expect(csv).toContain('"a""b"');
  });

  it('neutralises formula injection (=, +, -, @)', () => {
    const csv = exportToCsv('t.csv', [{ name: '=cmd()', amount: '+1' }], cols);
    // Leading formula chars get a single-quote prefix so spreadsheets treat
    // them as text, not executable formulas.
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain("'+1");
    expect(csv).not.toMatch(/\n=cmd/);
  });
});

describe('initials', () => {
  it('derives up to two initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
  });
});
