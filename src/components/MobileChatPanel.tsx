import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Cloud, FolderCode, KeyRound, Loader2, Trash2 } from 'lucide-react';
import type {
  ChatMessageItem,
  NavTab,
  QoderModel,
  SafeProviderSummary,
} from '../types/hub';

interface MobileChatPanelProps {
  models: QoderModel[];
  providers: SafeProviderSummary[];
  accountsCount?: number;
  selectedModelId: string;
  onSelectModelId: (id: string) => void;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onNavigate: (tab: NavTab) => void;
  onMessageCompleted: () => void;
  prefillPrompt?: string;
  onConsumePrefill?: () => void;
}

export const MobileChatPanel: React.FC<MobileChatPanelProps> = ({
  models,
  providers,
  selectedModelId,
  onSelectModelId,
  apiFetch,
  onNavigate,
  onMessageCompleted,
  prefillPrompt,
  onConsumePrefill,
}) => {
  const [messages, setMessages] = useState<ChatMessageItem[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hub-chat-history-v1') || '[]');
      return Array.isArray(saved) ? saved.filter((m) => m && typeof m.content === 'string' && typeof m.role === 'string').slice(-200) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('hub-chat-history-v1', JSON.stringify(messages.slice(-200))); } catch { /* Storage quota or private mode. */ }
  }, [messages]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers]);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prefillPrompt && prefillPrompt.trim()) {
      setInput(prefillPrompt);
      onConsumePrefill?.();
    }
  }, [prefillPrompt, onConsumePrefill]);

  const sortedModels = useMemo(() => {
    return models
      .filter((model) =>
        (model.source === 'openrouter' || model.source === 'github' || model.source === 'manual') &&
        model.enable && enabledProviders.some((provider) =>
          provider.provider === model.provider &&
          (!model.baseUrl || provider.baseUrl.replace(/\/+$/, '') === model.baseUrl.replace(/\/+$/, ''))
        )
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [models, enabledProviders]);

  const chatModelId = selectedModelId === 'auto-failover' ||
    sortedModels.some((model) => (model.modelName ?? model.id) === selectedModelId) ||
    enabledProviders.some((provider) => `provider:${provider.id}` === selectedModelId)
    ? selectedModelId : 'auto-failover';

  useEffect(() => {
    if (selectedModelId !== chatModelId) onSelectModelId(chatModelId);
  }, [selectedModelId, chatModelId, onSelectModelId]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending || enabledProviders.length === 0) return;

    const userMsg: ChatMessageItem = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };

    const assistantId = `a-${Date.now() + 1}`;
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setSending(true);

    const startedAt = Date.now();
    try {
      const res = await apiFetch('/api/app/assistant/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chatModelId,
          stream: true,
          messages: nextHistory.filter((m) => !m.error || m.partial).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(errData.error?.message || `Erro HTTP ${res.status}`);
      }

      const decodeHeader = (name: string) => {
        const value = res.headers.get(name);
        if (!value) return undefined;
        try { return decodeURIComponent(value); } catch { return value; }
      };
      const providerMeta = decodeHeader('X-App-Provider');
      const failoverMeta = decodeHeader('X-App-Failover-From');
      const contentType = res.headers.get('content-type') || '';

      if (!contentType.includes('text/event-stream') || !res.body) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        };
        const reply = data.choices?.[0]?.message;
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            role: 'assistant',
            content: reply?.content || 'Resposta vazia recebida do modelo.',
            reasoning: reply?.reasoning_content,
            model: chatModelId,
            provider: providerMeta,
            failoverFrom: failoverMeta,
            latencyMs: Date.now() - startedAt,
            timestamp: Date.now(),
          },
        ]);
        onMessageCompleted();
        return;
      }

      // Live SSE token streaming
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          model: chatModelId,
          provider: providerMeta,
          failoverFrom: failoverMeta,
          timestamp: Date.now(),
        },
      ]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accContent = '';
      let accReasoning = '';
      let completed = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { completed = true; continue; }
          if (!payload) continue;

          try {
            const parsed = JSON.parse(payload) as {
              error?: { message?: string };
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            };
            if (parsed.error?.message) {
              throw new Error(parsed.error.message);
            }
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) accContent += delta.content;
            if (delta?.reasoning_content) accReasoning += delta.reasoning_content;

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: accContent,
                      reasoning: accReasoning || undefined,
                      latencyMs: Date.now() - startedAt,
                    }
                  : m
              )
            );
          } catch (chunkErr) {
            if (chunkErr instanceof Error && chunkErr.message) {
              throw chunkErr;
            }
          }
        }
      }
      if (!completed) throw new Error('Resposta interrompida. O conteúdo parcial foi preservado; verifique a disponibilidade das APIs antes de tentar continuar a conversa.');
      onMessageCompleted();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Falha ao enviar mensagem.';
      setMessages((prev) => {
        const hasTarget = prev.some((m) => m.id === assistantId);
        if (hasTarget) {
          return prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content || errMsg, error: true,
              partial: Boolean(m.content), errorDetail: m.content ? errMsg : undefined } : m
          );
        }
        return [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: errMsg,
            timestamp: Date.now(),
            error: true,
          },
        ];
      });
      onMessageCompleted();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col min-h-[320px] h-[calc(100dvh-196px)] sm:h-[calc(100dvh-148px)] md:h-[calc(100dvh-120px)] bg-[#12151B] border border-zinc-800/80 rounded-2xl overflow-hidden">
      {/* Chat Header Bar */}
      <div className="px-3 sm:px-4 py-3 border-b border-zinc-800/80 bg-[#0E1116] space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-1 items-center gap-2 min-w-0 max-w-full">
            <Cloud className="w-4 h-4 text-emerald-400 shrink-0" />
            <select
              aria-label="Selecionar modelo de API configurada"
              value={chatModelId}
              onChange={(e) => onSelectModelId(e.target.value)}
              className="min-w-0 w-full min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 text-sm font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 sm:max-w-xs"
            >
              <option value="auto-failover">Auto: fila de APIs configuradas</option>
              {sortedModels.map((model) => (
                <option key={model.key} value={model.modelName ?? model.id}>
                  {model.displayName} · {model.provider}{model.pricing?.prompt === 0 && model.pricing?.completion === 0 ? ' · Grátis (preço/token = 0)' : ''}
                </option>
              ))}
              {enabledProviders.map((provider) => (
                <option key={provider.id} value={`provider:${provider.id}`}>
                  {provider.name} ({provider.defaultModel})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onNavigate('projects')}
              className="min-h-[40px] px-3 rounded-lg border border-zinc-800 hover:border-emerald-500/60 hover:text-emerald-300 text-xs font-medium text-zinc-300 flex items-center gap-1.5 transition-colors"
            >
              <FolderCode className="w-3.5 h-3.5 text-emerald-400" />
              <span>Projetos</span>
            </button>
            <button
              type="button"
              onClick={() => setMessages([])}
              disabled={messages.length === 0 || sending}
              className="min-h-[40px] px-3 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpar</span>
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-400">O Chat é uma conversa com as APIs configuradas; não edita arquivos nem executa comandos. Use Projetos para editar e compilar com as assistentes de código.</p>
      </div>

      {/* Messages Viewport */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="max-w-md mx-auto my-8 p-5 rounded-2xl border border-zinc-800 bg-[#090B0E] text-center space-y-3">
            <KeyRound className="w-8 h-8 text-emerald-400 mx-auto" />
            <h3 className="text-base font-semibold text-zinc-100">
              {enabledProviders.length === 0 ? 'Nenhuma API de IA ativada' : `Converse com ${enabledProviders.length} ${enabledProviders.length === 1 ? 'API configurada' : 'APIs configuradas'}`}
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {enabledProviders.length === 0
                ? 'Configure ou ative um provedor na aba APIs IA para começar a conversa.'
                : 'A conversa usa apenas suas APIs configuradas. A troca automática depende da fila e da disponibilidade dos provedores; se nenhum puder responder, aguarde ou ajuste as APIs.'}
            </p>
            <button
              type="button"
              onClick={() => onNavigate('apis')}
              className="w-full min-h-[44px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold transition-colors"
            >
              {enabledProviders.length === 0 ? 'Configurar APIs IA' : 'Gerenciar APIs IA'}
            </button>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          const showReasoning = Boolean(expandedReasoning[msg.id]);

          return (
            <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[88%] sm:max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  isUser
                    ? 'bg-zinc-800 text-zinc-100'
                    : msg.error
                      ? 'bg-red-950/40 border border-red-900/60 text-red-200'
                      : 'text-zinc-100'
                }`}
              >
                {msg.reasoning && (
                  <div className="mb-2 pb-2 border-b border-zinc-800">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedReasoning((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))
                      }
                      className="text-xs font-medium text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
                    >
                      {showReasoning ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <span>Raciocínio do modelo</span>
                    </button>
                    {showReasoning && (
                      <p className="mt-1.5 text-xs text-zinc-400 whitespace-pre-wrap">{msg.reasoning}</p>
                    )}
                  </div>
                )}
                {msg.content || (sending ? '...' : '')}
                {msg.errorDetail && <p className="mt-3 text-xs text-amber-300">{msg.errorDetail}</p>}
              </div>

              {!isUser && (
                <div className="mt-1 px-1 text-[11px] text-zinc-500 font-mono tabular-nums flex flex-wrap items-center gap-1.5">
                  <span>{msg.model || chatModelId}</span>
                  {msg.provider && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-400">{msg.provider}</span>
                    </>
                  )}
                  {msg.failoverFrom && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-400">Failover de {msg.failoverFrom}</span>
                    </>
                  )}
                  {msg.latencyMs && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{msg.latencyMs} ms</span>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-1">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
            <span>{chatModelId === 'auto-failover' ? 'Aguardando resposta das APIs configuradas...' : `Recebendo resposta de ${chatModelId}...`}</span>
          </div>
        )}
        <div ref={listEndRef} />
      </div>

      {/* Bottom Composer */}
      <form
        onSubmit={(e) => void handleSend(e)}
        className="p-3 border-t border-zinc-800/80 bg-[#0E1116]"
      >
        <div className="flex items-end gap-2 bg-[#161A22] border border-zinc-800 rounded-3xl pl-4 pr-1.5 py-1.5">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            aria-label="Mensagem para a API de IA"
            placeholder={enabledProviders.length === 0 ? 'Configure uma API para conversar...' : 'Digite sua mensagem para a IA...'}
            className="flex-1 min-w-0 bg-transparent py-2 text-sm text-zinc-100 placeholder:text-zinc-500 resize-none focus:outline-none max-h-32"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending || enabledProviders.length === 0}
            aria-label="Enviar mensagem"
            className="w-10 h-10 rounded-full bg-zinc-100 hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 flex items-center justify-center shrink-0 transition-colors"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
};
