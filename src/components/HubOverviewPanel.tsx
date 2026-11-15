import React, { useState } from 'react';
import { ArrowRight, BarChart3, Check, Copy, Download, FileCode2, MessageSquare, RefreshCw, ShieldAlert, Users } from 'lucide-react';
import type { HubOverview, NavTab } from '../types/hub';

interface HubOverviewPanelProps {
  overview: HubOverview | null;
  loading: boolean;
  onRefresh: () => void;
  onNavigate: (tab: NavTab) => void;
}

export const HubOverviewPanel: React.FC<HubOverviewPanelProps> = ({
  overview,
  loading,
  onRefresh,
  onNavigate,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const endpoints = [
    { id: 'openai', label: 'OpenAI Chat Completions', url: `${origin}/v1` },
    { id: 'responses', label: 'Codex Responses API', url: `${origin}/v1/responses` },
    { id: 'anthropic', label: 'Claude Code (Anthropic)', url: origin },
  ];

  const handleCopy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const accountsEnabled = overview?.totals.accountsEnabled ?? 0;
  const accountsTotal = overview?.totals.accountsTotal ?? 0;
  const providersEnabled = overview?.totals.providersEnabled ?? 0;
  const creditsRemain = overview?.totals.creditsRemain ?? 0;
  const totalRequests = overview?.totals.totalRequests ?? 0;
  const riskTotal =
    (overview?.risk.queueCount ?? 0) +
    (overview?.risk.rateLimitCount ?? 0) +
    (overview?.risk.rejectedCount ?? 0);

  return (
    <div className="space-y-6">
      {/* Header / Focal Anchor */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-400">
              App Tudo-em-Um · Região padrão {overview?.defaultRealm === 'cn' ? 'China (qoder.com.cn)' : 'Global (qoder.com)'}
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50 text-balance">
              Hub Multi-IA de Código (Android &amp; Windows 11)
            </h1>
            <p className="text-sm text-zinc-400 max-w-2xl">
              Conecte qualquer IA gratuita ou paga de programação (Pollinations, OpenRouter :free, Gemini, Groq, Cerebras, GitHub Models, Ollama/LM Studio ou Qoder) com descoberta automática, failover em cascata e agente de compilação APK + EXE.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onRefresh}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-800 bg-zinc-900/70 hover:bg-zinc-800 text-zinc-200 text-sm font-medium flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>Atualizar</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-sm font-semibold flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              <span>Abrir Chat IA</span>
            </button>
          </div>
        </div>

        {/* 4-column metric strip */}
        <div className="mt-6 pt-5 border-t border-zinc-800/80 grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          <div>
            <div className="text-xs text-zinc-400">Pool Qoder + APIs IA</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-50">
              {accountsEnabled + providersEnabled}
              <span className="text-sm font-normal text-zinc-500"> / {accountsTotal + (overview?.totals.providersTotal ?? 0)}</span>
            </div>
            <div className="mt-0.5 text-xs text-emerald-400">
              {providersEnabled > 0 ? `${providersEnabled} APIs failover prontas` : accountsEnabled > 0 ? 'Rotação Qoder pronta' : 'Aguardando conta/API'}
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400">Créditos Restantes</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-50">
              {creditsRemain.toLocaleString('pt-BR')}
            </div>
            <div className="mt-0.5 text-xs text-zinc-400 tabular-nums">
              {overview?.totals.creditsUsed ? `${overview.totals.creditsUsed.toLocaleString('pt-BR')} usados` : 'Sincronização sob demanda'}
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400">Requisições Atendidas</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-50">
              {totalRequests.toLocaleString('pt-BR')}
            </div>
            <div className="mt-0.5 text-xs text-zinc-400">
              Chat Mobile / OpenAI / Anthropic
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400">Sinais Anti-Bloqueio</div>
            <div className={`mt-1 text-2xl font-bold font-mono tabular-nums ${riskTotal > 0 ? 'text-amber-400' : 'text-zinc-50'}`}>
              {riskTotal}
            </div>
            <div className="mt-0.5 text-xs text-zinc-400">
              {riskTotal > 0 ? 'Cooldown automático ativo' : 'Operação nominal'}
            </div>
          </div>
        </div>
      </section>

      {/* Two-column split: Quick Actions + API Endpoints */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <section className="lg:col-span-5 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col justify-between gap-5">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-zinc-100">Ações Rápidas</h2>
            <p className="text-xs text-zinc-400">
              Adicione suas APIs de IA, conecte contas ou finalize e compile seu APK Android e EXE Windows 11.
            </p>
          </div>

          <div className="divide-y divide-zinc-800/70">
            <button
              type="button"
              onClick={() => onNavigate('apis')}
              className="w-full min-h-[56px] py-3 flex items-center justify-between gap-3 text-left hover:text-emerald-400 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Users className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100 truncate">Descobrir &amp; Adicionar IAs Grátis (24+)</div>
                  <div className="text-xs text-zinc-400 truncate">OpenRouter :free, Pollinations, Gemini, Groq, Cerebras, Ollama</div>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>

            <button
              type="button"
              onClick={() => onNavigate('scripts')}
              className="w-full min-h-[56px] py-3 flex items-center justify-between gap-3 text-left hover:text-emerald-400 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <FileCode2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100 truncate">Gerador de Script para Code Assistant</div>
                  <div className="text-xs text-zinc-400 truncate">Junte ideias soltas e detalhe tudo com IA antes de programar</div>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>

            <button
              type="button"
              onClick={() => onNavigate('analytics')}
              className="w-full min-h-[56px] py-3 flex items-center justify-between gap-3 text-left hover:text-emerald-400 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <BarChart3 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100 truncate">Analytics de Tokens &amp; Confiabilidade</div>
                  <div className="text-xs text-zinc-400 truncate">Gráficos de tokens, taxa de falha e custo-benefício por IA</div>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>

            <button
              type="button"
              onClick={() => onNavigate('android')}
              className="w-full min-h-[56px] py-3 flex items-center justify-between gap-3 text-left hover:text-emerald-400 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Download className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100 truncate">Agente de Compilação (APK + EXE Win11)</div>
                  <div className="text-xs text-zinc-400 truncate">Finalizar projeto, validar build e baixar binários prontos</div>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>

            <button
              type="button"
              onClick={() => onNavigate('models')}
              className="w-full min-h-[56px] py-3 flex items-center justify-between gap-3 text-left hover:text-emerald-400 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <MessageSquare className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100 truncate">Explorar Catálogo de Modelos (0x Grátis)</div>
                  <div className="text-xs text-zinc-400 truncate">Veja multiplicadores de créditos e teste no chat</div>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>
          </div>
        </section>

        <section className="lg:col-span-7 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-zinc-100">Endpoints de Protocolo Ativos</h2>
            <p className="text-xs text-zinc-400">
              Para conectar apps externos (Chatbox, Cherry Studio, Codex, Claude Code) a este Hub.
            </p>
          </div>

          <div className="divide-y divide-zinc-800/70">
            {endpoints.map((ep) => (
              <div key={ep.id} className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-zinc-400">{ep.label}</div>
                  <div className="mt-0.5 text-xs sm:text-sm font-mono text-zinc-100 truncate">
                    {ep.url}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy(ep.id, ep.url)}
                  className="min-h-[44px] min-w-[44px] px-3 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-xs font-medium flex items-center justify-center gap-1.5 shrink-0 transition-colors"
                >
                  {copiedId === ep.id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copiado</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copiar</span>
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Request Logs */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Histórico Recente de Requisições</h2>
            <p className="text-xs text-zinc-400">Tráfego roteado pelo pool de contas com latência e região</p>
          </div>
          {overview?.risk.lastSignalDetail && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-amber-400">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span className="truncate max-w-xs">{overview.risk.lastSignalDetail}</span>
            </div>
          )}
        </div>

        {!overview || overview.recentLogs.length === 0 ? (
          <div className="py-10 text-center border-t border-zinc-800/70">
            <p className="text-sm text-zinc-300">Nenhuma requisição registrada ainda nesta sessão.</p>
            <p className="mt-1 text-xs text-zinc-500">
              Adicione uma conta na aba Contas e envie uma mensagem pelo Chat.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-zinc-800/70">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800/70 text-xs text-zinc-400">
                  <th className="py-2.5 pr-4 font-medium">Hora</th>
                  <th className="py-2.5 pr-4 font-medium">Modelo</th>
                  <th className="py-2.5 pr-4 font-medium">Protocolo</th>
                  <th className="py-2.5 pr-4 font-medium">Conta</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Status</th>
                  <th className="py-2.5 font-medium text-right">Latência</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-xs sm:text-sm">
                {overview.recentLogs.slice(0, 15).map((log) => (
                  <tr key={log.id} className="hover:bg-zinc-900/40">
                    <td className="py-2.5 pr-4 font-mono tabular-nums text-zinc-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString('pt-BR')}
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-zinc-100 whitespace-nowrap">
                      {log.model}
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-400 whitespace-nowrap">
                      {log.protocol} · {log.realm.toUpperCase()}
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-300 whitespace-nowrap">
                      {log.provider ? `${log.provider}${log.failoverFrom ? ` (failover)` : ''}` : (log.accountNickname || '—')}
                    </td>
                    <td className={`py-2.5 pr-4 font-mono tabular-nums text-right whitespace-nowrap ${log.status < 400 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {log.status}
                    </td>
                    <td className="py-2.5 font-mono tabular-nums text-right text-zinc-300 whitespace-nowrap">
                      {log.latencyMs} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
