import type { SafeProviderSummary } from '../types/hub';

const AUTH_SERVER = process.env.VITE_AUTH_SERVER || 'http://localhost:3001';

export interface AuthUser {
  id: string;
  email: string;
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
