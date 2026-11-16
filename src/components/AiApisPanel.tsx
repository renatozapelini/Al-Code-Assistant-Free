import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Loader2,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { PROVIDER_PRESETS } from '../data/providerPresets';
import type {
  DiscoveredAiProvider,
  GatewaySettings,
  ProviderCategory,
  ProviderPreset,
  ProviderPresetId,
  SafeProviderSummary,
} from '../types/hub';

const DEFAULT_PROVIDER_PRESET = PROVIDER_PRESETS.find((preset) => preset.id === 'openai') || PROVIDER_PRESETS[0];

interface AiApisPanelProps {
  providers: SafeProviderSummary[];
  settings?: GatewaySettings;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onProvidersChanged: () => void;
  onOpenQoder?: () => void;
}

interface ProviderEditDraft {
  name: string;
  baseUrl: string;
  defaultModel: string;
  protocol: 'openai' | 'anthropic';
  apiKey: string;
}

export function buildProviderPatch(draft: ProviderEditDraft) {
  return {
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    defaultModel: draft.defaultModel.trim(),
    protocol: draft.protocol,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
  };
}

interface DraftProviderRow {
  localId: string;
  provider: ProviderPresetId;
  name: string;
  baseUrl: string;
  defaultModel: string;
  protocol: 'openai' | 'anthropic';
  apiKey: string;
  showKey: boolean;
}

function makeDraftFromPreset(preset: ProviderPreset, indexSuffix?: number): DraftProviderRow {
  return {
    localId: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    provider: preset.id,
    name: indexSuffix && indexSuffix > 1 ? `${preset.name} #${indexSuffix}` : preset.name,
    baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel,
    protocol: preset.protocol,
    apiKey: '',
    showKey: false,
  };
}

function makeBlankDraft(preset: ProviderPreset): DraftProviderRow {
  return {
    localId: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    provider: preset.id,
    name: '',
    baseUrl: '',
    defaultModel: '',
    protocol: preset.protocol,
    apiKey: '',
    showKey: false,
  };
}

// The endpoint owns the credential, not the publisher of a model it hosts.
export function getEndpointPreset(provider: ProviderPresetId, baseUrl: string) {
  try {
    if (new URL(baseUrl).hostname.toLowerCase() === 'openrouter.ai') {
      return PROVIDER_PRESETS.find((preset) => preset.id === 'openrouter');
    }
  } catch {
    // Keep an incomplete URL editable; validation happens when saving.
  }
  return PROVIDER_PRESETS.find((preset) => preset.id === provider);
}

function sameEndpointModel(a: { baseUrl: string; defaultModel: string }, b: { baseUrl: string; defaultModel: string }) {
  return a.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === b.baseUrl.trim().replace(/\/+$/, '').toLowerCase()
    && a.defaultModel.trim() === b.defaultModel.trim();
}

export function isProviderSaved(
  providers: SafeProviderSummary[],
  item: Pick<DiscoveredAiProvider, 'baseUrl' | 'defaultModel'>
) {
  return providers.some((provider) => sameEndpointModel(provider, item));
}

export function selectDraftRow(rows: DraftProviderRow[], draft: DraftProviderRow) {
  const existing = rows.find((row) => sameEndpointModel(row, draft));
  if (existing) return { rows, localId: existing.localId };
  const last = rows[rows.length - 1];
  return {
    rows: last && !last.apiKey.trim() ? [...rows.slice(0, -1), draft] : [...rows, draft],
    localId: draft.localId,
  };
}

export function focusKeyForm(
  section: HTMLDivElement,
  input: HTMLInputElement | HTMLTextAreaElement,
  headerBottom: number,
  viewportHeight: number
) {
  const offset = Math.max(0, headerBottom) + 16;
  section.style.scrollMarginTop = `${offset}px`;
  section.scrollIntoView({ behavior: 'auto', block: 'start' });
  input.focus({ preventScroll: true });
  const bounds = input.getBoundingClientRect();
  if (bounds.top < offset || bounds.bottom > viewportHeight - 96) {
    input.style.scrollMarginTop = `${offset}px`;
    input.scrollIntoView({ behavior: 'auto', block: 'start' });
  }
}

export async function readProviderResponse(res: Response) {
  const data = await res.json().catch(() => null) as {
    ok?: boolean;
    count?: number;
    message?: string;
    error?: string | { message?: string };
  } | null;
  if (!res.ok || data?.ok !== true) {
    const error = typeof data?.error === 'string' ? data.error : data?.error?.message;
    throw new Error(error || data?.message || `Não foi possível concluir a operação (HTTP ${res.status}).`);
  }
  return data;
}

export const AiApisPanel: React.FC<AiApisPanelProps> = ({
  providers,
  settings,
  apiFetch,
  onProvidersChanged,
  onOpenQoder,
}) => {
  const [categoryFilter, setCategoryFilter] = useState<'all' | ProviderCategory>('all');
  const [showFreeSuggestions, setShowFreeSuggestions] = useState(true);
  const [entryMode, setEntryMode] = useState<'rows' | 'bulk'>('rows');
  const [selectedPresetId, setSelectedPresetId] = useState<ProviderPresetId>('openai');

  // Dynamic multi-row entry state
  const [draftRows, setDraftRows] = useState<DraftProviderRow[]>(() => [
    makeDraftFromPreset(DEFAULT_PROVIDER_PRESET),
  ]);

  // Bulk multi-key paste mode state
  const [bulkPresetId, setBulkPresetId] = useState<ProviderPresetId>('openai');
  const [bulkBaseName, setBulkBaseName] = useState(DEFAULT_PROVIDER_PRESET.name);
  const [bulkBaseUrl, setBulkBaseUrl] = useState(DEFAULT_PROVIDER_PRESET.baseUrl);
  const [bulkModel, setBulkModel] = useState(DEFAULT_PROVIDER_PRESET.defaultModel);
  const [bulkProtocol, setBulkProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [bulkKeysText, setBulkKeysText] = useState('');

  // Queue interaction state
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProviderEditDraft>({
    name: '',
    baseUrl: '',
    defaultModel: '',
    protocol: 'openai',
    apiKey: '',
  });
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Live AI Coding Discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discoveredList, setDiscoveredList] = useState<DiscoveredAiProvider[]>([]);
  const [sourcesChecked, setSourcesChecked] = useState<string[]>([]);
  const [discoveryScannedOnce, setDiscoveryScannedOnce] = useState(false);
  const [discoveryFilter, setDiscoveryFilter] = useState<'all' | 'ready'>('all');
  const [addingDiscoveredId, setAddingDiscoveredId] = useState<string | null>(null);
  const [addingAllDiscovered, setAddingAllDiscovered] = useState(false);

  const filteredPresets = useMemo(() => {
    const visible = showFreeSuggestions ? PROVIDER_PRESETS : PROVIDER_PRESETS.filter((preset) => preset.category !== 'free_tier');
    if (categoryFilter === 'all') return visible;
    return visible.filter((p) => p.category === categoryFilter);
  }, [categoryFilter, showFreeSuggestions]);

  const activePreset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.id === selectedPresetId) || PROVIDER_PRESETS[0],
    [selectedPresetId]
  );

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const formSectionRef = useRef<HTMLDivElement>(null);
  const keyInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const bulkKeysRef = useRef<HTMLTextAreaElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ localId: string } | null>(null);
  const mutationBusy = submitting || addingAllDiscovered || addingDiscoveredId !== null
    || testingId !== null || testingAll || savingSettings;

  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const section = formSectionRef.current;
      const input = focusRequest.localId === 'bulk'
        ? bulkKeysRef.current : keyInputRefs.current[focusRequest.localId];
      if (!section || !input) return;
      // Includes the sticky header's safe-area padding and wrapped mobile actions.
      focusKeyForm(section, input, document.querySelector('header')?.getBoundingClientRect().bottom ?? 56, window.innerHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  const selectRowInForm = (draft: DraftProviderRow) => {
    const selection = selectDraftRow(draftRows, draft);
    setEntryMode('rows');
    setSelectedPresetId(draft.provider);
    setDraftRows(selection.rows);
    setFocusRequest({ localId: selection.localId });
  };

  const handleSelectPresetCard = (preset: ProviderPreset) => {
    if (mutationBusy) return;
    setNotice(null);
    if (entryMode === 'bulk' && preset.requiresKey && (!bulkKeysText.trim() || bulkPresetId === preset.id)) {
      setSelectedPresetId(preset.id);
      setBulkPresetId(preset.id);
      setBulkBaseName(preset.name);
      setBulkBaseUrl(preset.baseUrl);
      setBulkModel(preset.defaultModel);
      setBulkProtocol(preset.protocol);
      setFocusRequest({ localId: 'bulk' });
      return;
    }
    // A new provider must not inherit keys already typed for a different one.
    selectRowInForm(makeDraftFromPreset(preset));
    if (entryMode === 'bulk' && bulkKeysText.trim()) {
      setNotice({ kind: 'ok', text: 'O lote digitado foi preservado no modo Colar várias chaves. Preencha a nova chave neste campo separado.' });
    }
  };

  const handleRowPresetChange = (localId: string, presetId: ProviderPresetId) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) || PROVIDER_PRESETS[0];
    const current = draftRows.find((row) => row.localId === localId);
    if (current?.provider === preset.id) return;
    if (current?.apiKey.trim()) {
      selectRowInForm(makeDraftFromPreset(preset));
      setNotice({ kind: 'ok', text: 'A chave digitada foi preservada no provedor original. Preencha o novo campo.' });
      return;
    }
    setSelectedPresetId(preset.id);
    setDraftRows((prev) => prev.map((row) => row.localId === localId
      ? { ...makeDraftFromPreset(preset), localId } : row));
    setFocusRequest({ localId });
  };

  const updateRow = (localId: string, patch: Partial<DraftProviderRow>) => {
    setDraftRows((prev) => prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  };

  const removeDraftRow = (localId: string) => {
    setDraftRows((prev) => (prev.length > 1 ? prev.filter((r) => r.localId !== localId) : prev));
  };

  const postProvidersSequence = async (
    items: Array<{
      provider: ProviderPresetId;
      name: string;
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
      protocol: 'openai' | 'anthropic';
    }>
  ) => {
    // Try batch first; use individual provider requests if the batch route is unavailable.
    const batchRes = await apiFetch('/api/app/providers/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    if (batchRes.ok) {
      const data = await readProviderResponse(batchRes);
      return data.count ?? items.length;
    }

    if (batchRes.status !== 404) {
      await readProviderResponse(batchRes);
    }

    let createdCount = 0;
    for (const item of items) {
      const res = await apiFetch('/api/app/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      await readProviderResponse(res);
      createdCount++;
    }
    return createdCount;
  };

  const handleSubmitRows = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mutationBusy) return;
    setNotice(null);

    const payloadItems: Array<{
      provider: ProviderPresetId;
      name: string;
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
      protocol: 'openai' | 'anthropic';
    }> = [];

    for (const row of draftRows) {
      const preset = getEndpointPreset(row.provider, row.baseUrl);
      const isLocalOrFree =
        preset?.requiresKey === false ||
        row.baseUrl.includes('127.0.0.1') ||
        row.baseUrl.includes('localhost');

      if (!row.apiKey.trim() && !isLocalOrFree) {
        setNotice({
          kind: 'err',
          text: `Preencha a API Key de "${row.name || row.provider}" ou remova o campo vazio.`,
        });
        return;
      }

      payloadItems.push({
        provider: preset?.id || row.provider,
        name: row.name.trim() || preset?.name || 'IA Customizada',
        baseUrl: row.baseUrl.trim() || preset?.baseUrl || '',
        apiKey: row.apiKey.trim(),
        defaultModel: row.defaultModel.trim() || preset?.defaultModel || 'gpt-4o-mini',
        protocol: preset?.id === 'openrouter' ? 'openai' : row.protocol,
      });
    }

    setSubmitting(true);
    try {
      const count = await postProvidersSequence(payloadItems);
      setDraftRows([makeBlankDraft(activePreset)]);
      setNotice({
        kind: 'ok',
        text: `${count} API(s) salvas. Teste a conexão e escolha-as na fila do projeto.`,
      });
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao salvar chaves.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitBulk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mutationBusy) return;
    setNotice(null);
    const lines = bulkKeysText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      setNotice({ kind: 'err', text: 'Cole pelo menos uma API Key (uma por linha).' });
      return;
    }

    setSubmitting(true);
    try {
      const items = lines.map((key, idx) => ({
        provider: bulkPresetId,
        name: lines.length > 1 ? `${bulkBaseName.trim() || bulkPresetId} #${idx + 1}` : bulkBaseName.trim() || bulkPresetId,
        baseUrl: bulkBaseUrl.trim(),
        apiKey: key,
        defaultModel: bulkModel.trim(),
        protocol: bulkProtocol,
      }));
      const count = await postProvidersSequence(items);
      setBulkKeysText('');
      setBulkBaseName('');
      setBulkBaseUrl('');
      setBulkModel('');
      setNotice({
        kind: 'ok',
        text: `${count} chave(s) salvas. Teste a conexão e escolha-as na fila do projeto.`,
      });
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao importar chaves em lote.' });
    } finally {
      setSubmitting(false);
    }
  };

  const runProviderAction = async (
    id: string,
    action: 'test' | 'toggle' | 'delete' | 'up' | 'down'
  ) => {
    if (mutationBusy) return;
    setTestingId(id);
    setNotice(null);
    try {
      let res: Response;
      if (action === 'up' || action === 'down') {
        res = await apiFetch(`/api/app/providers/${encodeURIComponent(id)}/priority`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: action }),
        });
      } else if (action === 'delete') {
        res = await apiFetch(`/api/app/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        res = await apiFetch(`/api/app/providers/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
        });
      }
      const data = await readProviderResponse(res);
      setNotice({ kind: 'ok', text: data.message || (action === 'test' ? 'A API respondeu ao teste real.' : 'API atualizada.') });
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao atualizar API.' });
      if (action === 'test') onProvidersChanged();
    } finally {
      setTestingId(null);
    }
  };

  const handleTestAllProviders = async () => {
    if (enabledProviders.length === 0 || mutationBusy) return;
    setTestingAll(true);
    setNotice(null);
    let okCount = 0;
    for (const prv of providers) {
      if (!prv.enabled) continue;
      try {
        const res = await apiFetch(`/api/app/providers/${encodeURIComponent(prv.id)}/test`, {
          method: 'POST',
        });
        await readProviderResponse(res);
        okCount++;
      } catch {
        // continue testing remaining keys
      }
    }
    setTestingAll(false);
    setNotice({
      kind: okCount === enabledProviders.length ? 'ok' : 'err',
      text: `Teste em lote finalizado: ${okCount} de ${enabledProviders.length} API(s) ativa(s) responderam.`,
    });
    onProvidersChanged();
  };

  const startEdit = (prv: SafeProviderSummary) => {
    setEditingId(prv.id);
    setEditDraft({
      name: prv.name,
      baseUrl: prv.baseUrl,
      defaultModel: prv.defaultModel,
      protocol: prv.protocol,
      apiKey: '',
    });
  };

  const saveEdit = async (prv: SafeProviderSummary) => {
    if (mutationBusy) return;
    setTestingId(prv.id);
    setNotice(null);
    try {
      const payload = buildProviderPatch(editDraft);
      const res = await apiFetch(`/api/app/providers/${encodeURIComponent(prv.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Never recreate/delete a saved provider on PATCH failure: projects reference its id.
      await readProviderResponse(res);
      setEditingId(null);
      setNotice({ kind: 'ok', text: `${editDraft.name} atualizada.` });
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao editar API.' });
    } finally {
      setTestingId(null);
    }
  };

  const toggleSetting = async (
    key: 'autoFailoverEnabled',
    val: boolean
  ) => {
    if (mutationBusy) return;
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/app/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val }),
      });
      await readProviderResponse(res);
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao salvar configuração.' });
    } finally {
      setSavingSettings(false);
    }
  };

  const isProviderConfigured = (baseUrl: string, model: string) =>
    isProviderSaved(providers, { baseUrl, defaultModel: model });

  const handleDiscoverAi = async () => {
    if (discovering || mutationBusy) return;
    setDiscovering(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/app/providers/discover', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          discovered?: DiscoveredAiProvider[] | number;
          providers?: DiscoveredAiProvider[];
          sourcesChecked?: string[];
          errors?: unknown[];
        };
        const items = (Array.isArray(data.discovered) ? data.discovered : Array.isArray(data.providers) ? data.providers : [])
          .map((item) => getEndpointPreset(item.provider, item.baseUrl)?.id === 'openrouter'
            ? { ...item, provider: 'openrouter' as const, protocol: 'openai' as const, requiresKey: true } : item);
        const sources = Array.isArray(data.sourcesChecked) ? data.sourcesChecked : [...new Set(items.map(item => item.source))];
        setDiscoveredList(items);
        setSourcesChecked(sources);
        setDiscoveryScannedOnce(true);
        const readyCount = items.filter((d) => d.canAutoAdd && !isProviderConfigured(d.baseUrl, d.defaultModel)).length;
        setNotice({
          kind: 'ok',
          text: `${items.length} modelo(s) encontrado(s) em ${sources.length} fonte(s); ${readyCount} podem reutilizar uma chave salva ou endpoint local. ${data.errors?.length ? 'Algumas fontes não responderam; a lista pode estar incompleta.' : 'Teste disponibilidade e suporte a ferramentas antes de usar.'}`,
        });
        return;
      }

      const failure = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(failure?.error?.message || `Não foi possível consultar catálogos (${res.status}).`);
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Erro ao procurar novas IAs de código.',
      });
    } finally {
      setDiscovering(false);
    }
  };

  const prefillDiscoveredInForm = (item: DiscoveredAiProvider) => {
    const preset = getEndpointPreset(item.provider, item.baseUrl);
    selectRowInForm({
      ...makeDraftFromPreset(preset || PROVIDER_PRESETS[0]),
      provider: preset?.id || item.provider,
      name: item.name,
      baseUrl: item.baseUrl,
      defaultModel: item.defaultModel,
      protocol: preset?.id === 'openrouter' ? 'openai' : item.protocol,
    });
    setNotice({
      kind: 'ok',
      text: `Preencha a chave de ${preset?.name || 'seu provedor'} para "${item.defaultModel}". As chaves já digitadas foram preservadas. Registro e obtenção da chave são feitos por você no site oficial.`,
    });
  };

  const handleAddDiscovered = async (item: DiscoveredAiProvider) => {
    if (mutationBusy || discovering || isProviderConfigured(item.baseUrl, item.defaultModel)) return;
    if (!item.canAutoAdd) {
      prefillDiscoveredInForm(item);
      return;
    }
    setAddingDiscoveredId(item.id);
    setNotice(null);
    try {
      const res = await apiFetch('/api/app/providers/discover/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.status === 404) {
        if (item.requiresKey) {
          prefillDiscoveredInForm(item);
          return;
        }
        await postProvidersSequence([
          {
            provider: item.provider,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: '',
            defaultModel: item.defaultModel,
            protocol: item.protocol,
          },
        ]);
      } else {
        await readProviderResponse(res);
      }
      setNotice({
        kind: 'ok',
        text: `${item.name} adicionada às APIs. Teste a conexão e selecione-a na fila do projeto.`,
      });
      onProvidersChanged();
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Erro ao adicionar IA descoberta.',
      });
    } finally {
      setAddingDiscoveredId(null);
    }
  };

  const readyToAutoAddList = useMemo(
    () => discoveredList.filter((d) => d.canAutoAdd && !isProviderConfigured(d.baseUrl, d.defaultModel)),
    [discoveredList, providers]
  );

  const visibleDiscovered = useMemo(() => {
    const list =
      discoveryFilter === 'ready'
        ? discoveredList.filter((d) => d.canAutoAdd)
        : discoveredList;
    return list;
  }, [discoveredList, discoveryFilter]);

  const handleAddAllReadyDiscovered = async () => {
    if (readyToAutoAddList.length === 0 || mutationBusy || discovering) return;
    setAddingAllDiscovered(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/app/providers/discover/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: readyToAutoAddList }),
      });
      if (res.status === 404) {
        if (readyToAutoAddList.some((item) => item.requiresKey)) {
          throw new Error('Reutilização de chaves indisponível nesta versão. Use Adicionar chave para preencher o formulário de cada modelo.');
        }
        await postProvidersSequence(
          readyToAutoAddList.map((item) => ({
            provider: item.provider,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: '',
            defaultModel: item.defaultModel,
            protocol: item.protocol,
          }))
        );
      } else {
        await readProviderResponse(res);
      }
      setNotice({
        kind: 'ok',
        text: `${readyToAutoAddList.length} API(s) adicionadas. Teste a conexão e selecione-as na fila do projeto.`,
      });
      onProvidersChanged();
    } catch (err) {
      setNotice({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Erro ao adicionar lote descoberto.',
      });
    } finally {
      setAddingAllDiscovered(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 space-y-3">
        <h1 className="text-xl font-bold text-zinc-100">APIs de IA e chaves</h1>
        <p className="text-xs text-zinc-400">
          {providers.length} API(s) salvas · {enabledProviders.length} habilitadas (não comprova conexão).
          {' '}Adicione uma chave, teste e escolha a fila em Projetos.
        </p>
        <button
          type="button"
          disabled={mutationBusy}
          aria-pressed={settings?.autoFailoverEnabled ?? true}
          onClick={() => void toggleSetting('autoFailoverEnabled', !(settings?.autoFailoverEnabled ?? true))}
          className="min-h-[44px] px-3 rounded-xl border border-zinc-800 text-xs text-zinc-200 disabled:opacity-50"
        >
          {savingSettings ? 'Salvando…' : `Troca automática: ${settings?.autoFailoverEnabled ?? true ? 'ativada' : 'desativada'}`}
        </button>
      </section>

      {notice && (
        <div
          role={notice.kind === 'err' ? 'alert' : 'status'}
          className={`px-4 py-3 rounded-xl text-xs font-medium border ${
            notice.kind === 'ok'
              ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
              : 'bg-red-950/30 border-red-800/60 text-red-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      <details className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 space-y-4">
        <summary className="min-h-[44px] cursor-pointer text-sm font-semibold text-zinc-200">
          Descobrir modelos (opcional)
        </summary>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-zinc-400 max-w-2xl">
            Consulta OpenRouter e endpoints configurados/locais. Preço zero ou :free não dispensa chave, limites ou teste de ferramentas.
          </p>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {readyToAutoAddList.length > 0 && (
              <button
                type="button"
                disabled={mutationBusy || discovering}
                onClick={() => void handleAddAllReadyDiscovered()}
                className="min-h-[44px] px-4 rounded-xl border border-emerald-500/60 bg-emerald-950/35 hover:bg-emerald-900/45 disabled:opacity-50 text-xs font-semibold text-emerald-300 flex items-center gap-2 whitespace-nowrap transition-colors"
              >
                {addingAllDiscovered ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span>{addingAllDiscovered ? 'Adicionando…' : `Adicionar ${readyToAutoAddList.length} com chave salva / local`}</span>
              </button>
            )}

            <button
              type="button"
              disabled={discovering || mutationBusy}
              onClick={() => void handleDiscoverAi()}
              className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              {discovering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Radar className="w-4 h-4" />
              )}
              <span>{discovering ? 'Consultando…' : 'Consultar catálogos'}</span>
            </button>
          </div>
        </div>

        {discoveryScannedOnce && (
          <div className="space-y-3 pt-3 border-t border-zinc-800/80">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs text-zinc-400">
                Fontes verificadas:{' '}
                <span className="text-zinc-200 font-medium">
                  {sourcesChecked.length > 0 ? sourcesChecked.join(' · ') : 'Nenhuma fonte acessível offline'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setDiscoveryFilter('all')}
                  className={`min-h-[34px] px-3 rounded-lg border text-xs font-medium ${
                    discoveryFilter === 'all'
                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                      : 'border-zinc-800 bg-[#090B0E] text-zinc-400'
                  }`}
                >
                  Todas ({discoveredList.length})
                </button>
                <button
                  type="button"
                  onClick={() => setDiscoveryFilter('ready')}
                  className={`min-h-[34px] px-3 rounded-lg border text-xs font-medium ${
                    discoveryFilter === 'ready'
                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                      : 'border-zinc-800 bg-[#090B0E] text-zinc-400'
                  }`}
                >
                  Chave salva / local ({discoveredList.filter((d) => d.canAutoAdd).length})
                </button>
              </div>
            </div>

            {visibleDiscovered.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800 text-xs text-zinc-400">
                Nenhuma nova IA de código encontrada para este filtro. Verifique sua internet ou inicie o Ollama/LM Studio localmente.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[360px] overflow-y-auto pr-1">
                {visibleDiscovered.map((item) => {
                  const configured = isProviderConfigured(item.baseUrl, item.defaultModel);
                  const isBusy = addingDiscoveredId === item.id
                    || (addingAllDiscovered && readyToAutoAddList.some((ready) => ready.id === item.id));
                  const itemPreset = getEndpointPreset(item.provider, item.baseUrl);

                  return (
                    <div
                      key={item.id}
                      className="p-3.5 rounded-xl bg-[#090B0E] border border-zinc-800/90 flex flex-col justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-zinc-100 truncate">
                            {item.name}
                          </span>
                          <span
                            className={`text-[11px] font-medium shrink-0 ${
                              configured
                                ? 'text-zinc-500'
                                : item.canAutoAdd
                                  ? 'text-emerald-400'
                                  : 'text-amber-400'
                            }`}
                          >
                            {configured
                              ? 'Já adicionada'
                              : item.canAutoAdd
                                ? 'Chave salva / local'
                                : 'Requer chave'}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-zinc-400 truncate">
                          {item.defaultModel}
                          {item.contextLength
                            ? ` · ${Math.round(item.contextLength / 1000)}k ctx`
                            : ''}
                        </div>
                        <p className="text-[11px] text-zinc-500 line-clamp-2">{item.description}</p>
                        {configured && (
                          <p className="text-[11px] text-zinc-400">Ainda precisa escolher esta API na fila do projeto.</p>
                        )}
                        {itemPreset?.signupUrl && (
                          <a
                            href={itemPreset.signupUrl}
                            target="_self"
                            rel="noopener noreferrer"
                            className="min-h-[40px] text-xs text-emerald-300 flex items-center gap-1.5"
                          >
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                            Registrar / obter chave ({itemPreset.name})
                          </a>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={configured || mutationBusy || discovering}
                        aria-busy={isBusy}
                        onClick={() => void handleAddDiscovered(item)}
                        className={`min-h-[40px] w-full px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                          configured
                            ? 'bg-zinc-900 border border-zinc-800 text-zinc-500 cursor-default'
                            : item.canAutoAdd
                              ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-600/60 text-emerald-300'
                              : 'bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200'
                        }`}
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : configured ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Plus className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {isBusy
                            ? 'Adicionando…'
                            : configured
                              ? 'Já adicionada'
                              : item.canAutoAdd
                                ? 'Adicionar com chave salva / local'
                                : 'Adicionar chave'}
                        </span>
                      </button>
                      {item.canAutoAdd && !configured && (
                        <button
                          type="button"
                          disabled={mutationBusy || discovering}
                          onClick={() => prefillDiscoveredInForm(item)}
                          className="min-h-[40px] text-xs text-zinc-300 border border-zinc-800 rounded-lg disabled:opacity-50"
                        >
                          Adicionar chave
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </details>

      {/* Provider Catalog + Multi-Key Entry Form */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-emerald-400 shrink-0" />
            <h2 className="text-base font-semibold text-zinc-100">
              1. Escolha as IAs e Adicione Suas Chaves
            </h2>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#090B0E] border border-zinc-800 rounded-xl w-full sm:w-fit">
            <button
              type="button"
              disabled={mutationBusy}
              onClick={() => setEntryMode('rows')}
              className={`flex-1 sm:flex-initial min-h-[40px] px-3.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                entryMode === 'rows' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Campos Dinâmicos
            </button>
            <button
              type="button"
              disabled={mutationBusy}
              onClick={() => setEntryMode('bulk')}
              className={`flex-1 sm:flex-initial min-h-[40px] px-3.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                entryMode === 'bulk' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Colar Várias Chaves
            </button>
          </div>
        </div>

        {/* Category Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: `Disponíveis (${showFreeSuggestions ? PROVIDER_PRESETS.length : PROVIDER_PRESETS.filter((preset) => preset.category !== 'free_tier').length})` },
              { id: 'major', label: 'Principais / Pagas' },
              { id: 'local', label: 'Locais (Ollama/LM)' },
              { id: 'custom', label: 'Customizada' },
              ...(showFreeSuggestions ? [{ id: 'free_tier' as const, label: 'Com cota grátis (opcional)' }] : []),
            ] as const
          ).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id)}
              className={`min-h-[38px] px-3.5 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
                categoryFilter === cat.id
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                  : 'border-zinc-800 bg-[#090B0E] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {cat.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={showFreeSuggestions}
            onClick={() => {
              setShowFreeSuggestions((current) => {
                if (current && categoryFilter === 'free_tier') setCategoryFilter('major');
                return !current;
              });
            }}
            className="min-h-[38px] px-3.5 rounded-lg border border-zinc-800 bg-[#090B0E] text-xs font-medium text-zinc-300"
          >
            {showFreeSuggestions ? 'Ocultar sugestões grátis' : 'Mostrar opções com cota grátis'}
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">Opções com cota grátis aparecem por padrão no catálogo, mas nunca são ativadas nem adicionadas à fila automaticamente. Oculte-as se preferir ver apenas os provedores principais.</p>

        {/* Provider Preset Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
          {filteredPresets.map((p) => {
            const isSelected = selectedPresetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={mutationBusy}
                onClick={() => handleSelectPresetCard(p)}
                className={`min-h-[58px] p-3 rounded-xl border text-left transition-colors ${
                  isSelected
                    ? 'bg-emerald-500/15 border-emerald-500 text-zinc-100'
                    : 'bg-[#090B0E] border-zinc-800 hover:border-zinc-700 text-zinc-300'
                }`}
              >
                <div className="text-xs font-semibold truncate">{p.name}</div>
                <div className="text-[11px] text-emerald-400 mt-0.5 truncate">{p.requiresKey ? 'Exige chave' : p.category === 'local' ? 'Servidor local' : 'URL própria'}</div>
              </button>
            );
          })}
        </div>

        {/* Selected Preset Context Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-zinc-800/70">
          <p className="text-xs text-zinc-400">Registro manual no site oficial. Confira preços, cotas e suporte a ferramentas antes de usar.</p>
          {activePreset.signupUrl && (
            <a
              href={activePreset.signupUrl}
              target="_self"
              rel="noopener noreferrer"
              className="min-h-[38px] px-3.5 rounded-lg border border-emerald-600/50 bg-emerald-950/30 hover:bg-emerald-900/40 text-xs font-medium text-emerald-300 flex items-center gap-1.5 whitespace-nowrap self-start shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Registrar / obter chave ({activePreset.name})</span>
            </a>
          )}
        </div>

        <div id="ai-api-key-form" ref={formSectionRef} role="region" aria-labelledby="ai-api-key-form-title" className="space-y-3">
          <h3 id="ai-api-key-form-title" className="text-sm font-semibold text-zinc-100">Formulário de chaves</h3>
        {entryMode === 'rows' && (
          <form aria-label="Adicionar chaves de APIs" onSubmit={(e) => void handleSubmitRows(e)} className="space-y-3">
            <fieldset disabled={mutationBusy} className="space-y-3 min-w-0">
            {draftRows.map((row) => {
              const rowPreset = getEndpointPreset(row.provider, row.baseUrl) || PROVIDER_PRESETS[0];
              return (
                <div
                  key={row.localId}
                  className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800/90 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-mono font-semibold text-emerald-400">
                      Nova API
                    </span>
                    {rowPreset.signupUrl ? (
                      <a href={rowPreset.signupUrl} target="_self" rel="noopener noreferrer" className="min-h-[40px] text-xs text-emerald-300 flex items-center gap-1.5">
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        Registrar / obter chave ({rowPreset.name})
                      </a>
                    ) : (
                      <span className="text-[11px] text-zinc-400">{rowPreset.category === 'local' ? 'Servidor local; chave opcional.' : 'Registrar / obter chave: consulte seu provedor.'}</span>
                    )}
                    {draftRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeDraftRow(row.localId)}
                        className="min-h-[34px] px-2.5 rounded-lg text-xs text-zinc-400 hover:text-rose-400 hover:bg-rose-950/30 flex items-center gap-1"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Remover campo</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Provedor de IA</label>
                      <select
                        value={row.provider}
                        onChange={(e) =>
                          handleRowPresetChange(row.localId, e.target.value as ProviderPresetId)
                        }
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        {PROVIDER_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Apelido na Fila</label>
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => updateRow(row.localId, { name: e.target.value })}
                        placeholder="Ex: DeepSeek Chave 1"
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Modelo</label>
                      <input
                        type="text"
                        value={row.defaultModel}
                        onChange={(e) => updateRow(row.localId, { defaultModel: e.target.value })}
                        placeholder={rowPreset.defaultModel}
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    {row.provider === 'custom' ? <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Formato da API customizada</label>
                      <select
                        value={row.protocol}
                        onChange={(e) =>
                          updateRow(row.localId, {
                            protocol: e.target.value === 'anthropic' ? 'anthropic' : 'openai',
                          })
                        }
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="openai">Chat Completions compatível</option>
                        <option value="anthropic">Anthropic / Claude Messages</option>
                      </select>
                      <p className="text-[10px] text-zinc-500">Anthropic é a empresa do Claude. Escolha este formato somente para um endpoint Claude/Anthropic.</p>
                    </div> : <div className="space-y-1">
                      <span className="text-[11px] text-zinc-400">Integração</span>
                      <p className="min-h-[44px] flex items-center rounded-xl border border-zinc-800 bg-[#12151B] px-3 text-xs text-zinc-200">{row.provider === 'gemini' ? 'Google Gemini · API nativa' : rowPreset.name}</p>
                    </div>}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Base URL da API</label>
                      <input
                        type="url"
                        value={row.baseUrl}
                        onChange={(e) => updateRow(row.localId, { baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3.5 text-xs font-mono text-zinc-300 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor={`api-key-${row.localId}`} className="text-[11px] text-zinc-400">
                        {rowPreset.requiresKey ? `API Key (${rowPreset.name})` : 'API Key (Opcional / Local)'}
                      </label>
                      <div className="relative flex items-center">
                        <input
                          id={`api-key-${row.localId}`}
                          ref={(input) => {
                            if (input) keyInputRefs.current[row.localId] = input;
                            else delete keyInputRefs.current[row.localId];
                          }}
                          autoComplete="off"
                          spellCheck={false}
                          type={row.showKey ? 'text' : 'password'}
                          value={row.apiKey}
                          onChange={(e) => updateRow(row.localId, { apiKey: e.target.value })}
                          placeholder={
                            rowPreset.requiresKey
                              ? 'Cole sua chave secreta aqui (sk-..., AIza..., gsk_...)'
                              : 'Opcional para Ollama / LM Studio'
                          }
                          className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl pl-3.5 pr-11 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <button
                          type="button"
                          onClick={() => updateRow(row.localId, { showKey: !row.showKey })}
                          aria-label="Mostrar ou ocultar chave"
                          className="absolute right-1 min-h-[40px] min-w-[40px] flex items-center justify-center text-zinc-400 hover:text-zinc-200"
                        >
                          {row.showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Suggested Model Chips */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-zinc-500 mr-1">Modelos rápidos:</span>
                    {rowPreset.suggestedModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => updateRow(row.localId, { defaultModel: m })}
                        className={`min-h-[30px] px-2.5 rounded-lg border text-[11px] font-mono transition-colors ${
                          row.defaultModel === m
                            ? 'border-emerald-500 text-emerald-300 bg-emerald-950/30'
                            : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={mutationBusy}
                className="min-h-[48px] px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                <span>
                  {submitting ? 'Adicionando…' : `Salvar ${draftRows.length > 1 ? `${draftRows.length} APIs` : 'API'}`}
                </span>
              </button>
            </div>
            </fieldset>
          </form>
        )}

        {/* Mode 2: Paste Multiple Keys in Bulk */}
        {entryMode === 'bulk' && (
          <form aria-label="Adicionar chaves em lote" onSubmit={(e) => void handleSubmitBulk(e)} className="space-y-3 p-4 rounded-xl bg-[#090B0E] border border-zinc-800/90">
            <fieldset disabled={mutationBusy} className="space-y-3 min-w-0">
            {getEndpointPreset(bulkPresetId, bulkBaseUrl)?.signupUrl && (
              <a href={getEndpointPreset(bulkPresetId, bulkBaseUrl)?.signupUrl} target="_self" rel="noopener noreferrer" className="min-h-[40px] text-xs text-emerald-300 flex items-center gap-1.5">
                <ExternalLink className="w-3.5 h-3.5" />
                Registrar / obter chave ({getEndpointPreset(bulkPresetId, bulkBaseUrl)?.name})
              </a>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400">Provedor das Chaves</label>
                <select
                  value={bulkPresetId}
                  onChange={(e) => {
                    const nextPreset =
                      PROVIDER_PRESETS.find((p) => p.id === e.target.value) || PROVIDER_PRESETS[0];
                    handleSelectPresetCard(nextPreset);
                  }}
                  className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100"
                >
                  {PROVIDER_PRESETS.filter((p) => p.requiresKey).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400">Prefixo do Nome</label>
                <input
                  type="text"
                  value={bulkBaseName}
                  onChange={(e) => setBulkBaseName(e.target.value)}
                  className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3.5 text-sm text-zinc-100"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400">Modelo Padrão</label>
                <input
                  type="text"
                  value={bulkModel}
                  onChange={(e) => setBulkModel(e.target.value)}
                  className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3.5 text-sm font-mono text-zinc-100"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="bulk-api-keys" className="text-[11px] text-zinc-400">
                Cole suas API Keys (uma por linha; selecione a fila em Projetos após salvar)
              </label>
              <textarea
                id="bulk-api-keys"
                ref={bulkKeysRef}
                autoComplete="off"
                spellCheck={false}
                rows={4}
                value={bulkKeysText}
                onChange={(e) => setBulkKeysText(e.target.value)}
                placeholder={'AIzaSy...\nAIzaSy...\nAIzaSy...'}
                className="w-full bg-[#12151B] border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={mutationBusy || !bulkKeysText.trim()}
                className="min-h-[48px] px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                <span>{submitting ? 'Adicionando…' : 'Adicionar chaves em lote'}</span>
              </button>
            </div>
            </fieldset>
          </form>
        )}
        </div>
      </section>

      <section aria-labelledby="qoder-official-title" className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 space-y-2">
        <h2 id="qoder-official-title" className="text-sm font-semibold text-zinc-100">Qoder · assistente usado no desenvolvimento</h2>
        <p className="text-xs text-zinc-400">O Qoder ajudou a desenvolver este app e possui acesso assistido para organizar múltiplas contas. Ele não é tratado aqui como API de inferência.</p>
        <div className="flex flex-wrap gap-3">
          {onOpenQoder && <button type="button" onClick={onOpenQoder} className="min-h-[44px] text-xs text-emerald-300">Gerenciar logins Qoder</button>}
          <a href="https://qoder.com" target="_self" rel="noopener noreferrer" className="min-h-[44px] text-xs text-emerald-300 flex items-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> Abrir site oficial
          </a>
        </div>
      </section>

      {/* Section 2: Priority Failover Queue */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              2. APIs salvas e prioridade ({providers.length})
            </h2>
            <p className="text-xs text-zinc-400">
              Teste as conexões aqui; em Projetos, escolha quais APIs compõem a fila. A troca automática usa apenas as APIs selecionadas.
            </p>
          </div>

          {providers.length > 0 && (
            <button
              type="button"
              disabled={mutationBusy || enabledProviders.length === 0}
              onClick={() => void handleTestAllProviders()}
              className="min-h-[42px] px-4 rounded-xl border border-zinc-800 bg-[#12151B] hover:bg-zinc-800 text-xs font-semibold text-zinc-200 flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testingAll ? 'animate-spin' : ''}`} />
              <span>{testingAll ? 'Testando…' : 'Testar APIs habilitadas'}</span>
            </button>
          )}
        </div>

        {providers.length === 0 ? (
          <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-6 text-center space-y-2">
            <p className="text-sm font-medium text-zinc-200">
              Nenhuma API de IA salva ainda
            </p>
            <p className="text-xs text-zinc-400 max-w-lg mx-auto">
              Adicione suas chaves no formulário acima ou conecte um servidor local Ollama / LM Studio. Depois, teste e escolha a fila em Projetos.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((prv, idx) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const inCooldown = Boolean(prv.cooldownUntil && prv.cooldownUntil > nowSec);
              const cooldownSecLeft = inCooldown && prv.cooldownUntil ? prv.cooldownUntil - nowSec : 0;
              const isBusy = testingId === prv.id || (testingAll && prv.enabled);
              const isEditing = editingId === prv.id;
              const testedWorking = prv.enabled && !inCooldown && !prv.lastError && prv.requestCount > 0;

              return (
                <div
                  key={prv.id}
                  className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-4 space-y-3"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-mono font-bold text-emerald-400 tabular-nums">
                          #{idx + 1}
                        </span>
                        <h3 className="text-sm font-semibold text-zinc-100 truncate">{prv.name}</h3>
                        <span className="text-[11px] text-zinc-500">
                          {PROVIDER_PRESETS.find((preset) => preset.id === prv.provider)?.name || (prv.protocol === 'anthropic' ? 'Claude / Anthropic' : 'API customizada')}
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            testedWorking
                              ? 'text-emerald-400'
                              : inCooldown || prv.lastError
                                ? 'text-amber-400'
                                : 'text-zinc-500'
                          }`}
                        >
                          {!prv.enabled
                            ? 'Pausada'
                            : inCooldown
                              ? `Indisponível · aguarde ${cooldownSecLeft}s`
                              : prv.lastError
                                ? 'Falhou no último teste'
                                : testedWorking
                                  ? 'Funcionando'
                                  : 'Ainda não testada'}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-zinc-400 truncate tabular-nums">
                        {prv.defaultModel} · {prv.keyPrefix} · {prv.requestCount} reqs ({prv.failoverCount} failovers)
                      </p>
                      <p className="text-[11px] font-mono text-zinc-500 truncate">{prv.baseUrl}</p>
                      {prv.lastError && (
                        <p className="text-xs text-amber-400 break-words">{prv.lastError}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={mutationBusy || idx === 0}
                        onClick={() => void runProviderAction(prv.id, 'up')}
                        aria-label="Subir prioridade"
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 disabled:opacity-30 text-zinc-300 flex items-center justify-center"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={mutationBusy || idx === providers.length - 1}
                        onClick={() => void runProviderAction(prv.id, 'down')}
                        aria-label="Descer prioridade"
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 disabled:opacity-30 text-zinc-300 flex items-center justify-center"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={mutationBusy}
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(prv))}
                        aria-label={`Editar ${prv.name}`}
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 text-zinc-300 flex items-center justify-center"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={mutationBusy}
                        onClick={() => void runProviderAction(prv.id, 'test')}
                        className="min-h-[44px] px-3.5 rounded-xl border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        <span>Testar</span>
                      </button>
                      <button
                        type="button"
                        disabled={mutationBusy}
                        onClick={() => void runProviderAction(prv.id, 'toggle')}
                        className="min-h-[44px] px-3.5 rounded-xl border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
                      >
                        {prv.enabled ? (
                          <Pause className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        <span>{prv.enabled ? 'Pausar' : 'Ativar'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={mutationBusy}
                        onClick={() => void runProviderAction(prv.id, 'delete')}
                        aria-label={`Remover ${prv.name}`}
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-red-950/50 text-zinc-400 hover:text-red-400 flex items-center justify-center"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Inline Editor */}
                  {isEditing && (
                    <div className="pt-3 border-t border-zinc-800/80 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                        <input
                          type="text"
                          value={editDraft.name}
                          onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="Apelido"
                          className="min-h-[42px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs text-zinc-100"
                        />
                        <input
                          type="text"
                          value={editDraft.defaultModel}
                          onChange={(e) =>
                            setEditDraft((d) => ({ ...d, defaultModel: e.target.value }))
                          }
                          placeholder="Modelo"
                          className="min-h-[42px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-mono text-zinc-100"
                        />
                        <input
                          type="url"
                          value={editDraft.baseUrl}
                          onChange={(e) => setEditDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                          placeholder="Base URL"
                          className="min-h-[42px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-mono text-zinc-100"
                        />
                        <input
                          type="password"
                          value={editDraft.apiKey}
                          onChange={(e) => setEditDraft((d) => ({ ...d, apiKey: e.target.value }))}
                          placeholder="Nova API Key (deixe vazio p/ manter)"
                          className="min-h-[42px] bg-[#090B0E] border border-zinc-800 rounded-xl px-3 text-xs font-mono text-zinc-100"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="min-h-[40px] px-4 rounded-xl border border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={mutationBusy}
                          onClick={() => void saveEdit(prv)}
                          className="min-h-[40px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Salvar Alterações</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
