import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import { PROVIDER_PRESETS } from '../data/providerPresets';
import type { NavTab, ProviderPresetId, QoderModel } from '../types/hub';

type CatalogSource = 'openrouter' | 'github' | 'manual';
type SourceFilter = 'all' | CatalogSource;
type ExternalCatalogModel = QoderModel & { source: CatalogSource };

function isExternalCatalogModel(model: QoderModel): model is ExternalCatalogModel {
  return model.source === 'openrouter' || model.source === 'github' || model.source === 'manual';
}
interface CatalogResponse {
  ok?: boolean;
  message?: string;
  error?: string;
  models?: QoderModel[];
  statuses?: Record<'openrouter' | 'github', { updatedAt?: number; error?: string }>;
}
const SOURCE_LABELS: Record<SourceFilter, string> = { all: 'Todos', openrouter: 'OpenRouter', github: 'GitHub', manual: 'Manual' };

export function isCatalogModelFree(model: QoderModel): boolean {
  // Only explicit zero prices for both token directions establish free usage.
  return isExternalCatalogModel(model) && model.pricing?.prompt === 0 && model.pricing?.completion === 0;
}

function priceLabel(model: QoderModel): string {
  if (isCatalogModelFree(model)) return 'Grátis (preço/token = 0)';
  const { prompt, completion } = model.pricing ?? {};
  if (prompt === undefined || completion === undefined || !Number.isFinite(prompt) || !Number.isFinite(completion)) return 'Preço não informado';
  const format = (value: number) => value.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return `$${format(prompt)} / $${format(completion)} por token (entrada/saída)`;
}

interface ModelsPanelProps {
  models: QoderModel[];
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onModelsUpdated: (models: QoderModel[]) => void;
  onTestModelInChat?: (modelId: string) => void;
  onNavigate: (tab: NavTab) => void;
  onProvidersChanged: () => void;
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({
  models,
  apiFetch,
  onModelsUpdated,
  onNavigate,
  onProvidersChanged,
}) => {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [freeOnly, setFreeOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<CatalogResponse['statuses']>();
  const [manualProvider, setManualProvider] = useState<ProviderPresetId>('openrouter');
  const [manualName, setManualName] = useState('');
  const [manualBaseUrl, setManualBaseUrl] = useState('');
  const [manualProtocol, setManualProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [savingManual, setSavingManual] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const preset = PROVIDER_PRESETS.find((p) => p.id === manualProvider)!;

  const loadCache = useCallback(async (signal?: AbortSignal) => {
    const res = await apiFetch('/api/app/catalog', { signal });
    const data = await res.json() as CatalogResponse;
    if (!res.ok) throw new Error(data.error || `Falha ao carregar catálogo (HTTP ${res.status}).`);
    if (!signal?.aborted) {
      if (Array.isArray(data.models)) onModelsUpdated(data.models.filter(isExternalCatalogModel));
      setStatuses(data.statuses);
    }
  }, [apiFetch, onModelsUpdated]);

  const syncProviders = useCallback(async (signal?: AbortSignal) => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const messages = await Promise.all((['openrouter', 'github'] as const).map(async (provider) => {
        try {
          const res = await apiFetch('/api/app/catalog/providers/refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider }), signal,
          });
          const data = await res.json() as CatalogResponse;
          return `${SOURCE_LABELS[provider]}: ${data.message || data.error || (res.ok ? 'Catálogo atualizado.' : `HTTP ${res.status}`)}`;
        } catch (err) {
          return `${SOURCE_LABELS[provider]}: ${err instanceof Error ? err.message : 'Indisponível.'}`;
        }
      }));
      // Read after both attempts so partial outages cannot overwrite another provider's list.
      await loadCache(signal);
      if (!signal?.aborted) setSyncMessage(messages.join(' · '));
    } catch (err) {
      if (!signal?.aborted) setSyncMessage(err instanceof Error ? err.message : 'Falha ao carregar catálogo.');
    } finally {
      if (!signal?.aborted) setSyncing(false);
    }
  }, [apiFetch, loadCache]);

  useEffect(() => {
    const controller = new AbortController();
    void syncProviders(controller.signal);
    return () => controller.abort();
  }, [syncProviders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter(isExternalCatalogModel).filter((model) => {
      if (sourceFilter !== 'all' && model.source !== sourceFilter) return false;
      if (freeOnly && !isCatalogModelFree(model)) return false;
      return !q || [model.displayName, model.key, model.modelName, model.provider].some((value) => value?.toLowerCase().includes(q));
    });
  }, [models, search, sourceFilter, freeOnly]);

  const handleSaveManual = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingManual(true);
    setSyncMessage(null);
    try {
      const res = await apiFetch('/api/app/catalog/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: manualProvider, modelName: manualName.trim(), baseUrl: manualBaseUrl.trim() || undefined, protocol: manualProtocol }),
      });
      const data = await res.json() as CatalogResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (Array.isArray(data.models)) onModelsUpdated(data.models.filter(isExternalCatalogModel));
      setStatuses(data.statuses);
      setManualName('');
      setSyncMessage('Modelo manual salvo no catálogo. Use “Usar na fila” para cadastrar o provedor.');
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Falha ao salvar modelo manual.');
    } finally {
      setSavingManual(false);
    }
  };

  const handleUseInQueue = async (model: ExternalCatalogModel) => {
    setAddingId(model.key);
    setSyncMessage(null);
    try {
      if (!model.provider || !model.baseUrl) {
        throw new Error('Este modelo não tem provedor ou URL definidos. Configure a API na aba APIs IA.');
      }
      const res = await apiFetch('/api/app/providers/discover/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Saved credentials are resolved by addDiscoveredProvider server-side, never sent by this panel.
        body: JSON.stringify({ provider: model.provider, name: `${model.provider} · ${model.displayName}`, baseUrl: model.baseUrl, defaultModel: model.modelName ?? model.id, protocol: model.protocol ?? 'openai', source: 'endpoint-sync' }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        if (res.status === 400 && /API Key/i.test(data.error ?? '')) {
          onNavigate('apis');
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onProvidersChanged();
      setSyncMessage(`${model.displayName} está cadastrado na fila. Gerencie prioridade e ativação na aba APIs.`);
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Falha ao adicionar à fila.');
    } finally {
      setAddingId(null);
    }
  };

  const inputClass = 'w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500';
  const buttonClass = 'min-h-[44px] px-4 rounded-xl border border-zinc-800 hover:bg-zinc-800 disabled:opacity-50 text-xs font-medium text-zinc-200 flex items-center justify-center gap-2';

  return (
    <div className="space-y-6">
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Multi-IA</h1>
            <p className="text-xs text-zinc-400">
              Catálogos OpenRouter e GitHub, além de entradas manuais, para as APIs usadas pelas assistentes nos seus projetos.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={syncing} onClick={() => void syncProviders()} className={buttonClass}>
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} /> Atualizar provedores
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-400">Atualização automática ao abrir (cache de 1h; nova tentativa de falha após 5min). A disponibilidade de cada fonte aparece abaixo; falhas de atualização não apagam o catálogo anterior.</p>
        {statuses && (
          <div className="space-y-1 text-xs text-zinc-400">
            {(['openrouter', 'github'] as const).map((provider) => (
              <p key={provider}>{SOURCE_LABELS[provider]} · {statuses[provider]?.updatedAt ? `Último catálogo: ${new Date(statuses[provider].updatedAt!).toLocaleString()}` : 'Sem catálogo sincronizado'}{statuses[provider]?.error ? ` · ${statuses[provider].error}` : ''}</p>
            ))}
          </div>
        )}
        {syncMessage && (
          <div role="status" className="px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-300">
            {syncMessage}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Buscar modelo"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar modelo (ex: Qwen3.8, DeepSeek, Kimi, Ultimate)..."
              className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl pl-10 pr-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Fonte do catálogo" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as SourceFilter)} className={`${inputClass} sm:w-auto`}>
            {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((source) => <option key={source} value={source}>{SOURCE_LABELS[source]}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Apenas gratuitos</label>
          <span className="text-xs text-zinc-500">{filtered.length} modelos</span>
        </div>
      </section>

      <form onSubmit={(e) => void handleSaveManual(e)} className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-3">
        <h2 className="text-sm font-semibold">Adicionar nome de modelo manualmente</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <select aria-label="Provedor manual" value={manualProvider} onChange={(e) => {
            const provider = e.target.value as ProviderPresetId;
            setManualProvider(provider); setManualBaseUrl('');
            setManualProtocol(PROVIDER_PRESETS.find((p) => p.id === provider)?.protocol ?? 'openai');
          }} className={inputClass}>
            {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input aria-label="ID do modelo manual" required maxLength={256} value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="ID exato do modelo (ex: vendor/model)" className={inputClass} />
          <input aria-label="URL base do modelo manual" type="url" required={manualProvider === 'custom'} maxLength={2048} value={manualBaseUrl} onChange={(e) => setManualBaseUrl(e.target.value)} placeholder={preset.baseUrl} className={inputClass} />
          <select aria-label="Protocolo do modelo manual" value={manualProtocol} onChange={(e) => setManualProtocol(e.target.value as 'openai' | 'anthropic')} className={inputClass}>
            <option value="openai">OpenAI compatível</option><option value="anthropic">Anthropic</option>
          </select>
        </div>
        <p className="text-xs text-zinc-400">Só salva no catálogo; preço e disponibilidade não são verificados. URL vazia usa o preset (custom exige URL). “Usar na fila” reutiliza uma chave salva; se faltar, abre APIs para configurar.</p>
        <button type="submit" disabled={savingManual || !manualName.trim()} className={buttonClass}><Plus className="w-4 h-4" /> {savingManual ? 'Salvando...' : 'Salvar no catálogo'}</button>
      </form>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((m) => {
          const ctxLabel = m.maxInputTokens > 0 ? `${m.maxInputTokens.toLocaleString()} tokens ctx` : 'Contexto não informado';
          return (
            <div
              key={m.key}
              className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-1.5 min-w-0">
                <h2 className="text-base font-semibold text-zinc-100 break-words">{m.displayName}</h2>
                <p className={`text-xs font-mono ${isCatalogModelFree(m) ? 'text-emerald-400' : 'text-zinc-300'}`}>{priceLabel(m)}</p>
                <p className="text-xs text-zinc-400 font-mono break-all">{m.modelName ?? m.key} · {ctxLabel}</p>
                <p className="text-xs text-zinc-400">{SOURCE_LABELS[m.source]}{m.provider ? ` · ${m.provider}` : ''}</p>

                <p className="text-xs text-zinc-400">
                  {[
                    m.isReasoning ? 'Raciocínio' : null,
                    m.isVl ? 'Visão (VL)' : null,
                    m.supportsTools === undefined ? null : m.supportsTools ? 'Tools' : 'Sem tools',
                    m.thinkingEfforts?.length ? `Níveis: ${m.thinkingEfforts.join(', ')}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>

              <button
                type="button"
                disabled={addingId !== null}
                onClick={() => void handleUseInQueue(m)}
                className="min-h-[42px] w-full rounded-xl border border-zinc-800 hover:border-emerald-500/60 hover:bg-emerald-500/10 text-xs font-medium text-zinc-200 hover:text-emerald-300 flex items-center justify-center gap-2 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{addingId === m.key ? 'Adicionando...' : 'Usar na fila'}</span>
              </button>
            </div>
          );
        })}
      </div>
      {!filtered.length && <p className="text-sm text-zinc-400">Nenhum modelo corresponde aos filtros. Você pode salvar o ID manualmente.</p>}
    </div>
  );
};
