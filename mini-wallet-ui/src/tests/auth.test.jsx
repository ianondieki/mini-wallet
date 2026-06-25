import { describe, it, expect } from 'vitest';
import { Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders, screen, waitFor } from './test-utils.jsx';
import { server } from '../mocks/server.js';
import Login from '../pages/Login.jsx';
import Register from '../pages/Register.jsx';

const API = 'http://localhost:3000';

describe('Login', () => {
  it('renders the login form', async () => {
    renderWithProviders(<Login />, { route: '/login' });
    expect(await screen.findByRole('heading', { name: /sign in to your wallet/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  it('shows validation errors on empty submit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });
    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
    expect(await screen.findByText(/password is required/i)).toBeInTheDocument();
  });

  it('shows an error toast on wrong credentials (401)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });
    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'wrongpass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });

  it('redirects to /dashboard on successful login', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div>Dashboard Loaded</div>} />
      </Routes>,
      { route: '/login' }
    );
    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'correctpass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/dashboard loaded/i)).toBeInTheDocument();
  });
});

describe('Register', () => {
  it('validates the phone format', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Register />, { route: '/register' });
    const phone = await screen.findByLabelText(/phone/i);
    await user.type(phone, '12345');
    await user.tab();
    expect(await screen.findByText(/2547XXXXXXXX/i)).toBeInTheDocument();
  });

  it('updates the password strength meter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Register />, { route: '/register' });
    const pw = await screen.findByLabelText(/^password$/i);
    await user.type(pw, 'abcdefgh');
    expect(await screen.findByText(/weak/i)).toBeInTheDocument();
    await user.clear(pw);
    await user.type(pw, 'Abcdef12!xyz');
    expect(await screen.findByText(/strong/i)).toBeInTheDocument();
  });

  it('registers successfully and redirects', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<div>Dashboard Loaded</div>} />
      </Routes>,
      { route: '/register' }
    );
    await user.type(await screen.findByLabelText(/full name/i), 'New User');
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/phone/i), '0712345678');
    await user.type(screen.getByLabelText(/^password$/i), 'Abcdef12');
    await user.type(screen.getByLabelText(/confirm password/i), 'Abcdef12');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/dashboard loaded/i)).toBeInTheDocument();
  });

  it('shows an error when the email is already taken (409)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Register />, { route: '/register' });
    await user.type(await screen.findByLabelText(/full name/i), 'Dup User');
    await user.type(screen.getByLabelText(/email/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/phone/i), '0712345678');
    await user.type(screen.getByLabelText(/^password$/i), 'Abcdef12');
    await user.type(screen.getByLabelText(/confirm password/i), 'Abcdef12');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });
});
