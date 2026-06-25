import { setupServer } from 'msw/node';
import { handlers } from './handlers.js';

// Node-side MSW server used by Vitest to intercept network calls.
export const server = setupServer(...handlers);

export default server;
