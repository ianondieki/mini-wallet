import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from '../mocks/server.js';
import { resetMpesaPolls } from '../mocks/handlers.js';

// ── jsdom polyfills ───────────────────────────────────────────────────
// Recharts' ResponsiveContainer relies on ResizeObserver.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Framer Motion / responsive code reads matchMedia.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// Give ResponsiveContainer a non-zero size so the chart renders in tests.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });

// Establish API mocking before all tests.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Reset any per-test handler overrides and DOM after each test.
afterEach(() => {
  server.resetHandlers();
  resetMpesaPolls();
  cleanup();
});

// Clean up once the tests are done.
afterAll(() => server.close());
