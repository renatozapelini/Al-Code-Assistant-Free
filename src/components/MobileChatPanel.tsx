import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Cloud, FolderCode, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import type { ChatMessageItem, NavTab, QoderModel, SafeProviderSummary } from '../types/hub';

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

type Message = ChatMessageItem & { actionLog?: string[] };
interface ChatSession { id: string; title: string; createdAt: number; updatedAt: number; messages: Message[] }
const STORE = 'hub-free-chats-v1';
const LEGACY_STORE = 'hub-chat-history-v1';
const MAX_CHATS = 50;
const MAX_MESSAGES = 200;
const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const newChat = (title = 'Nova conversa', messages: Message[] = []): ChatSession => {
  const now = Date.now();
  return { id: makeId('chat'), title, createdAt: now, updatedAt: now, messages: messages.slice(-MAX_MESSAGES) };
};
const cleanMessages = (value: unknown): Message[] => Array.isArray(value) ? value.filter((entry): entry is Message => {
  if (!entry || typeof entry !== 'object') return false;
  const message = entry as Partial<Message>;
  return typeof message.id === 'string' && typeof message.content === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system');
}).slice(-MAX_MESSAGES) : [];

const loadChats = (): ChatSession[] => {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const chats = parsed.filter((entry): entry is ChatSession => {
          if (!entry || typeof entry !== 'object') return false;
          const chat = entry as Partial<ChatSession>;
          return typeof chat.id === 'string' && typeof chat.title === 'string';
        }).slice(0, MAX_CHATS).map((chat) => ({
          ...chat,
          createdAt: typeof chat.createdAt === 'number' ? chat.createdAt : Date.now(),
          updatedAt: typeof chat.updatedAt === 'number' ? chat.updatedAt : Date.now(),
          messages: cleanMessages(chat.messages),
        }));
        if (chats.length) return chats;
      }
    }
    const legacy = raw === null ? cleanMessages(JSON.parse(localStorage.getItem(LEGACY_STORE) || '[]')) : [];
    const initial = newChat(legacy.length ? 'Conversa anterior' : 'Nova conversa', legacy);
    try { localStorage.setItem(STORE, JSON.stringify([initial])); } catch { /* Storage unavailable. */ }
    return [initial];
  } catch { return [newChat()]; }
};

const unavailableReason = (provider: SafeProviderSummary, now: number) => {
  if (!provider.enabled) return 'Pausada';
  if (provider.cooldownUntil && provider.cooldownUntil > now) return 'Aguardando';
  if (provider.lastError) return 'Falhou';
  if (provider.requestCount <= 0) return 'Ainda não testada';
  return undefined;
};

export const MobileChatPanel: React.FC<MobileChatPanelProps> = ({
  models: _models,
  providers,
  selectedModelId,
  onSelectModelId,
  apiFetch,
  onNavigate,
  onMessageCompleted,
  prefillPrompt,
  onConsumePrefill,
}) => {
  const [chats, setChats] = useState<ChatSession[]>(loadChats);
  const [activeId, setActiveId] = useState(() => chats[0]?.id || '');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement | null>(null);
  const activeChat = chats.find((chat) => chat.id === activeId) || chats[0];
  const messages = activeChat?.messages || [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const providerOptions = providers.map((provider) => ({ provider, reason: unavailableReason(provider, nowSeconds) }));
  const workingProviders = providerOptions.filter(({ reason }) => !reason).map(({ provider }) => provider);
  const explicitProvider = providers.find((provider) => `provider:${provider.id}` === selectedModelId);
  const selectedAi = explicitProvider ? selectedModelId : 'auto-failover';
  const canSelectedProviderAnswer = explicitProvider
    ? !unavailableReason(explicitProvider, nowSeconds)
    : workingProviders.length > 0;

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(chats.slice(0, MAX_CHATS).map((chat) => ({
        ...chat, messages: chat.messages.slice(-MAX_MESSAGES),
      }))));
    } catch { /* Storage quota or private mode. */ }
  }, [chats]);
  useEffect(() => {
    if (!chats.some((chat) => chat.id === activeId)) setActiveId(chats[0]?.id || '');
  }, [chats, activeId]);
  useEffect(() => {
    if (!explicitProvider && selectedModelId !== 'auto-failover') onSelectModelId('auto-failover');
  }, [explicitProvider, selectedModelId, onSelectModelId]);
  useEffect(() => {
    if (prefillPrompt?.trim()) { setInput(prefillPrompt); onConsumePrefill?.(); }
  }, [prefillPrompt, onConsumePrefill]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, sending]);

  const updateChat = (id: string, update: (chat: ChatSession) => ChatSession) => {
    setChats((current) => current.map((chat) => chat.id === id ? update(chat) : chat));
  };
  const updateAssistant = (chatId: string, messageId: string, update: (message: Message) => Message) => {
    updateChat(chatId, (chat) => ({
      ...chat,
      updatedAt: Date.now(),
      messages: chat.messages.map((message) => message.id === messageId ? update(message) : message),
    }));
  };
  const createChat = () => {
    if (sending) return;
    const chat = newChat();
    setChats((current) => [chat, ...current].slice(0, MAX_CHATS));
    setActiveId(chat.id);
    setInput('');
  };
  const deleteChat = () => {
    if (sending || !activeChat) return;
    const remaining = chats.filter((chat) => chat.id !== activeChat.id);
    const next = remaining.length ? remaining : [newChat()];
    setChats(next);
    setActiveId(next[0].id);
    setInput('');
  };

  const handleSend = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || !activeChat || !canSelectedProviderAnswer) return;
    const chatId = activeChat.id;
    const userMessage: Message = { id: makeId('u'), role: 'user', content: text, timestamp: Date.now() };
    const assistantId = makeId('a');
    const model = explicitProvider ? `provider:${explicitProvider.id}` : 'auto-failover';
    const providerIds = explicitProvider ? [explicitProvider.id] : workingProviders.map((provider) => provider.id);
    const requestHistory = [...activeChat.messages, userMessage].slice(-MAX_MESSAGES);
    const placeholder: Message = {
      id: assistantId, role: 'assistant', content: '', model, timestamp: Date.now(),
      actionLog: ['Preparando contexto', 'Selecionando...', 'Enviando...'],
    };
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.title === 'Nova conversa' && !chat.messages.some((message) => message.role === 'user')
        ? text.slice(0, 56) : chat.title,
      updatedAt: Date.now(),
      messages: [...requestHistory, placeholder].slice(-MAX_MESSAGES),
    }));
    setInput('');
    setSending(true);
    const startedAt = Date.now();

    try {
      const response = await apiFetch('/api/app/assistant/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          assistant_provider_ids: providerIds,
          stream: true,
          messages: requestHistory.filter((message) => !message.error || message.partial)
            .map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(data.error?.message || `Erro HTTP ${response.status}`);
      }
      const header = (name: string) => {
        const value = response.headers.get(name);
        if (!value) return undefined;
        try { return decodeURIComponent(value); } catch { return value; }
      };
      const provider = header('X-App-Provider');
      const failoverFrom = header('X-App-Failover-From');
      const actions = [
        'Preparando contexto', 'Selecionando...', 'Enviando...',
        ...(provider ? [`Conectado à IA ${provider}`] : []),
        ...(failoverFrom ? [`Troca real após falha de ${failoverFrom}`] : []),
        'Recebendo',
      ];
      updateAssistant(chatId, assistantId, (message) => ({ ...message, provider, failoverFrom, actionLog: actions }));

      if (!(response.headers.get('content-type') || '').includes('text/event-stream') || !response.body) {
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
        const reply = data.choices?.[0]?.message;
        updateAssistant(chatId, assistantId, (message) => ({
          ...message,
          content: reply?.content || 'Resposta vazia recebida da IA.',
          reasoning: reply?.reasoning_content,
          latencyMs: Date.now() - startedAt,
          actionLog: [...actions, 'Resposta concluída'],
        }));
        onMessageCompleted();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let completed = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { completed = true; continue; }
          if (!payload) continue;
          let parsed: { error?: { message?: string }; choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> };
          try { parsed = JSON.parse(payload) as typeof parsed; } catch { continue; }
          if (parsed.error?.message) throw new Error(parsed.error.message);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          updateAssistant(chatId, assistantId, (message) => ({
            ...message, content, reasoning: reasoning || undefined, latencyMs: Date.now() - startedAt,
          }));
        }
      }
      if (!completed) throw new Error('Resposta interrompida. O conteúdo parcial foi preservado; verifique a disponibilidade das APIs antes de tentar continuar a conversa.');
      updateAssistant(chatId, assistantId, (message) => ({
        ...message,
        content: message.content || (message.reasoning ? '' : 'Resposta vazia recebida da IA.'),
        latencyMs: Date.now() - startedAt,
        actionLog: [...actions, 'Resposta concluída'],
      }));
      onMessageCompleted();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha ao enviar mensagem.';
      updateAssistant(chatId, assistantId, (message) => {
        const partial = Boolean(message.content || message.reasoning);
        return {
          ...message,
          content: message.content || detail,
          error: true,
          partial,
          errorDetail: partial ? detail : undefined,
          latencyMs: Date.now() - startedAt,
          actionLog: [...(message.actionLog || []), `Erro real: ${detail}`],
        };
      });
      onMessageCompleted();
    } finally { setSending(false); }
  };

  return (
    <div className="flex flex-col min-h-[320px] h-[calc(100dvh-196px)] sm:h-[calc(100dvh-148px)] md:h-[calc(100dvh-120px)] bg-[#12151B] border border-zinc-800/80 rounded-2xl overflow-hidden">
      <div className="px-3 sm:px-4 py-3 border-b border-zinc-800/80 bg-[#0E1116] space-y-2.5">
        <div className="flex items-center gap-2">
          <Cloud className="w-4 h-4 text-emerald-400 shrink-0" />
          <select aria-label="Selecionar conversa" value={activeChat?.id || ''} onChange={(event) => setActiveId(event.target.value)} disabled={sending}
            className="min-w-0 flex-1 min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 text-sm font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60">
            {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
          </select>
          <button type="button" onClick={createChat} disabled={sending} className="min-h-[40px] px-3 rounded-lg border border-zinc-800 text-xs font-medium text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-300 disabled:opacity-40 flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Nova
          </button>
          <button type="button" onClick={deleteChat} disabled={sending} aria-label="Excluir conversa" title="Excluir conversa"
            className="min-h-[40px] min-w-[40px] rounded-lg text-zinc-400 hover:text-red-300 disabled:opacity-40 flex items-center justify-center">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input aria-label="Título da conversa" value={activeChat?.title || ''} disabled={sending} maxLength={100}
            onChange={(event) => activeChat && updateChat(activeChat.id, (chat) => ({ ...chat, title: event.target.value.slice(0, 100), updatedAt: Date.now() }))}
            onBlur={() => activeChat && !activeChat.title.trim() && updateChat(activeChat.id, (chat) => ({ ...chat, title: 'Nova conversa', updatedAt: Date.now() }))}
            className="min-w-0 flex-1 bg-transparent border-b border-zinc-800 px-1 py-1 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500 disabled:opacity-60" />
          <button type="button" onClick={() => onNavigate('projects')} className="shrink-0 text-xs font-medium text-emerald-400 hover:text-emerald-300 underline underline-offset-4 flex items-center gap-1">
            <FolderCode className="w-3.5 h-3.5" /> Projetos
          </button>
        </div>
        <p className="text-xs text-zinc-400">Chat livre por assunto · mostra API, troca e etapas reais · desenvolvido com Qoder</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="max-w-md mx-auto my-8 p-5 rounded-2xl border border-zinc-800 bg-[#090B0E] text-center space-y-3">
            <KeyRound className="w-8 h-8 text-emerald-400 mx-auto" />
            <h3 className="text-base font-semibold text-zinc-100">{workingProviders.length ? `Converse com ${workingProviders.length} ${workingProviders.length === 1 ? 'API testada' : 'APIs testadas'}` : 'Nenhuma API pronta para responder'}</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {workingProviders.length ? 'Escolha uma IA antes de enviar ou use a opção automática, que considera somente APIs disponíveis e já testadas.' : 'Salve e teste uma API na aba APIs IA. APIs pausadas, aguardando, com falha ou ainda não testadas continuam visíveis, mas não podem responder.'}
            </p>
            <button type="button" onClick={() => onNavigate('apis')} className="w-full min-h-[44px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold">
              {workingProviders.length ? 'Gerenciar APIs IA' : 'Salvar e testar APIs IA'}
            </button>
          </div>
        )}

        {messages.map((message) => {
          const isUser = message.role === 'user';
          const showReasoning = Boolean(expandedReasoning[message.id]);
          const pending = sending && message.id === messages[messages.length - 1]?.id;
          return (
            <div key={message.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[88%] sm:max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${isUser ? 'bg-zinc-800 text-zinc-100' : message.error ? 'bg-red-950/40 border border-red-900/60 text-red-200' : 'text-zinc-100'}`}>
                {!isUser && message.actionLog?.length ? (
                  <details className="mb-2 pb-2 border-b border-zinc-800" open={pending}>
                    <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-200">O que a IA está fazendo</summary>
                    <ol className="mt-2 space-y-1 text-xs text-zinc-400 list-decimal list-inside">
                      {message.actionLog.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
                    </ol>
                  </details>
                ) : null}
                {message.reasoning && (
                  <div className="mb-2 pb-2 border-b border-zinc-800">
                    <button type="button" onClick={() => setExpandedReasoning((current) => ({ ...current, [message.id]: !current[message.id] }))} className="text-xs font-medium text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                      {showReasoning ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Raciocínio do modelo
                    </button>
                    {showReasoning && <p className="mt-1.5 text-xs text-zinc-400 whitespace-pre-wrap">{message.reasoning}</p>}
                  </div>
                )}
                {message.content || (pending ? 'Aguardando dados reais da resposta...' : '')}
                {message.errorDetail && <p className="mt-3 text-xs text-amber-300">{message.errorDetail}</p>}
              </div>
              {!isUser && (
                <div className="mt-1 px-1 text-[11px] text-zinc-500 font-mono tabular-nums flex flex-wrap items-center gap-1.5">
                  <span>{message.model || selectedAi}</span>
                  {message.provider && <><span>·</span><span className="text-emerald-400">{message.provider}</span></>}
                  {message.failoverFrom && <><span>·</span><span className="text-amber-400">Troca após {message.failoverFrom}</span></>}
                  {typeof message.latencyMs === 'number' && <><span>·</span><span>{message.latencyMs} ms</span></>}
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <form onSubmit={(event) => void handleSend(event)} className="p-3 border-t border-zinc-800/80 bg-[#0E1116] space-y-2">
        <select aria-label="Escolher IA para responder" value={selectedAi} onChange={(event) => onSelectModelId(event.target.value)} disabled={sending}
          className="w-full min-h-[40px] bg-zinc-900 border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60">
          <option value="auto-failover" disabled={!workingProviders.length}>Automática · {workingProviders.length ? `${workingProviders.length} ${workingProviders.length === 1 ? 'IA disponível' : 'IAs disponíveis'}` : 'nenhuma IA funcionando'}</option>
          {providerOptions.map(({ provider, reason }) => (
            <option key={provider.id} value={`provider:${provider.id}`} disabled={Boolean(reason)}>{provider.name} ({provider.defaultModel}){reason ? ` — ${reason}` : ''}</option>
          ))}
        </select>
        {!canSelectedProviderAnswer && <p className="px-1 text-xs text-amber-300">Salve e teste uma API em APIs IA antes de enviar.</p>}
        <div className="flex items-end gap-2 bg-[#161A22] border border-zinc-800 rounded-3xl pl-4 pr-1.5 py-1.5">
          <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSend(); } }}
            aria-label="Mensagem para a API de IA" placeholder={workingProviders.length ? 'Digite sua mensagem para a IA...' : 'Salve e teste uma API para conversar...'}
            className="flex-1 min-w-0 bg-transparent py-2 text-sm text-zinc-100 placeholder:text-zinc-500 resize-none focus:outline-none max-h-32" />
          <button type="submit" disabled={!input.trim() || sending || !canSelectedProviderAnswer} aria-label="Enviar mensagem"
            className="w-10 h-10 rounded-full bg-zinc-100 hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 flex items-center justify-center shrink-0">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
};
