import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Cloud, Hammer, Loader2, Trash2, Users } from 'lucide-react';
import type {
  ChatMessageItem,
  NavTab,
  QoderModel,
  RealmId,
  SafeProviderSummary,
} from '../types/hub';

interface MobileChatPanelProps {
  models: QoderModel[];
  providers: SafeProviderSummary[];
  accountsCount: number;
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
  accountsCount,
  selectedModelId,
  onSelectModelId,
  apiFetch,
  onNavigate,
  onMessageCompleted,
  prefillPrompt,
  onConsumePrefill,
}) => {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [realmOverride, setRealmOverride] = useState<'auto' | RealmId>('auto');
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prefillPrompt && prefillPrompt.trim()) {
      setInput(prefillPrompt);
      onConsumePrefill?.();
    }
  }, [prefillPrompt, onConsumePrefill]);

  // Put 0x free models at the top for immediate access without paid credits
  const sortedModels = useMemo(() => {
    return [...models].sort((a, b) => a.priceFactor - b.priceFactor);
  }, [models]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (realmOverride !== 'auto') {
        headers['X-Realm'] = realmOverride;
      }

      const res = await apiFetch('/api/hub/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModelId,
          stream: true,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(errData.error?.message || `Erro HTTP ${res.status}`);
      }

      const realmMeta = (res.headers.get('X-Qoder-Realm') as RealmId | null) || undefined;
      const accountMeta = res.headers.get('X-Qoder-Account') || undefined;
      const providerMeta = res.headers.get('X-Qoder-Provider') || undefined;
      const failoverMeta = res.headers.get('X-Qoder-Failover-From') || undefined;
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
            model: selectedModelId,
            realm: realmMeta,
            provider: providerMeta,
            failoverFrom: failoverMeta,
            accountNickname: accountMeta,
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
          model: selectedModelId,
          realm: realmMeta,
          provider: providerMeta,
          failoverFrom: failoverMeta,
          accountNickname: accountMeta,
          timestamp: Date.now(),
        },
      ]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accContent = '';
      let accReasoning = '';

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
          if (!payload || payload === '[DONE]') continue;

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
      onMessageCompleted();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Falha ao enviar mensagem.';
      setMessages((prev) => {
        const hasTarget = prev.some((m) => m.id === assistantId);
        if (hasTarget) {
          return prev.map((m) =>
            m.id === assistantId ? { ...m, content: errMsg, error: true } : m
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
    <div className="flex flex-col h-[calc(100vh-148px)] md:h-[calc(100vh-120px)] bg-[#12151B] border border-zinc-800/80 rounded-2xl overflow-hidden">
      {/* Chat Header Bar */}
      <div className="px-4 py-3 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 bg-[#0E1116]">
        <div className="flex items-center gap-2 min-w-0">
          <Cloud className="w-4 h-4 text-emerald-400 shrink-0" />
          <select
            aria-label="Selecionar modelo"
            value={selectedModelId}
            onChange={(e) => onSelectModelId(e.target.value)}
            className="min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 text-sm font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 max-w-[215px] sm:max-w-xs"
          >
            <option value="auto-failover">Auto: Cadeia Multi-IA (Sem Parar)</option>
            {sortedModels.map((m) => (
              <option key={`${m.key}-${m.id}`} value={m.id}>
                {m.displayName} ({m.priceFactor === 0 ? '0x Grátis' : `${m.priceFactor}x`})
              </option>
            ))}
            {providers
              .filter((p) => p.enabled)
              .map((p) => (
                <option key={p.id} value={`provider:${p.id}`}>
                  {p.name} ({p.defaultModel})
                </option>
              ))}
          </select>

          <select
            aria-label="Selecionar região"
            value={realmOverride}
            onChange={(e) => setRealmOverride(e.target.value as 'auto' | RealmId)}
            className="min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 text-xs font-medium text-zinc-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="auto">Região: Auto</option>
            <option value="intl">Global</option>
            <option value="cn">China</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onNavigate('android')}
            className="min-h-[40px] px-3 rounded-lg border border-zinc-800 hover:border-emerald-500/60 hover:text-emerald-300 text-xs font-medium text-zinc-300 flex items-center gap-1.5 transition-colors"
          >
            <Hammer className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Agente de Compilação</span>
            <span className="sm:hidden">Compilar</span>
          </button>

          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={messages.length === 0}
            className="min-h-[40px] px-3 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Limpar</span>
          </button>
        </div>
      </div>

      {/* Messages Viewport */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {accountsCount === 0 && messages.length === 0 && (
          <div className="max-w-md mx-auto my-8 p-5 rounded-2xl border border-zinc-800 bg-[#090B0E] text-center space-y-3">
            <Users className="w-8 h-8 text-emerald-400 mx-auto" />
            <h3 className="text-base font-semibold text-zinc-100">Nenhuma conta ou API conectada</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Adicione suas chaves de IA (OpenAI, Claude, DeepSeek, Grok, Gemini, Groq, OpenRouter, Ollama) ou conecte contas Qoder para o failover automático nunca parar.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onNavigate('apis')}
                className="w-full min-h-[44px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold transition-colors"
              >
                Adicionar APIs IA
              </button>
              <button
                type="button"
                onClick={() => onNavigate('accounts')}
                className="w-full min-h-[44px] rounded-xl border border-zinc-700 hover:bg-zinc-800 text-zinc-100 text-xs font-semibold transition-colors"
              >
                Conectar Qoder
              </button>
            </div>
          </div>
        )}

        {accountsCount > 0 && messages.length === 0 && (
          <div className="max-w-md mx-auto my-12 text-center space-y-2">
            <p className="text-sm font-medium text-zinc-200">
              Pool ativo com {accountsCount} {accountsCount === 1 ? 'conexão' : 'conexões'} de IA
            </p>
            <p className="text-xs text-zinc-400">
              Se uma conta atingir limite ou ficar sem créditos, o gateway alterna automaticamente para <span className="text-emerald-400 font-medium">0x Grátis</span> ou para sua próxima API conectada.
            </p>
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
              </div>

              {!isUser && (
                <div className="mt-1 px-1 text-[11px] text-zinc-500 font-mono tabular-nums flex flex-wrap items-center gap-1.5">
                  <span>{msg.model || selectedModelId}</span>
                  {msg.provider && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-400">{msg.provider}</span>
                    </>
                  )}
                  {msg.accountNickname && msg.accountNickname !== msg.provider && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{msg.accountNickname}</span>
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
            <span>Recebendo resposta de {selectedModelId}...</span>
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
            placeholder="Digite sua mensagem para o Qoder..."
            className="flex-1 bg-transparent py-2 text-sm text-zinc-100 placeholder:text-zinc-500 resize-none focus:outline-none max-h-32"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
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
