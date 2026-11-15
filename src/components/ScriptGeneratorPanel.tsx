import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileCode2,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { NavTab, QoderModel, SafeProviderSummary } from '../types/hub';

interface ScriptGeneratorPanelProps {
  models: QoderModel[];
  providers: SafeProviderSummary[];
  accountsCount: number;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onNavigate: (tab: NavTab) => void;
  onSendToChat: (scriptText: string) => void;
  onProvidersChanged: () => void;
  onScriptCompleted: () => void;
}

interface GeneratedScriptHistoryItem {
  id: string;
  title: string;
  platform: string;
  targetAssistant: string;
  content: string;
  provider?: string;
  model?: string;
  createdAt: number;
}

const HISTORY_STORAGE_KEY = 'qoder2api-script-history-v1';

const PLATFORMS = [
  'Web Full-Stack (React + Node/API)',
  'Android APK + Backend Local',
  'Windows 11 Desktop (.exe)',
  'Mobile + Web + Windows (Multiplataforma)',
  'Script / CLI / Automação (Node / Python)',
];

const TARGET_ASSISTANTS = [
  'Universal (Qualquer Code Assistant)',
  'Claude Code / Anthropic',
  'Qoder / Cursor / Windsurf',
  'Codex / GitHub Copilot',
  'Gemini / Open-Source Coder',
];

export const ScriptGeneratorPanel: React.FC<ScriptGeneratorPanelProps> = ({
  models,
  providers,
  accountsCount,
  apiFetch,
  onNavigate,
  onSendToChat,
  onProvidersChanged,
  onScriptCompleted,
}) => {
  const [projectTitle, setProjectTitle] = useState('');
  const [platform, setPlatform] = useState(PLATFORMS[0]);
  const [targetAssistant, setTargetAssistant] = useState(TARGET_ASSISTANTS[0]);
  const [ideaInput, setIdeaInput] = useState('');
  const [ideas, setIdeas] = useState<string[]>([]);
  const [extraNotes, setExtraNotes] = useState('');
  const [detailLevel, setDetailLevel] = useState<'completo' | 'enxuto'>('completo');
  const [selectedModelId, setSelectedModelId] = useState('auto-failover');

  const [generating, setGenerating] = useState(false);
  const [activatingFreeAi, setActivatingFreeAi] = useState(false);
  const [generatedScript, setGeneratedScript] = useState('');
  const [metaInfo, setMetaInfo] = useState<{ provider?: string; model?: string; latencyMs?: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<GeneratedScriptHistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as GeneratedScriptHistoryItem[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 10)));
    } catch {
      // ignore storage quota
    }
  }, [history]);

  const activeProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);

  const handleAddIdea = () => {
    const clean = ideaInput.trim();
    if (!clean) return;
    setIdeas((prev) => [...prev, clean]);
    setIdeaInput('');
  };

  const handleRemoveIdea = (index: number) => {
    setIdeas((prev) => prev.filter((_, i) => i !== index));
  };

  const handleActivateFreePollinations = async () => {
    setActivatingFreeAi(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch('/api/hub/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'pollinations',
          name: 'Pollinations AI (Grátis Sem Chave)',
          baseUrl: 'https://text.pollinations.ai/openai',
          apiKey: 'local-no-key',
          defaultModel: 'qwen-coder',
          protocol: 'openai',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onProvidersChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao ativar Pollinations grátis.');
    } finally {
      setActivatingFreeAi(false);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const pendingIdea = ideaInput.trim();
    const allIdeas = pendingIdea ? [...ideas, pendingIdea] : [...ideas];
    if (pendingIdea) {
      setIdeas(allIdeas);
      setIdeaInput('');
    }

    if (!projectTitle.trim() && allIdeas.length === 0 && !extraNotes.trim()) {
      setErrorMsg('Digite pelo menos o objetivo do projeto ou uma ideia para montar o script.');
      return;
    }

    setGenerating(true);
    setGeneratedScript('');
    setMetaInfo(null);
    const startedAt = Date.now();

    const systemPrompt = [
      'Você é um Arquiteto de Software Sênior especializado em transformar ideias soltas em um SCRIPT / BLUEPRINT TÉCNICO PRONTO para qualquer AI Code Assistant executar com mínimo esforço e zero ambiguidade.',
      'Regras obrigatórias de saída (responda em Português do Brasil, em Markdown limpo e acionável):',
      '1. **Resumo Executivo & Objetivo**: 1 parágrafo unificando todas as ideias sem contradições.',
      '2. **Arquitetura & Stack Recomendada**: estrutura de pastas, arquivos exatos a criar/alterar, dependências necessárias.',
      '3. **Modelos de Dados / Contratos de API**: tipos TypeScript, endpoints ou schemas necessários.',
      '4. **Fluxo Passo a Passo de Implementação (Checklist Ordenado)**: tarefas numeradas em ordem lógica de execução para a IA programadora seguir direto.',
      '5. **Regras de Qualidade, Edge Cases & Critérios de Aceite**: o que validar para não quebrar.',
      '6. **Prompt Único Pronto (Copiar e Colar na Code Assistant)**: um bloco final compacto e imperativo começando com "ATUE COMO ENGENHEIRO SÊNIOR..." pronto para execução imediata.',
      detailLevel === 'enxuto'
        ? 'Mantenha cada seção objetiva e direta ao código, sem texto redundante.'
        : 'Detalhe nomes de arquivos, componentes, rotas, estados e edge cases para a code assistant não precisar adivinhar nada.',
    ].join('\n');

    const userPrompt = [
      `## Projeto / Ideia Central`,
      projectTitle.trim() || 'Projeto sem título definido',
      '',
      `## Plataforma / Ambiente Alvo`,
      platform,
      '',
      `## Code Assistant que vai executar este Script`,
      targetAssistant,
      '',
      `## Lista de Ideias & Funcionalidades Soltas`,
      allIdeas.length > 0
        ? allIdeas.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : 'Não listadas em tópicos — veja notas adicionais abaixo.',
      '',
      ...(extraNotes.trim()
        ? [`## Requisitos Extras, Regras ou Restrições`, extraNotes.trim(), '']
        : []),
      'Junte todas as ideias acima, resolva lacunas lógicas e gere o Script Técnico Detalhado completo para a Code Assistant executar com o menor trabalho possível.',
    ].join('\n');

    try {
      const res = await apiFetch('/api/hub/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModelId,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }

      const providerMeta = res.headers.get('X-Qoder-Provider') || undefined;
      const contentType = res.headers.get('content-type') || '';

      let finalContent = '';

      if (!contentType.includes('text/event-stream') || !res.body) {
        const data = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        finalContent = data.choices?.[0]?.message?.content || '';
        setGeneratedScript(finalContent);
        setMetaInfo({
          provider: providerMeta,
          model: data.model || selectedModelId,
          latencyMs: Date.now() - startedAt,
        });
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let resolvedModel = selectedModelId;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr) as {
                model?: string;
                error?: { message?: string };
                choices?: Array<{ delta?: { content?: string } }>;
              };
              if (parsed.error?.message) throw new Error(parsed.error.message);
              if (parsed.model) resolvedModel = parsed.model;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                finalContent += delta;
                setGeneratedScript(finalContent);
              }
            } catch (chunkErr) {
              if (chunkErr instanceof Error && chunkErr.message.includes('HTTP')) {
                throw chunkErr;
              }
            }
          }
        }

        setMetaInfo({
          provider: providerMeta,
          model: resolvedModel,
          latencyMs: Date.now() - startedAt,
        });
      }

      if (finalContent.trim()) {
        const entry: GeneratedScriptHistoryItem = {
          id: `scr-${Date.now()}`,
          title: projectTitle.trim() || allIdeas[0] || 'Script Técnico',
          platform,
          targetAssistant,
          content: finalContent,
          provider: providerMeta,
          model: selectedModelId,
          createdAt: Date.now(),
        };
        setHistory((prev) => [entry, ...prev].slice(0, 10));
        onScriptCompleted();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Erro ao gerar script com a IA conectada.'
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedScript) return;
    try {
      await navigator.clipboard.writeText(generatedScript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleDownloadMd = () => {
    if (!generatedScript) return;
    const slug = (projectTitle.trim() || 'script-ia')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const blob = new Blob([generatedScript], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'script-ia'}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
            <FileCode2 className="w-4 h-4 shrink-0" />
            <span>Arquiteto Multi-IA · Unificador de Ideias para Code Assistant</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">
            Gerador de Script &amp; Especificação Técnica
          </h1>
          <p className="text-xs text-zinc-400 max-w-2xl">
            Jogue todas as suas ideias soltas aqui. Uma IA do seu pool gratuito junta tudo, resolve detalhes de arquitetura e devolve um script passo a passo pronto para qualquer Code Assistant programar sem retrabalho.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="min-h-[44px] px-4 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-semibold text-zinc-200 flex items-center gap-2 whitespace-nowrap"
            >
              <History className="w-4 h-4 text-emerald-400" />
              <span>Histórico ({history.length})</span>
            </button>
          )}
        </div>
      </section>

      {/* No active AI quick activator banner */}
      {accountsCount === 0 && (
        <div className="bg-amber-950/30 border border-amber-800/60 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-amber-300">
              Nenhuma IA de código ativa no momento
            </div>
            <p className="text-xs text-amber-200/80">
              Ative agora uma IA gratuita sem chave (Pollinations) em 1 clique ou procure novas IAs na aba APIs IA.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={activatingFreeAi}
              onClick={() => void handleActivateFreePollinations()}
              className="min-h-[42px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
            >
              {activatingFreeAi ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Zap className="w-3.5 h-3.5" />
              )}
              <span>Ativar Pollinations Grátis (1 Clique)</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('apis')}
              className="min-h-[42px] px-4 rounded-xl border border-zinc-700 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 whitespace-nowrap"
            >
              Abrir Aba APIs IA
            </button>
          </div>
        </div>
      )}

      {/* Optional History Drawer */}
      {showHistory && history.length > 0 && (
        <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Scripts Gerados Recentemente</h2>
            <button
              type="button"
              onClick={() => setHistory([])}
              className="text-xs text-zinc-400 hover:text-rose-400 flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpar histórico</span>
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setGeneratedScript(item.content);
                  setMetaInfo({ provider: item.provider, model: item.model });
                  setShowHistory(false);
                }}
                className="p-3 rounded-xl bg-[#090B0E] border border-zinc-800 hover:border-emerald-500/60 text-left space-y-1 transition-colors"
              >
                <div className="text-xs font-semibold text-zinc-100 truncate">{item.title}</div>
                <div className="text-[11px] text-zinc-400 truncate">{item.platform}</div>
                <div className="text-[11px] font-mono text-zinc-500">
                  {new Date(item.createdAt).toLocaleString('pt-BR')}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Two-Column Builder & Output */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Idea Collector Form */}
        <form
          onSubmit={(e) => void handleGenerate(e)}
          className="lg:col-span-5 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4"
        >
          <div className="space-y-1.5">
            <label htmlFor="script-title" className="text-xs font-medium text-zinc-300">
              Objetivo Principal / Nome do App ou Script
            </label>
            <input
              id="script-title"
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              placeholder="Ex: App de controle de estoque offline com scanner e exportação"
              className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="script-platform" className="text-xs font-medium text-zinc-300">
                Plataforma / Stack
              </label>
              <select
                id="script-platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="script-assistant" className="text-xs font-medium text-zinc-300">
                Code Assistant Destino
              </label>
              <select
                id="script-assistant"
                value={targetAssistant}
                onChange={(e) => setTargetAssistant(e.target.value)}
                className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {TARGET_ASSISTANTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Loose Ideas Input List */}
          <div className="space-y-2">
            <label htmlFor="script-idea-input" className="text-xs font-medium text-zinc-300">
              Suas Ideias Soltas (adicione uma por uma)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="script-idea-input"
                type="text"
                value={ideaInput}
                onChange={(e) => setIdeaInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddIdea();
                  }
                }}
                placeholder="Ex: Login com PIN, gráficos de vendas, exportar PDF..."
                className="flex-1 min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button
                type="button"
                onClick={handleAddIdea}
                aria-label="Adicionar ideia"
                className="min-h-[44px] px-3.5 rounded-xl border border-zinc-700 bg-[#090B0E] hover:bg-zinc-800 text-xs font-semibold text-emerald-400 flex items-center gap-1 shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add</span>
              </button>
            </div>

            {ideas.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {ideas.map((idea, idx) => (
                  <div
                    key={`${idx}-${idea.slice(0, 12)}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#090B0E] border border-zinc-800/80 text-xs text-zinc-200"
                  >
                    <span className="truncate">
                      <span className="font-mono text-emerald-400 mr-1.5">#{idx + 1}</span>
                      {idea}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveIdea(idx)}
                      aria-label={`Remover ideia ${idx + 1}`}
                      className="text-zinc-500 hover:text-rose-400 p-1 shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Extra Notes */}
          <div className="space-y-1.5">
            <label htmlFor="script-notes" className="text-xs font-medium text-zinc-300">
              Detalhes Extras, Regras ou Restrições (opcional)
            </label>
            <textarea
              id="script-notes"
              rows={3}
              value={extraNotes}
              onChange={(e) => setExtraNotes(e.target.value)}
              placeholder="Ex: Precisa funcionar offline no Android, tema escuro, usar SQLite ou JSON local..."
              className="w-full bg-[#090B0E] border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {/* Detail Level & AI Selector */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-300">Nível de Detalhe</label>
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#090B0E] border border-zinc-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setDetailLevel('completo')}
                  className={`min-h-[36px] rounded-lg text-xs font-semibold transition-colors ${
                    detailLevel === 'completo'
                      ? 'bg-emerald-500 text-zinc-950'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Completo
                </button>
                <button
                  type="button"
                  onClick={() => setDetailLevel('enxuto')}
                  className={`min-h-[36px] rounded-lg text-xs font-semibold transition-colors ${
                    detailLevel === 'enxuto'
                      ? 'bg-emerald-500 text-zinc-950'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Enxuto
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="script-model" className="text-xs font-medium text-zinc-300">
                IA Sintetizadora
              </label>
              <select
                id="script-model"
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="auto-failover">Auto-Failover (Todas IAs Grátis)</option>
                {activeProviders.map((p) => (
                  <option key={p.id} value={`provider:${p.id}`}>
                    {p.name} · {p.defaultModel}
                  </option>
                ))}
                {models.slice(0, 6).map((m) => (
                  <option key={m.key} value={m.id}>
                    {m.displayName} ({m.priceFactor === 0 ? '0x Grátis' : `${m.priceFactor}x`})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-950/35 border border-red-800/60 text-xs text-red-300">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={generating}
            className="w-full min-h-[48px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Unificando Ideias &amp; Gerando Script...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Gerar Script Detalhado com IA</span>
              </>
            )}
          </button>
        </form>

        {/* Right: Generated Script Result */}
        <section className="lg:col-span-7 bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4 min-h-[480px] flex flex-col">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                Script Técnico Gerado
              </h2>
              <p className="text-xs text-zinc-400">
                {metaInfo
                  ? `Gerado por ${metaInfo.provider || 'IA'} (${metaInfo.model || 'auto'}) em ${
                      metaInfo.latencyMs ? `${(metaInfo.latencyMs / 1000).toFixed(1)}s` : 'streaming'
                    }`
                  : 'Copie para colar na sua Code Assistant ou execute direto no Chat IA'}
              </p>
            </div>

            {generatedScript && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="min-h-[40px] px-3.5 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
                >
                  {copied ? (
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

                <button
                  type="button"
                  onClick={handleDownloadMd}
                  className="min-h-[40px] px-3.5 rounded-xl border border-zinc-800 bg-[#090B0E] hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Baixar .md</span>
                </button>

                <button
                  type="button"
                  onClick={() => onSendToChat(generatedScript)}
                  className="min-h-[40px] px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>Executar no Chat IA</span>
                </button>
              </div>
            )}
          </div>

          {generatedScript ? (
            <pre className="flex-1 whitespace-pre-wrap break-words text-xs sm:text-sm font-mono text-zinc-200 bg-[#090B0E] border border-zinc-800/80 rounded-xl p-4 overflow-y-auto max-h-[620px] leading-relaxed">
              {generatedScript}
            </pre>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 space-y-3 bg-[#090B0E] border border-zinc-800/70 rounded-xl">
              <FileCode2 className="w-8 h-8 text-emerald-400/80" />
              <div className="space-y-1 max-w-md">
                <p className="text-sm font-medium text-zinc-200">
                  Adicione suas ideias ao lado e clique em Gerar Script
                </p>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  A IA junta todas as suas ideias em um plano completo com arquivos, APIs, fluxo de implementação e um prompt único pronto para diminuir o trabalho da sua code assistant.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
