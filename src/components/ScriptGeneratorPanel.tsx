import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileCode2, History, Loader2, Plus, Sparkles, X } from 'lucide-react';
import type { NavTab, QoderModel, SafeProviderSummary } from '../types/hub';
import { buildZipBlob } from '../utils/androidProjectZip';
import { saveProjectZip } from '../utils/androidBridge';
import {
  appendPreScriptHistory, buildPreScriptMessages, emptyPreScriptDraft, MAX_PRE_SCRIPT_OUTPUT_BYTES,
  MAX_PRE_SCRIPT_PROMPT_BYTES, persistPreScriptStorage, preScriptBytes, PRE_SCRIPT_ASSISTANTS,
  PRE_SCRIPT_DRAFT_KEY, PRE_SCRIPT_HISTORY_KEY, PRE_SCRIPT_PLATFORMS, requestPreScript,
  restorePreScriptDraft, restorePreScriptHistory, validatePreScriptDraft, validatePreScriptOutput,
  type PreScriptDraft, type PreScriptHistoryItem,
} from '../utils/preScript';

interface ScriptGeneratorPanelProps {
  models: QoderModel[]; // Compatibility only; use configured external APIs for synthesis.
  providers: SafeProviderSummary[];
  accountsCount: number;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onNavigate: (tab: NavTab) => void;
  onSendToChat: (scriptText: string) => void;
  onSendToProject: (scriptText: string) => void;
  onProvidersChanged?: () => void;
  onScriptCompleted: () => void;
}
const cardClass = 'min-w-0 rounded-2xl border border-zinc-800/80 bg-[#12151B] p-4 sm:p-5';
const fieldClass = 'min-w-0 w-full rounded-xl border border-zinc-800 bg-[#090B0E] p-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500';
const buttonClass = 'min-h-[44px] min-w-0 rounded-xl border border-zinc-700 bg-[#090B0E] px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';
const primaryButtonClass = 'min-h-[44px] min-w-0 w-full rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';
const describeError = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível concluir a ação.';
const emptyHistory = (): PreScriptHistoryItem[] => [];

function usePreservedStorage<T>(key: string, restore: (raw: string | null) => T, empty: () => T) {
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return { value: restore(raw), raw, blocked: false, warning: '' };
    } catch (error) {
      return { value: empty(), raw: null, blocked: true,
        warning: `${describeError(error)} Dados locais não foram sobrescritos; as edições ficam apenas nesta sessão.` };
    }
  });
  const [value, setValue] = useState(initial.value);
  const [warning, setWarning] = useState(initial.warning);
  const saved = useRef({ raw: initial.raw, serialized: JSON.stringify(initial.value), blocked: initial.blocked });
  const persist = useCallback((next: T) => {
    if (saved.current.blocked || JSON.stringify(next) === saved.current.serialized) return;
    try {
      const serialized = persistPreScriptStorage(localStorage, key, next, saved.current.raw, restore);
      saved.current = { raw: serialized, serialized, blocked: false };
    } catch (error) {
      saved.current.blocked = true;
      setWarning(`${describeError(error)} Dados locais preservados; novas edições ficam apenas nesta sessão. Copie ou exporte antes de sair.`);
    }
  }, [key, restore]);
  useEffect(() => { persist(value); }, [persist, value]);
  return { value, setValue, warning, persist };
}

export const ScriptGeneratorPanel: React.FC<ScriptGeneratorPanelProps> = ({
  providers, apiFetch, onNavigate, onSendToChat, onSendToProject, onScriptCompleted,
}) => {
  const draftStorage = usePreservedStorage(PRE_SCRIPT_DRAFT_KEY, restorePreScriptDraft, emptyPreScriptDraft);
  const historyStorage = usePreservedStorage(PRE_SCRIPT_HISTORY_KEY, restorePreScriptHistory, emptyHistory);
  const { value: draft, setValue: setDraft } = draftStorage;
  const { value: history, setValue: setHistory } = historyStorage;
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort(new Error('Geração interrompida ao sair. Rascunho e resultado anterior preservados.'));
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const activeProviders = useMemo(() => providers.filter((provider) => provider.enabled === true && provider.id.trim() && provider.defaultModel.trim())
    .sort((a, b) => a.priority - b.priority), [providers]);
  const selectedModelId = activeProviders.some((provider) => `provider:${provider.id}` === draft.selectedModelId)
    ? draft.selectedModelId : 'auto-failover';
  const queue = selectedModelId === 'auto-failover' ? activeProviders
    : activeProviders.filter((provider) => `provider:${provider.id}` === selectedModelId);
  const promptBytes = buildPreScriptMessages(draft).reduce((total, message) => total + preScriptBytes(message.content), 0);
  const outputBytes = preScriptBytes(draft.generatedScript);
  const hasResult = Boolean(draft.generatedScript.trim());
  const canCreate = hasResult && draft.reviewed && !generating && !generationError && outputBytes <= MAX_PRE_SCRIPT_OUTPUT_BYTES;

  const updateDraft = (patch: Partial<PreScriptDraft>) => {
    try {
      setDraft(validatePreScriptDraft({ ...draft, ...patch }));
      setActionError(null);
      setCopied(false);
      setStatus('');
    } catch (error) { setActionError(describeError(error)); }
  };
  const addIdea = () => {
    if (!draft.ideaInput.trim()) return;
    updateDraft({ ideas: [...draft.ideas, draft.ideaInput], ideaInput: '' });
  };
  const archive = (source: PreScriptDraft, content = source.generatedScript) => {
    if (!content.trim()) return;
    const item: PreScriptHistoryItem = {
      id: `pre-${crypto.randomUUID()}`, title: source.projectTitle.trim() || 'Pré-script sem título',
      platform: source.platform, targetAssistant: source.targetAssistant, content,
      provider: source.metaInfo?.provider, model: source.metaInfo?.model, createdAt: Date.now(),
    };
    setHistory((previous) => appendPreScriptHistory(previous, item));
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (controllerRef.current) return;
    setGenerationError(null);
    setActionError(null);
    setStatus('');
    if (!queue.length) { setGenerationError('Configure e habilite uma API antes de detalhar as ideias.'); return; }
    if (!draft.projectTitle.trim() && !draft.ideas.length && !draft.ideaInput.trim() && !draft.extraNotes.trim()) {
      setGenerationError('Informe um objetivo, ideia ou nota antes de detalhar.'); return;
    }
    const pending = draft.ideaInput.trim() ? [...draft.ideas, draft.ideaInput] : draft.ideas;
    let requestDraft: PreScriptDraft;
    try {
      requestDraft = validatePreScriptDraft({ ...draft, ideas: pending, ideaInput: '', selectedModelId, reviewed: false });
    } catch (error) { setGenerationError(describeError(error)); return; }
    setDraft(requestDraft);
    draftStorage.persist(requestDraft);
    setGenerating(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    const startedAt = Date.now();
    try {
      const result = await requestPreScript(apiFetch, requestDraft, queue.map((provider) => provider.id), controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const next = validatePreScriptDraft({ ...requestDraft, generatedScript: result.content,
        metaInfo: { ...result.meta, latencyMs: result.meta?.latencyMs ?? Date.now() - startedAt }, reviewed: false });
      archive(draft);
      archive(next);
      setDraft(next);
      draftStorage.persist(next);
      setCopied(false);
      setStatus('Pré-script completo recebido. Edite e revise antes de criar o projeto.');
      onScriptCompleted(); // Refresh only; no project execution.
    } catch (error) {
      if (mounted.current) setGenerationError(describeError(error));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mounted.current) setGenerating(false);
    }
  };

  const acknowledgeReview = (checked: boolean) => {
    updateDraft({ reviewed: checked,
      ...(checked ? { confirmedResult: { content: validatePreScriptOutput(draft.generatedScript), meta: draft.metaInfo } } : {}) });
    if (checked) {
      archive(draft);
      setGenerationError(null); // Explicit acceptance of retained output after a failed call.
    }
  };
  const restoreConfirmed = () => {
    if (!draft.confirmedResult) return;
    archive(draft);
    updateDraft({ generatedScript: draft.confirmedResult.content, metaInfo: draft.confirmedResult.meta, reviewed: false });
    setGenerationError(null);
    setStatus('Último resultado revisado recuperado. Confirme a revisão novamente antes de criar o projeto.');
  };
  const copy = async () => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(validatePreScriptOutput(draft.generatedScript));
      if (!mounted.current) return;
      setCopied(true);
      setStatus('Pré-script copiado.');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { setCopied(false); }, 1800);
    } catch (error) {
      if (mounted.current) setActionError(`Falha ao copiar: ${describeError(error)} Selecione o texto manualmente ou exporte o ZIP.`);
    }
  };
  const exportZip = async () => {
    setActionError(null);
    setExporting(true);
    try {
      const content = validatePreScriptOutput(draft.generatedScript);
      await saveProjectZip(buildZipBlob([{ path: 'pre-script.md', content }]), 'pre-script.zip');
      if (mounted.current) setStatus('Exportação ZIP solicitada. No APK, conclua o salvamento no seletor de arquivos.');
    } catch (error) { if (mounted.current) setActionError(`Falha ao exportar: ${describeError(error)}`); }
    finally { if (mounted.current) setExporting(false); }
  };
  const send = (destination: 'project' | 'chat') => {
    setActionError(null);
    try {
      if (generating || !hasResult || (destination === 'project' && !canCreate)) return;
      const content = validatePreScriptOutput(draft.generatedScript);
      draftStorage.persist(draft);
      historyStorage.persist(history);
      if (destination === 'project') onSendToProject(content); // Full blueprint, no truncation/automatic execution.
      else onSendToChat(content);
    } catch (error) { setActionError(describeError(error)); }
  };

  return (
    <div className="min-w-0 space-y-4 break-words [overflow-wrap:anywhere]">
      <header className={`${cardClass} flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between`}>
        <div className="min-w-0 space-y-2">
          <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Pré-script: ideias → prompt detalhado</h1>
          <p className="max-w-2xl text-xs leading-relaxed text-zinc-400">Uma IA externa reúne suas ideias em uma especificação editável. Você revisa, cria o projeto e escolhe a fila de assistentes para trabalhar em conjunto. Nada é executado automaticamente.</p>
        </div>
        <button type="button" onClick={() => setShowHistory((previous) => !previous)} className={buttonClass} aria-expanded={showHistory}><History className="h-4 w-4 shrink-0" /> Histórico ({history.length})</button>
      </header>
      <ol className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Etapas do pré-script">
        {[
          ['1. Ideias', 'Título, alvo, ideias e restrições. Rascunho salvo localmente quando disponível.'],
          ['2. Detalhamento por IA', 'APIs configuradas → especificação completa → edição e revisão humana.'],
          ['3. Projeto com fila', 'Blueprint inteiro → selecionar assistentes → iniciar manualmente. Arquivos, tarefas e checkpoints preservados no handoff.'],
        ].map(([title, description]) => (
          <li key={title} className={`${cardClass} space-y-1`}><h2 className="text-sm font-semibold text-emerald-400">{title}</h2><p className="text-xs leading-relaxed text-zinc-400">{description}</p></li>
        ))}
      </ol>
      {!activeProviders.length && (
        <section className={`${cardClass} flex flex-col gap-3 border-amber-800/60 sm:flex-row sm:items-center sm:justify-between`}>
          <div className="min-w-0 text-xs text-amber-200"><h2 className="font-semibold">Configure APIs para detalhar por IA</h2><p className="mt-1">Nenhum provedor externo habilitado com modelo configurado. Você pode preparar suas ideias antes de conectar uma API.</p></div>
          <button type="button" onClick={() => onNavigate('apis')} className={buttonClass}>Configurar APIs</button>
        </section>
      )}
      {(draftStorage.warning || historyStorage.warning) && (
        <div role="alert" className="rounded-xl border border-amber-800/60 p-3 text-xs text-amber-200 space-y-2">
          {draftStorage.warning && <p>Rascunho: {draftStorage.warning}</p>}
          {historyStorage.warning && <p>Histórico: {historyStorage.warning}</p>}
        </div>
      )}
      {showHistory && (
        <section className={`${cardClass} space-y-3`} aria-label="Histórico de pré-scripts">
          <h2 className="text-sm font-semibold text-zinc-100">Últimos 10 resultados</h2>
          <p className="text-xs text-zinc-400">Restaura só o resultado; suas ideias atuais são mantidas. O resultado aberto também entra no histórico antes da troca.</p>
          {!history.length && <p className="text-xs text-zinc-500">Nenhum resultado salvo.</p>}
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
            {history.map((item) => (
              <button key={item.id} type="button" disabled={generating} onClick={() => {
                archive(draft);
                updateDraft({ generatedScript: item.content, metaInfo: { provider: item.provider, model: item.model }, reviewed: false });
                setGenerationError(null);
                setShowHistory(false);
              }} className={`${buttonClass} flex-col items-start text-left`}>
                <span className="w-full break-words font-semibold">{item.title}</span>
                <span className="w-full break-words text-zinc-400">{item.platform} · {new Date(item.createdAt).toLocaleString('pt-BR')}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <form onSubmit={(event) => void generate(event)} className={`${cardClass} space-y-4 xl:col-span-5`} aria-label="Ideias para o pré-script">
          <h2 className="text-base font-semibold text-zinc-100">Ideias e restrições</h2>
          <fieldset disabled={generating} className="min-w-0 space-y-4 disabled:opacity-70">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="script-title" className="text-xs text-zinc-300">Título / objetivo principal</label>
              <input id="script-title" value={draft.projectTitle} onChange={(event) => updateDraft({ projectTitle: event.target.value })} placeholder="Ex.: Controle de estoque offline" className={fieldClass} />
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="script-platform" className="text-xs text-zinc-300">Plataforma / alvo</label>
                <select id="script-platform" value={draft.platform} onChange={(event) => updateDraft({ platform: event.target.value })} className={fieldClass}>
                  {!PRE_SCRIPT_PLATFORMS.includes(draft.platform) && <option>{draft.platform}</option>}
                  {PRE_SCRIPT_PLATFORMS.map((platform) => <option key={platform}>{platform}</option>)}
                </select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="script-assistant" className="text-xs text-zinc-300">Assistente(s) de destino</label>
                <select id="script-assistant" value={draft.targetAssistant} onChange={(event) => updateDraft({ targetAssistant: event.target.value })} className={fieldClass}>
                  {!PRE_SCRIPT_ASSISTANTS.includes(draft.targetAssistant) && <option>{draft.targetAssistant}</option>}
                  {PRE_SCRIPT_ASSISTANTS.map((assistant) => <option key={assistant}>{assistant}</option>)}
                </select>
              </div>
            </div>
            <div className="min-w-0 space-y-2">
              <label htmlFor="script-idea-input" className="text-xs text-zinc-300">Ideias soltas (o texto pendente também será enviado)</label>
              <textarea id="script-idea-input" rows={3} value={draft.ideaInput} onChange={(event) => updateDraft({ ideaInput: event.target.value })} placeholder="Adicione funcionalidades, fluxos e dúvidas…" className={`${fieldClass} resize-y whitespace-pre-wrap break-words`} />
              <button type="button" onClick={addIdea} disabled={!draft.ideaInput.trim()} className={buttonClass}><Plus className="h-4 w-4 shrink-0" /> Adicionar ideia</button>
              <ol className="min-w-0 space-y-2">
                {draft.ideas.map((idea, index) => (
                  <li key={index} className="flex min-w-0 items-start gap-2 rounded-xl border border-zinc-800 bg-[#090B0E] p-3 text-xs text-zinc-200">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"><span className="text-emerald-400">{index + 1}. </span>{idea}</span>
                    <button type="button" onClick={() => updateDraft({ ideas: draft.ideas.filter((_, position) => position !== index) })} aria-label={`Remover ideia ${index + 1}`} className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg text-zinc-400 hover:text-rose-300"><X className="mx-auto h-4 w-4" /></button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="script-notes" className="text-xs text-zinc-300">Notas, detalhes e restrições</label>
              <textarea id="script-notes" rows={4} value={draft.extraNotes} onChange={(event) => updateDraft({ extraNotes: event.target.value })} placeholder="Ex.: Offline no Android; não alterar arquivos existentes sem ler" className={`${fieldClass} resize-y whitespace-pre-wrap break-words`} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="script-detail" className="text-xs text-zinc-300">Nível de detalhe</label>
              <select id="script-detail" value={draft.detailLevel} onChange={(event) => updateDraft({ detailLevel: event.target.value as PreScriptDraft['detailLevel'] })} className={fieldClass}>
                <option value="completo">Completo</option><option value="enxuto">Enxuto (sem omitir requisitos)</option>
              </select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="script-model" className="text-xs text-zinc-300">IA para detalhamento</label>
              <select id="script-model" disabled={!activeProviders.length} value={selectedModelId} onChange={(event) => updateDraft({ selectedModelId: event.target.value })} className={fieldClass}>
                <option value="auto-failover">Auto · fila de APIs habilitadas</option>
                {activeProviders.map((provider) => <option key={provider.id} value={`provider:${provider.id}`}>{provider.name} · {provider.defaultModel}</option>)}
              </select>
              <p className="text-xs leading-relaxed text-zinc-500">Custos, cotas e disponibilidade dependem de cada API. Não há promessa de gratuidade. O failover automático respeita a configuração do aplicativo.</p>
            </div>
            {queue.length > 0 && (
              <div className="min-w-0 text-xs text-zinc-400">
                <p className="font-medium text-zinc-300">Fila de detalhamento</p>
                <ol className="mt-1 space-y-1">
                  {queue.map((provider, index) => <li key={provider.id} className="break-words [overflow-wrap:anywhere]">{index + 1}. {provider.name} · {provider.defaultModel}{provider.cooldownUntil && provider.cooldownUntil * 1000 > Date.now() ? ' · em espera (cooldown)' : ''}</li>)}
                </ol>
              </div>
            )}
            <p className="text-xs text-zinc-500">Prompt total: {promptBytes.toLocaleString('pt-BR')} / {MAX_PRE_SCRIPT_PROMPT_BYTES.toLocaleString('pt-BR')} bytes UTF-8.</p>
          </fieldset>
          <button type="submit" disabled={generating || !queue.length} className={primaryButtonClass}>
            {generating ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Sparkles className="h-4 w-4 shrink-0" />}
            {generating ? 'Detalhando ideias…' : 'Detalhar ideias por IA'}
          </button>
          {generating && <button type="button" onClick={() => controllerRef.current?.abort(new Error('Geração cancelada. Rascunho e resultado anterior preservados.'))} className={`${buttonClass} w-full`}>Cancelar geração</button>}
        </form>
        <section className={`${cardClass} space-y-4 xl:col-span-7`} aria-label="Resultado e revisão humana" aria-busy={generating}>
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-base font-semibold text-zinc-100">Prompt detalhado · revisão humana</h2>
            <p className="text-xs leading-relaxed text-zinc-400 break-words [overflow-wrap:anywhere]">
              {draft.metaInfo ? `Resposta real: ${draft.metaInfo.provider || 'provedor não informado'} · ${draft.metaInfo.model || 'modelo não informado'}${draft.metaInfo.latencyMs !== undefined ? ` · ${(draft.metaInfo.latencyMs / 1000).toFixed(1)}s` : ''}` : 'A IA apenas prepara a especificação. Nenhum arquivo, teste ou build é executado aqui.'}
            </p>
          </div>
          {generationError && <p role="alert" className="rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-300">{generationError}{hasResult ? ' O texto anterior continua abaixo; revise-o explicitamente para utilizá-lo.' : ''}</p>}
          {actionError && <p role="alert" className="rounded-xl border border-red-800/60 p-3 text-xs text-red-300">{actionError}</p>}
          {status && <p role="status" className="text-xs text-emerald-300">{status}</p>}
          <label htmlFor="pre-script-result" className="block text-xs text-zinc-300">Especificação editável (confira todas as ideias, lacunas e restrições)</label>
          <textarea id="pre-script-result" rows={18} disabled={generating} value={draft.generatedScript} onChange={(event) => updateDraft({ generatedScript: event.target.value, reviewed: false })} placeholder="Seu pré-script aparecerá aqui. Você pode editar o texto antes de encaminhá-lo para as assistentes." className={`${fieldClass} resize-y whitespace-pre-wrap break-words font-mono leading-relaxed [overflow-wrap:anywhere] disabled:opacity-70`} />
          <p className="text-xs text-zinc-500">Resultado: {outputBytes.toLocaleString('pt-BR')} / {MAX_PRE_SCRIPT_OUTPUT_BYTES.toLocaleString('pt-BR')} bytes UTF-8. Envio integral, sem truncamento.</p>
          {draft.confirmedResult && !draft.reviewed && (
            <button type="button" disabled={generating} onClick={restoreConfirmed} className={buttonClass}>Recuperar último pré-script revisado</button>
          )}
          <label className="flex min-w-0 items-start gap-3 rounded-xl border border-zinc-800 p-3 text-xs leading-relaxed text-zinc-300">
            <input type="checkbox" checked={draft.reviewed} disabled={generating || !hasResult} onChange={(event) => acknowledgeReview(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500" />
            <span className="min-w-0">Revisei este texto, suas restrições, pressupostos e lacunas. Aprovo encaminhar esta versão para o projeto (não iniciar a execução). Qualquer edição exige nova revisão.</span>
          </label>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => void copy()} disabled={generating || !hasResult} className={buttonClass}>{copied ? <Check className="h-4 w-4 shrink-0 text-emerald-400" /> : <Copy className="h-4 w-4 shrink-0" />}{copied ? 'Copiado' : 'Copiar pré-script'}</button>
            <button type="button" onClick={() => void exportZip()} disabled={generating || !hasResult || exporting} className={buttonClass}>{exporting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Download className="h-4 w-4 shrink-0" />}Exportar pré-script (ZIP)</button>
          </div>
          <button type="button" onClick={() => send('project')} disabled={!canCreate} className={primaryButtonClass}><FileCode2 className="h-4 w-4 shrink-0" />Criar projeto com este pré-script</button>
          <p className="text-xs leading-relaxed text-zinc-400">Na próxima etapa, o prompt inteiro será o blueprint. Selecione a fila de assistentes e inicie manualmente; criar o projeto não autoriza execução.</p>
          <p className="text-[11px] text-zinc-500">O pré-prompt ficará disponível no chat da pasta criada, junto do progresso das assistentes.</p>
        </section>
      </div>
    </div>
  );
};
