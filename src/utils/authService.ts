import type { SafeProviderSummary } from '../types/hub';
import { isDesktopApp } from './platform';

const AUTH_SERVER = process.env.VITE_AUTH_SERVER || 'http://localhost:3001';

export interface AuthUser {
  id: string;
  email: string;
  is_admin?: boolean;
  is_active?: boolean;
  email_verified?: boolean;
}

export interface AuthTokens {
  token: string;
  user: AuthUser;
}

export interface ProviderKey {
  id: string;
  provider: string;
  apiKey: string;
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('code-assistants-token', token);
  } else {
    localStorage.removeItem('code-assistants-token');
  }
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  if (typeof localStorage !== 'undefined') {
    authToken = localStorage.getItem('code-assistants-token');
  }
  return authToken;
}

export async function register(email: string, password: string): Promise<AuthTokens> {
  if (isDesktopApp()) {
    return login(email, password);
  }
  const res = await fetch(`${AUTH_SERVER}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao cadastrar');
  setAuthToken(data.token);
  return data;
}

export async function login(email: string, password: string): Promise<AuthTokens> {
  if (isDesktopApp()) {
    // Autenticação local no computador: não depende de servidor externo nem de .env.
    const token = `desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setAuthToken(token);
    return { token, user: { id: 'desktop-local', email, is_active: true } };
  }
  const res = await fetch(`${AUTH_SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Credenciais inválidas');
  setAuthToken(data.token);
  return data;
}

export async function loginWithGoogle(): Promise<void> {
  window.location.href = `${AUTH_SERVER}/api/auth/google`;
}

export async function loginWithGithub(): Promise<void> {
  window.location.href = `${AUTH_SERVER}/api/auth/github`;
}

export function logout() {
  setAuthToken(null);
}

export async function getUserKeys(): Promise<ProviderKey[]> {
  const token = getAuthToken();
  if (!token) return [];
  const res = await fetch(`${AUTH_SERVER}/api/auth/keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.keys) ? data.keys : [];
}

export async function saveUserKey(provider: string, apiKey: string): Promise<void> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  const res = await fetch(`${AUTH_SERVER}/api/auth/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ provider, apiKey }),
  });
  if (!res.ok) throw new Error('Erro ao salvar chave');
}

export async function deleteUserKey(id: string): Promise<void> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  await fetch(`${AUTH_SERVER}/api/auth/keys/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function isAuthenticated(): Promise<boolean> {
  return !!getAuthToken();
}

export async function isServerOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_SERVER}/api/auth/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function verifyEmail(token: string): Promise<void> {
  const res = await fetch(`${AUTH_SERVER}/api/auth/verify-email?token=${token}`, {
    method: 'GET',
  });
  if (!res.ok) throw new Error('Erro ao verificar email');
}

// Funções de admin
export async function getAllUsers(): Promise<any[]> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  const res = await fetch(`${AUTH_SERVER}/api/admin/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Erro ao listar usuários');
  const data = await res.json();
  return data.users || [];
}

export async function toggleUserActive(userId: string, isActive: boolean): Promise<void> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  const res = await fetch(`${AUTH_SERVER}/api/admin/users/${userId}/toggle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ is_active: isActive }),
  });
  if (!res.ok) throw new Error('Erro ao alterar status do usuário');
}

export async function toggleUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  const res = await fetch(`${AUTH_SERVER}/api/admin/users/${id}/role`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) throw new Error('Erro ao alterar papel do usuário');
}

export async function deleteUser(userId: string): Promise<void> {
  const token = getAuthToken();
  if (!token) throw new Error('Não autenticado');
  const res = await fetch(`${AUTH_SERVER}/api/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Erro ao deletar usuário');
}
