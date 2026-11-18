import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  Github,
  Google,
  Loader2,
  Lock,
  Mail,
  User,
} from 'lucide-react';
import { isAuthenticated, login, loginWithGithub, loginWithGoogle, register } from '../utils/authService';

interface AuthPanelProps {
  onAuthSuccess: () => void;
  onClose: () => void;
}

interface FormErrors {
  email?: string;
  password?: string;
  general?: string;
}

export function AuthPanel({ onAuthSuccess, onClose }: AuthPanelProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setAuthBusy(true);
    try {
      await login(email, password);
      onAuthSuccess();
    } catch (err: any) {
      setErrors({ general: err.message || 'Erro ao fazer login' });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (!email || !password) {
      setErrors({ general: 'Email e senha são obrigatórios' });
      return;
    }
    if (password.length < 6) {
      setErrors({ password: 'Senha deve ter pelo menos 6 caracteres' });
      return;
    }
    if (password !== confirmPassword) {
      setErrors({ password: 'Senhas não coincidem' });
      return;
    }

    setAuthBusy(true);
    try {
      await register(email, password);
      onAuthSuccess();
    } catch (err: any) {
      setErrors({ general: err.message || 'Erro ao cadastrar' });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLoginWithGoogle = async () => {
    loginWithGoogle();
  };

  const handleLoginWithGithub = async () => {
    loginWithGithub();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#0B0E12] border border-zinc-800/80 rounded-2xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Code2 className="w-6 h-6 text-emerald-400" />
            <span className="text-lg font-bold text-zinc-100">Code Assistants</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-md hover:bg-zinc-800/50 text-zinc-400 focus:outline-none"
          >
            <span className="sr-only">Fechar</span>
            <span className="text-zinc-400">✕</span>
          </button>
        </div>

        <h2 className="text-2xl font-bold text-zinc-100 mb-2">
          {authMode === 'login' ? 'Bem-vindo de volta' : 'Criar conta'}
        </h2>
        <p className="text-xs text-zinc-500 mb-6">
          {authMode === 'login'
            ? 'Entre com sua conta para acessar seus projetos e chaves de IA.'
            : 'Crie uma conta para sincronizar seus projetos e chaves em todos os dispositivos.'}
        </p>

        {errors.general && (
          <div className="mb-4 p-3 rounded-lg border border-red-900/60 bg-red-950/40 text-xs text-red-300">
            {errors.general}
          </div>
        )}

        {/* Login Social */}
        <div className="mb-6">
          <div className="relative flex items-center">
            <div className="flex-grow border border-zinc-800/50"></div>
            <span className="px-2 text-xs text-zinc-500">Ou entrar com</span>
            <div className="flex-grow border border-zinc-800/50"></div>
          </div>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={handleLoginWithGoogle}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-[#0B0E12] text-zinc-300 hover:bg-zinc-800/50 focus:outline-none focus:border-emerald-600"
            >
              <Google className="w-4 h-4" />
              Google
            </button>
            <button
              type="button"
              onClick={handleLoginWithGithub}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-[#0B0E12] text-zinc-300 hover:bg-zinc-800/50 focus:outline-none focus:border-emerald-600"
            >
              <Github className="w-4 h-4" />
              GitHub
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-400">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-600"
              autoComplete="email"
            />
            {errors.email && <p className="text-xs text-red-400">{errors.email}</p>}
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-400">Senha</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-600 pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -mt-2 text-zinc-500 hover:text-zinc-300"
              >
                <Eye className={showPassword ? 'w-4 h-4' : 'w-4 h-4'} />
              </button>
            </div>
            {errors.password && <p className="text-xs text-red-400">{errors.password}</p>}
          </div>
          {authMode === 'register' && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-400">Confirmar senha</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-600 pr-10"
              />
            </div>
          )}
          <button
            type="button"
            onClick={authMode === 'login' ? handleLogin : handleRegister}
            disabled={authBusy}
            className={`w-full rounded-lg px-3 py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50 transition-colors ${
              authBusy
                ? 'bg-zinc-800/50 text-zinc-400'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            }`}
          >
            {authBusy ? (
              <>
                <span className="w-4 h-4 animate-spin border-2 border-white border-t-transparent rounded-full" />
                {authMode === 'login' ? 'Entrando...' : 'Criando conta...'}
              </>
            ) : (
              authMode === 'login' ? 'Entrar' : 'Criar conta'
            )}
          </button>
        </div>

        <div className="mt-6 border-t border-zinc-800/50 pt-4 text-xs text-zinc-500 text-center">
          {authMode === 'login' ? (
            <>
              <p>Não tem uma conta?</p>
              <button
                type="button"
                onClick={() => setMode('register')}
                className="text-emerald-400 underline hover:text-emerald-300"
              >
                Criar uma conta
              </button>
            </>
          ) : (
            <>
              <p>Já tem uma conta?</p>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="text-emerald-400 underline hover:text-emerald-300"
              >
                Fazer login
              </button>
            </>
          )}
        </div>

        <div className="mt-6 text-xs text-zinc-500 text-center">
          <p>Ao se cadastrar, você concorda com nossos Termos de Uso e Política de Privacidade.</p>
        </div>
      </div>
    </div>
  );
}
