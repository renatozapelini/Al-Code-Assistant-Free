import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Gift,
  KeyRound,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NavTab, OAuthLoginSession, RealmId, SafeAccountSummary } from '../types/hub';

interface AccountsPanelProps {
  accounts: SafeAccountSummary[];
  providersCount: number;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onAccountsChanged: () => void;
  onNavigate: (tab: NavTab) => void;
}

export const AccountsPanel: React.FC<AccountsPanelProps> = ({
  accounts,
  providersCount,
  apiFetch,
  onAccountsChanged,
  onNavigate,
}) => {
  const [authMethod, setAuthMethod] = useState<'oauth' | 'pat' | 'json'>('oauth');
  const [realm, setRealm] = useState<RealmId>('intl');
  const [oauthSession, setOauthSession] = useState<OAuthLoginSession | null>(null);
  const [oauthStatus, setOauthStatus] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [patValue, setPatValue] = useState('');
  const [patBusy, setPatBusy] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<'quota' | 'checkin' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!oauthSession) return;
    let active = true;
    const timer = setInterval(async () => {
      if (!active) return;
      try {
        const res = await apiFetch(`/api/hub/oauth/poll?state=${encodeURIComponent(oauthSession.state)}`);
        const data = (await res.json()) as {
          status: string;
          message: string;
          account?: SafeAccountSummary;
        };
        if (!active) return;
        setOauthStatus(data.message);
        if (data.status === 'success') {
          setOauthSession(null);
          setNotice({ kind: 'ok', text: `Conta ${data.account?.nickname || ''} conectada com sucesso.` });
          onAccountsChanged();
        } else if (data.status === 'expired' || data.status === 'unknown' || data.status === 'error') {
          setOauthSession(null);
          setNotice({ kind: 'err', text: data.message });
        }
      } catch {
        // keep polling silently
      }
    }, 2500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [oauthSession, apiFetch, onAccountsChanged]);

  const handleStartOAuth = async () => {
    setOauthBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/hub/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realm }),
      });
      const session = (await res.json()) as OAuthLoginSession;
      setOauthSession(session);
      setOauthStatus('Link gerado. Faça login ou crie uma conta no navegador e ela entra automaticamente aqui.');
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao iniciar OAuth.' });
    } finally {
      setOauthBusy(false);
    }
  };

  const handleImportPat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patValue.trim()) return;
    setPatBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/hub/accounts/pat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pat: patValue.trim(), realm }),
      });
      const data = (await res.json()) as { ok?: boolean; account?: SafeAccountSummary; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || 'Falha ao importar PAT');
      setPatValue('');
      setNotice({ kind: 'ok', text: `Conta ${data.account?.nickname || ''} importada via PAT.` });
      onAccountsChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao importar PAT.' });
    } finally {
      setPatBusy(false);
    }
  };

  const handleImportJson = async () => {
    setNotice(null);
    try {
      const parsed = JSON.parse(jsonText);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const res = await apiFetch('/api/hub/accounts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: list }),
      });
      const data = (await res.json()) as { ok?: boolean; imported?: number; skipped?: number; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || 'JSON inválido');
      setJsonText('');
      setNotice({
        kind: 'ok',
        text: `${data.imported ?? 0} conta(s) importada(s), ${data.skipped ?? 0} ignorada(s).`,
      });
      onAccountsChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro no JSON.' });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setJsonText(reader.result);
    };
    reader.readAsText(file);
  };

  const runAccountAction = async (uid: string, action: 'quota' | 'checkin' | 'refresh' | 'toggle' | 'delete') => {
    setBusyUid(uid);
    setNotice(null);
    try {
      const path =
        action === 'delete'
          ? `/api/hub/accounts/${encodeURIComponent(uid)}`
          : `/api/hub/accounts/${encodeURIComponent(uid)}/${action}`;
      const res = await apiFetch(path, {
        method: action === 'delete' ? 'DELETE' : 'POST',
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (data.message) {
        setNotice({ kind: data.ok ? 'ok' : 'err', text: data.message });
      } else if (data.error) {
        setNotice({ kind: 'err', text: data.error });
      }
      onAccountsChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro na operação.' });
    } finally {
      setBusyUid(null);
    }
  };

  const runBatchAction = async (action: 'quota' | 'checkin') => {
    if (accounts.length === 0) return;
    setBatchBusy(action);
    setNotice(null);
    let okCount = 0;
    for (const acc of accounts) {
      if (!acc.enabled) continue;
      try {
        const res = await apiFetch(`/api/hub/accounts/${encodeURIComponent(acc.uid)}/${action}`, {
          method: 'POST',
        });
        const data = (await res.json()) as { ok?: boolean };
        if (res.ok && data.ok !== false) okCount++;
      } catch {
        // continue batch
      }
    }
    setBatchBusy(null);
    setNotice({
      kind: 'ok',
      text:
        action === 'checkin'
          ? `Check-in processado em ${okCount} de ${accounts.filter((a) => a.enabled).length} conta(s) ativa(s).`
          : `Saldo sincronizado em ${okCount} de ${accounts.filter((a) => a.enabled).length} conta(s) ativa(s).`,
    });
    onAccountsChanged();
  };

  return (
    <div className="space-y-6">
      {/* Cross-link to Dedicated AI APIs Tab */}
      <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-zinc-100">
            Quer adicionar chaves de OpenAI, Claude, DeepSeek, Grok, Gemini, Groq ou Ollama?
          </div>
          <p className="text-xs text-zinc-400">
            Use a aba dedicada APIs IA ({providersCount} cadastrada{providersCount === 1 ? '' : 's'}) para montar sua fila de failover automático sem parar o projeto.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('apis')}
          className="min-h-[44px] px-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-xs font-semibold text-emerald-300 flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
        >
          <span>Abrir Aba APIs IA</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {notice && (
        <div
          className={`px-4 py-3 rounded-xl text-xs font-medium border ${
            notice.kind === 'ok'
              ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
              : 'bg-red-950/30 border-red-800/60 text-red-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Add Qoder Account Section */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Pool de Contas Qoder</h1>
            <p className="text-xs text-zinc-400">
              Conecte várias contas Global ou China via OAuth PKCE (ou crie uma nova no navegador durante o login) para rotacionar créditos e renovar tokens automaticamente.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#090B0E] border border-zinc-800 rounded-xl self-start">
            <button
              type="button"
              onClick={() => setRealm('intl')}
              className={`min-h-[40px] px-3 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                realm === 'intl' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Global (qoder.com)
            </button>
            <button
              type="button"
              onClick={() => setRealm('cn')}
              className={`min-h-[40px] px-3 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                realm === 'cn' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              China (qoder.com.cn)
            </button>
          </div>
        </div>

        {/* Auth method segmented tabs */}
        <div className="flex items-center gap-1 p-1 bg-[#090B0E] border border-zinc-800 rounded-xl w-full sm:w-fit">
          <button
            type="button"
            onClick={() => setAuthMethod('oauth')}
            className={`flex-1 sm:flex-initial min-h-[40px] px-4 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              authMethod === 'oauth' ? 'bg-emerald-500 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            OAuth Navegador
          </button>
          <button
            type="button"
            onClick={() => setAuthMethod('pat')}
            className={`flex-1 sm:flex-initial min-h-[40px] px-4 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              authMethod === 'pat' ? 'bg-emerald-500 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Token PAT (pt-)
          </button>
          <button
            type="button"
            onClick={() => setAuthMethod('json')}
            className={`flex-1 sm:flex-initial min-h-[40px] px-4 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              authMethod === 'json' ? 'bg-emerald-500 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Importar JSON
          </button>
        </div>

        {authMethod === 'oauth' && (
          <div className="pt-2 space-y-3">
            {!oauthSession ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-zinc-800/70">
                <p className="text-xs text-zinc-400">
                  Usa PKCE S256 oficial do Qoder. Faça login (ou cadastre nova conta) no navegador e o token (30 dias) é capturado automaticamente aqui.
                </p>
                <button
                  type="button"
                  onClick={() => void handleStartOAuth()}
                  disabled={oauthBusy}
                  className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  {oauthBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Conectar / Nova Conta ({realm.toUpperCase()})</span>
                </button>
              </div>
            ) : (
              <div className="pt-3 border-t border-zinc-800/70 space-y-3">
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{oauthStatus || 'Aguardando autorização...'}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={oauthSession.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-sm font-semibold flex items-center gap-2 whitespace-nowrap transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>Abrir Página de Login Qoder</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setOauthSession(null)}
                    className="min-h-[44px] px-4 rounded-xl border border-zinc-800 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {authMethod === 'pat' && (
          <form onSubmit={(e) => void handleImportPat(e)} className="pt-3 border-t border-zinc-800/70 flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={patValue}
              onChange={(e) => setPatValue(e.target.value)}
              placeholder="Cole seu Personal Access Token (pt-...)"
              className="flex-1 min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              disabled={patBusy || !patValue.trim()}
              className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-colors"
            >
              {patBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              <span>Trocar e Conectar</span>
            </button>
          </form>
        )}

        {authMethod === 'json' && (
          <div className="pt-3 border-t border-zinc-800/70 space-y-3">
            <textarea
              rows={4}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder="Cole o array JSON de contas ou carregue um arquivo .json..."
              className="w-full bg-[#090B0E] border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="min-h-[44px] px-4 rounded-xl border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-2 cursor-pointer transition-colors">
                <Upload className="w-4 h-4" />
                <span>Carregar arquivo .json</span>
                <input type="file" accept=".json,application/json" onChange={handleFileUpload} className="hidden" />
              </label>

              <div className="flex items-center gap-2">
                <a
                  href="/api/hub/accounts/export"
                  download="qoder2api-accounts.json"
                  className="min-h-[44px] px-4 rounded-xl border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-300 flex items-center gap-2 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>Exportar Pool</span>
                </a>
                <button
                  type="button"
                  onClick={() => void handleImportJson()}
                  disabled={!jsonText.trim()}
                  className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold transition-colors"
                >
                  Importar
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Qoder Account List */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-zinc-100">
            Contas Qoder Conectadas ({accounts.length})
          </h2>

          {accounts.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={batchBusy !== null}
                onClick={() => void runBatchAction('quota')}
                className="min-h-[44px] px-3.5 rounded-xl border border-zinc-800 bg-[#12151B] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${batchBusy === 'quota' ? 'animate-spin' : ''}`} />
                <span>Atualizar Todas</span>
              </button>
              <button
                type="button"
                disabled={batchBusy !== null}
                onClick={() => void runBatchAction('checkin')}
                className="min-h-[44px] px-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-xs font-medium text-emerald-300 flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                {batchBusy === 'checkin' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Gift className="w-3.5 h-3.5" />
                )}
                <span>Check-in em Todas</span>
              </button>
            </div>
          )}
        </div>

        {accounts.length === 0 ? (
          <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-8 text-center space-y-2">
            <p className="text-sm font-medium text-zinc-200">Nenhuma conta Qoder conectada ainda</p>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Use "OAuth Navegador" acima para logar no Qoder direto pelo celular ou Windows 11, ou importe um token PAT / JSON.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map((acc) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const inCooldown = Boolean(acc.cooldownUntil && acc.cooldownUntil > nowSec);
              const isBusy = busyUid === acc.uid;
              const pct =
                acc.creditsSize && acc.creditsSize > 0 && acc.creditsRemain !== null
                  ? Math.min(100, Math.round((acc.creditsRemain / acc.creditsSize) * 100))
                  : null;

              return (
                <div
                  key={`${acc.realm}-${acc.uid}`}
                  className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-zinc-100 truncate">
                          {acc.nickname}
                        </h3>
                        <p className="text-xs text-zinc-400 font-mono truncate">
                          {acc.realm.toUpperCase()} · {acc.source.toUpperCase()} · {acc.tokenPrefix} · {acc.requestCount} reqs
                        </p>
                      </div>
                      <span
                        className={`text-xs font-medium shrink-0 ${
                          !acc.enabled
                            ? 'text-zinc-500'
                            : inCooldown
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }`}
                      >
                        {!acc.enabled ? 'Pausada' : inCooldown ? 'Em cooldown' : 'Ativa'}
                      </span>
                    </div>

                    <div className="pt-2">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="text-zinc-400">Créditos</span>
                        <span className="font-mono tabular-nums text-zinc-100">
                          {acc.creditsRemain !== null
                            ? `${acc.creditsRemain.toLocaleString('pt-BR')} / ${(acc.creditsSize ?? acc.creditsRemain).toLocaleString('pt-BR')}`
                            : 'Não consultado'}
                        </span>
                      </div>
                      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: `${pct ?? (acc.enabled ? 100 : 0)}%` }}
                        />
                      </div>
                    </div>

                    {acc.lastError && (
                      <p className="text-xs text-amber-400 break-words">{acc.lastError}</p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-zinc-800/70 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void runAccountAction(acc.uid, 'quota')}
                      className="min-h-[44px] px-3 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                      <span>Créditos</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void runAccountAction(acc.uid, 'checkin')}
                      className="min-h-[44px] px-3 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors"
                    >
                      {acc.checkinClaimedToday ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Gift className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      <span>Check-in</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void runAccountAction(acc.uid, 'toggle')}
                      className="min-h-[44px] px-3 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors"
                    >
                      {acc.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      <span>{acc.enabled ? 'Pausar' : 'Ativar'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void runAccountAction(acc.uid, 'delete')}
                      aria-label={`Remover conta ${acc.nickname}`}
                      className="min-h-[44px] min-w-[44px] ml-auto rounded-lg border border-zinc-800 hover:bg-red-950/50 hover:border-red-900 text-zinc-400 hover:text-red-400 flex items-center justify-center transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
