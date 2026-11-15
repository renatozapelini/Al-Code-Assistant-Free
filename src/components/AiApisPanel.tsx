import React, { useMemo, useState } from 'react';
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
  ShieldCheck,
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

interface AiApisPanelProps {
  providers: SafeProviderSummary[];
  settings?: GatewaySettings;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onProvidersChanged: () => void;
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

export const AiApisPanel: React.FC<AiApisPanelProps> = ({
  providers,
  settings,
  apiFetch,
  onProvidersChanged,
}) => {
  const [categoryFilter, setCategoryFilter] = useState<'all' | ProviderCategory>('all');
  const [entryMode, setEntryMode] = useState<'rows' | 'bulk'>('rows');
  const [selectedPresetId, setSelectedPresetId] = useState<ProviderPresetId>('gemini');

  // Dynamic multi-row entry state
  const [draftRows, setDraftRows] = useState<DraftProviderRow[]>(() => [
    makeDraftFromPreset(PROVIDER_PRESETS[0]),
  ]);

  // Bulk multi-key paste mode state
  const [bulkPresetId, setBulkPresetId] = useState<ProviderPresetId>('gemini');
  const [bulkBaseName, setBulkBaseName] = useState('Google Gemini');
  const [bulkBaseUrl, setBulkBaseUrl] = useState(PROVIDER_PRESETS[0].baseUrl);
  const [bulkModel, setBulkModel] = useState(PROVIDER_PRESETS[0].defaultModel);
  const [bulkProtocol, setBulkProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [bulkKeysText, setBulkKeysText] = useState('');

  // Queue interaction state
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    baseUrl: string;
    defaultModel: string;
    protocol: 'openai' | 'anthropic';
    apiKey: string;
  }>({
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
    if (categoryFilter === 'all') return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((p) => p.category === categoryFilter);
  }, [categoryFilter]);

  const activePreset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.id === selectedPresetId) || PROVIDER_PRESETS[0],
    [selectedPresetId]
  );

  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const totalFailovers = useMemo(
    () => providers.reduce((acc, p) => acc + (p.failoverCount || 0), 0),
    [providers]
  );

  const handleSelectPresetCard = (preset: ProviderPreset) => {
    setSelectedPresetId(preset.id);
    setNotice(null);

    if (entryMode === 'bulk') {
      setBulkPresetId(preset.id);
      setBulkBaseName(preset.name);
      setBulkBaseUrl(preset.baseUrl);
      setBulkModel(preset.defaultModel);
      setBulkProtocol(preset.protocol);
      return;
    }

    setDraftRows((prev) => {
      if (prev.length === 0) return [makeDraftFromPreset(preset)];
      const updated = [...prev];
      const lastIdx = updated.length - 1;
      // If last row still has empty key, replace its template; otherwise append a new row
      if (!updated[lastIdx].apiKey.trim()) {
        updated[lastIdx] = makeDraftFromPreset(preset);
      } else {
        updated.push(makeDraftFromPreset(preset, updated.length + 1));
      }
      return updated;
    });
  };

  const handleRowPresetChange = (localId: string, presetId: ProviderPresetId) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) || PROVIDER_PRESETS[0];
    setDraftRows((prev) =>
      prev.map((row) =>
        row.localId === localId
          ? {
              ...row,
              provider: preset.id,
              name: preset.name,
              baseUrl: preset.baseUrl,
              defaultModel: preset.defaultModel,
              protocol: preset.protocol,
            }
          : row
      )
    );
  };

  const updateRow = (localId: string, patch: Partial<DraftProviderRow>) => {
    setDraftRows((prev) => prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  };

  const addAnotherRow = () => {
    const lastRow = draftRows[draftRows.length - 1];
    const preset =
      PROVIDER_PRESETS.find((p) => p.id === (lastRow?.provider || selectedPresetId)) ||
      PROVIDER_PRESETS[0];
    setDraftRows((prev) => [...prev, makeDraftFromPreset(preset, prev.length + 1)]);
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
    // Try batch endpoint first; fall back to individual /api/hub/providers calls for embedded Android APK compatibility
    const batchRes = await apiFetch('/api/hub/providers/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    if (batchRes.ok) {
      const data = (await batchRes.json()) as { ok?: boolean; count?: number; error?: string };
      if (!data.ok) throw new Error(data.error || 'Erro ao salvar APIs.');
      return data.count ?? items.length;
    }

    if (batchRes.status !== 404) {
      const errData = (await batchRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(errData.error || `HTTP ${batchRes.status}`);
    }

    let createdCount = 0;
    for (const item of items) {
      const res = await apiFetch('/api/hub/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Falha ao salvar ${item.name}`);
      }
      createdCount++;
    }
    return createdCount;
  };

  const handleSubmitRows = async (e: React.FormEvent) => {
    e.preventDefault();
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
      const preset = PROVIDER_PRESETS.find((p) => p.id === row.provider);
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
        provider: row.provider,
        name: row.name.trim() || preset?.name || 'IA Customizada',
        baseUrl: row.baseUrl.trim() || preset?.baseUrl || '',
        apiKey: row.apiKey.trim(),
        defaultModel: row.defaultModel.trim() || preset?.defaultModel || 'gpt-4o-mini',
        protocol: row.protocol,
      });
    }

    setSubmitting(true);
    try {
      const count = await postProvidersSequence(payloadItems);
      setDraftRows([makeDraftFromPreset(activePreset)]);
      setNotice({
        kind: 'ok',
        text: `${count} ${count === 1 ? 'API adicionada' : 'APIs adicionadas'} na fila de failover automático.`,
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
      setNotice({
        kind: 'ok',
        text: `${count} chave(s) em lote adicionadas à fila de failover.`,
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
    setTestingId(id);
    setNotice(null);
    try {
      if (action === 'up' || action === 'down') {
        await apiFetch(`/api/hub/providers/${encodeURIComponent(id)}/priority`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: action }),
        });
      } else if (action === 'delete') {
        await apiFetch(`/api/hub/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        const res = await apiFetch(`/api/hub/providers/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (data.message) {
          setNotice({ kind: data.ok ? 'ok' : 'err', text: data.message });
        } else if (data.error) {
          setNotice({ kind: 'err', text: data.error });
        }
      }
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Erro ao atualizar API.' });
    } finally {
      setTestingId(null);
    }
  };

  const handleTestAllProviders = async () => {
    if (providers.length === 0) return;
    setTestingAll(true);
    setNotice(null);
    let okCount = 0;
    for (const prv of providers) {
      if (!prv.enabled) continue;
      try {
        const res = await apiFetch(`/api/hub/providers/${encodeURIComponent(prv.id)}/test`, {
          method: 'POST',
        });
        const data = (await res.json()) as { ok?: boolean };
        if (data.ok) okCount++;
      } catch {
        // continue testing remaining keys
      }
    }
    setTestingAll(false);
    setNotice({
      kind: 'ok',
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
    setTestingId(prv.id);
    setNotice(null);
    try {
      const payload = {
        provider: prv.provider,
        name: editDraft.name.trim(),
        baseUrl: editDraft.baseUrl.trim(),
        defaultModel: editDraft.defaultModel.trim(),
        protocol: editDraft.protocol,
        ...(editDraft.apiKey.trim() ? { apiKey: editDraft.apiKey.trim() } : {}),
      };
      const res = await apiFetch(`/api/hub/providers/${encodeURIComponent(prv.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 404 && editDraft.apiKey.trim()) {
        await apiFetch('/api/hub/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await apiFetch(`/api/hub/providers/${encodeURIComponent(prv.id)}`, { method: 'DELETE' });
      } else if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
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
    key: 'autoFailoverEnabled' | 'fallbackToQoderZeroX' | 'autoRefreshTokens',
    val: boolean
  ) => {
    setSavingSettings(true);
    try {
      await apiFetch('/api/hub/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val }),
      });
      onProvidersChanged();
    } finally {
      setSavingSettings(false);
    }
  };

  const isProviderConfigured = (baseUrl: string, model: string) => {
    const normUrl = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
    const normModel = model.trim().toLowerCase();
    return providers.some(
      (p) =>
        p.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === normUrl &&
        p.defaultModel.trim().toLowerCase() === normModel
    );
  };

  const handleDiscoverAi = async () => {
    setDiscovering(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/hub/providers/discover', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          discovered?: DiscoveredAiProvider[];
          sourcesChecked?: string[];
        };
        const items = Array.isArray(data.discovered) ? data.discovered : [];
        setDiscoveredList(items);
        setSourcesChecked(Array.isArray(data.sourcesChecked) ? data.sourcesChecked : []);
        setDiscoveryScannedOnce(true);
        const readyCount = items.filter((d) => d.canAutoAdd && !d.alreadyConfigured).length;
        setNotice({
          kind: 'ok',
          text: `Varredura concluída em ${data.sourcesChecked?.length || 0} fonte(s): ${items.length} IA(s) de código encontradas (${readyCount} prontas para adicionar em 1 clique).`,
        });
        return;
      }

      // Embedded APK fallback if /api/hub/providers/discover is not present in older binary
      const fallbackItems: DiscoveredAiProvider[] = [];
      const fallbackSources: string[] = [];
      try {
        const pollRes = await fetch('https://text.pollinations.ai/models');
        if (pollRes.ok) {
          fallbackSources.push('Pollinations (Sem Chave)');
          const pollList = (await pollRes.json()) as Array<{ name?: string; description?: string; audio?: boolean }>;
          for (const m of (Array.isArray(pollList) ? pollList : []).filter((x) => !x.audio && x.name).slice(0, 6)) {
            const id = String(m.name || '');
            fallbackItems.push({
              id: `disc-poll-${id}`,
              provider: 'pollinations',
              name: `Pollinations · ${id}`,
              baseUrl: 'https://text.pollinations.ai/openai',
              defaultModel: id,
              protocol: 'openai',
              source: 'pollinations',
              requiresKey: false,
              canAutoAdd: true,
              alreadyConfigured: isProviderConfigured('https://text.pollinations.ai/openai', id),
              description: m.description || 'Modelo gratuito sem chave de API.',
            });
          }
        }
      } catch {
        // ignore
      }
      try {
        const orRes = await fetch('https://openrouter.ai/api/v1/models');
        if (orRes.ok) {
          fallbackSources.push('OpenRouter Catálogo :free');
          const orData = (await orRes.json()) as { data?: Array<{ id?: string; name?: string; context_length?: number }> };
          const hasOrKey = providers.some((p) => p.provider === 'openrouter');
          for (const m of (orData.data || [])
            .filter((x) => String(x.id || '').endsWith(':free') && /coder|code|deepseek|qwen|devstral/i.test(String(x.id)))
            .slice(0, 8)) {
            const id = String(m.id || '');
            fallbackItems.push({
              id: `disc-or-${id}`,
              provider: 'openrouter',
              name: `OpenRouter · ${m.name || id}`,
              baseUrl: 'https://openrouter.ai/api/v1',
              defaultModel: id,
              protocol: 'openai',
              source: 'openrouter-free',
              requiresKey: true,
              canAutoAdd: hasOrKey,
              contextLength: m.context_length,
              alreadyConfigured: isProviderConfigured('https://openrouter.ai/api/v1', id),
              description: 'Modelo :free ao vivo do OpenRouter.',
            });
          }
        }
      } catch {
        // ignore
      }
      setDiscoveredList(fallbackItems);
      setSourcesChecked(fallbackSources);
      setDiscoveryScannedOnce(true);
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
    setEntryMode('rows');
    setSelectedPresetId(item.provider);
    setDraftRows([
      {
        localId: `row-${Date.now()}-disc`,
        provider: item.provider,
        name: item.name,
        baseUrl: item.baseUrl,
        defaultModel: item.defaultModel,
        protocol: item.protocol,
        apiKey: '',
        showKey: false,
      },
    ]);
    setNotice({
      kind: 'ok',
      text: `Modelo "${item.defaultModel}" preenchido no formulário abaixo — cole sua chave gratuita para salvar na fila.`,
    });
  };

  const handleAddDiscovered = async (item: DiscoveredAiProvider) => {
    if (!item.canAutoAdd) {
      prefillDiscoveredInForm(item);
      return;
    }
    setAddingDiscoveredId(item.id);
    setNotice(null);
    try {
      const res = await apiFetch('/api/hub/providers/discover/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.status === 404) {
        await postProvidersSequence([
          {
            provider: item.provider,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: item.requiresKey ? '' : 'local-no-key',
            defaultModel: item.defaultModel,
            protocol: item.protocol,
          },
        ]);
      } else {
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }
      setDiscoveredList((prev) =>
        prev.map((d) => (d.id === item.id ? { ...d, alreadyConfigured: true } : d))
      );
      setNotice({
        kind: 'ok',
        text: `${item.name} adicionada na fila automática de failover.`,
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
    () => discoveredList.filter((d) => d.canAutoAdd && !d.alreadyConfigured && !isProviderConfigured(d.baseUrl, d.defaultModel)),
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
    if (readyToAutoAddList.length === 0) return;
    setAddingAllDiscovered(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/hub/providers/discover/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: readyToAutoAddList }),
      });
      if (res.status === 404) {
        await postProvidersSequence(
          readyToAutoAddList.map((item) => ({
            provider: item.provider,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: item.requiresKey ? '' : 'local-no-key',
            defaultModel: item.defaultModel,
            protocol: item.protocol,
          }))
        );
      } else {
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      }
      const addedIds = new Set(readyToAutoAddList.map((x) => x.id));
      setDiscoveredList((prev) =>
        prev.map((d) => (addedIds.has(d.id) ? { ...d, alreadyConfigured: true } : d))
      );
      setNotice({
        kind: 'ok',
        text: `${readyToAutoAddList.length} IA(s) de código adicionadas automaticamente à sua fila!`,
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
      {/* Top Status & Failover Summary */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Failover Automático Multi-IA Ativo · Sem Parar o Projeto</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">
              APIs de IA & Chaves de Programação
            </h1>
            <p className="text-xs text-zinc-400 max-w-2xl">
              Adicione quantas chaves e provedores quiser ({PROVIDER_PRESETS.length} IAs prontas + Customizada + Ollama/LM Studio). Quando uma acabar o saldo ou der erro 429/402, o roteador troca sozinho para a próxima da fila.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 sm:gap-6 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-zinc-800/70">
            <div>
              <div className="text-[11px] text-zinc-400">APIs Prontas</div>
              <div className="text-xl font-bold font-mono tabular-nums text-emerald-400">
                {enabledProviders.length}
                <span className="text-xs text-zinc-500 font-normal"> / {providers.length}</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Principal (#1)</div>
              <div className="text-sm font-semibold text-zinc-100 truncate max-w-[110px]">
                {enabledProviders[0]?.name || '—'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Failovers</div>
              <div className="text-xl font-bold font-mono tabular-nums text-zinc-100">
                {totalFailovers}
              </div>
            </div>
          </div>
        </div>

        {/* Failover Switches */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-zinc-800/80 text-xs">
          <button
            type="button"
            disabled={savingSettings}
            onClick={() => void toggleSetting('autoFailoverEnabled', !(settings?.autoFailoverEnabled ?? true))}
            className={`min-h-[56px] p-3.5 rounded-xl border text-left transition-colors ${
              settings?.autoFailoverEnabled ?? true
                ? 'bg-emerald-950/25 border-emerald-700/60 text-zinc-100'
                : 'bg-[#090B0E] border-zinc-800 text-zinc-400'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span>Troca Automática em Cascata</span>
              <span className={settings?.autoFailoverEnabled ?? true ? 'text-emerald-400' : 'text-zinc-500'}>
                {settings?.autoFailoverEnabled ?? true ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="mt-1 text-zinc-400">Muda sozinho ao zerar saldo ou dar 429/5xx</div>
          </button>

          <button
            type="button"
            disabled={savingSettings}
            onClick={() => void toggleSetting('fallbackToQoderZeroX', !(settings?.fallbackToQoderZeroX ?? true))}
            className={`min-h-[56px] p-3.5 rounded-xl border text-left transition-colors ${
              settings?.fallbackToQoderZeroX ?? true
                ? 'bg-emerald-950/25 border-emerald-700/60 text-zinc-100'
                : 'bg-[#090B0E] border-zinc-800 text-zinc-400'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span>Fallback Qoder 0x Grátis</span>
              <span className={settings?.fallbackToQoderZeroX ?? true ? 'text-emerald-400' : 'text-zinc-500'}>
                {settings?.fallbackToQoderZeroX ?? true ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="mt-1 text-zinc-400">Tenta Qwen3.8-Flash (0x) antes das APIs externas</div>
          </button>

          <button
            type="button"
            disabled={savingSettings}
            onClick={() => void toggleSetting('autoRefreshTokens', !(settings?.autoRefreshTokens ?? true))}
            className={`min-h-[56px] p-3.5 rounded-xl border text-left transition-colors ${
              settings?.autoRefreshTokens ?? true
                ? 'bg-emerald-950/25 border-emerald-700/60 text-zinc-100'
                : 'bg-[#090B0E] border-zinc-800 text-zinc-400'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span>Manutenção em 2o Plano</span>
              <span className={settings?.autoRefreshTokens ?? true ? 'text-emerald-400' : 'text-zinc-500'}>
                {settings?.autoRefreshTokens ?? true ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="mt-1 text-zinc-400">Renova tokens e sincroniza disponibilidade</div>
          </button>
        </div>
      </section>

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

      {/* Auto-Discovery Radar: Find & Add Free Coding AIs */}
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
              <Radar className="w-4 h-4 shrink-0" />
              <span>Descoberta Automática · Qualquer IA Gratuita de Código</span>
            </div>
            <h2 className="text-base font-semibold text-zinc-100">
              Procurar Novas IAs Code Assistant e Adicionar na Hora
            </h2>
            <p className="text-xs text-zinc-400 max-w-2xl">
              Varre servidores locais (Ollama, LM Studio, Jan, vLLM), endpoints gratuitos sem chave (Pollinations), catálogos <span className="font-mono text-zinc-300">:free</span> ao vivo (OpenRouter, Hugging Face Router) e suas APIs já conectadas para adicionar novos modelos de código em 1 clique.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {readyToAutoAddList.length > 0 && (
              <button
                type="button"
                disabled={addingAllDiscovered}
                onClick={() => void handleAddAllReadyDiscovered()}
                className="min-h-[44px] px-4 rounded-xl border border-emerald-500/60 bg-emerald-950/35 hover:bg-emerald-900/45 disabled:opacity-50 text-xs font-semibold text-emerald-300 flex items-center gap-2 whitespace-nowrap transition-colors"
              >
                {addingAllDiscovered ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span>+ Adicionar {readyToAutoAddList.length} Pronta(s)</span>
              </button>
            )}

            <button
              type="button"
              disabled={discovering}
              onClick={() => void handleDiscoverAi()}
              className="min-h-[44px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              {discovering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Radar className="w-4 h-4" />
              )}
              <span>{discovering ? 'Procurando IAs...' : 'Procurar Novas IAs Grátis'}</span>
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
                  Sem Chave / 1 Clique ({discoveredList.filter((d) => d.canAutoAdd).length})
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
                  const configured =
                    item.alreadyConfigured || isProviderConfigured(item.baseUrl, item.defaultModel);
                  const isBusy = addingDiscoveredId === item.id;

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
                              ? 'Já na Fila'
                              : item.canAutoAdd
                                ? '1-Clique Grátis'
                                : 'Requer Chave'}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-zinc-400 truncate">
                          {item.defaultModel}
                          {item.contextLength
                            ? ` · ${Math.round(item.contextLength / 1000)}k ctx`
                            : ''}
                        </div>
                        <p className="text-[11px] text-zinc-500 line-clamp-2">{item.description}</p>
                      </div>

                      <button
                        type="button"
                        disabled={configured || isBusy}
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
                          {configured
                            ? 'Adicionada'
                            : item.canAutoAdd
                              ? 'Adicionar na Fila'
                              : 'Preencher p/ Chave'}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

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
              onClick={() => setEntryMode('rows')}
              className={`flex-1 sm:flex-initial min-h-[40px] px-3.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                entryMode === 'rows' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Campos Dinâmicos
            </button>
            <button
              type="button"
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
              { id: 'all', label: `Todas (${PROVIDER_PRESETS.length})` },
              { id: 'free_tier', label: 'Cota Grátis' },
              { id: 'major', label: 'Principais / Pagas' },
              { id: 'local', label: 'Locais (Ollama/LM)' },
              { id: 'custom', label: 'Customizada' },
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
        </div>

        {/* Provider Preset Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
          {filteredPresets.map((p) => {
            const isSelected = selectedPresetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPresetCard(p)}
                className={`min-h-[58px] p-3 rounded-xl border text-left transition-colors ${
                  isSelected
                    ? 'bg-emerald-500/15 border-emerald-500 text-zinc-100'
                    : 'bg-[#090B0E] border-zinc-800 hover:border-zinc-700 text-zinc-300'
                }`}
              >
                <div className="text-xs font-semibold truncate">{p.name}</div>
                <div className="text-[11px] text-emerald-400 mt-0.5 truncate">{p.badge}</div>
              </button>
            );
          })}
        </div>

        {/* Selected Preset Context Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-zinc-800/70">
          <p className="text-xs text-zinc-400">{activePreset.description}</p>
          {activePreset.signupUrl && (
            <a
              href={activePreset.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[38px] px-3.5 rounded-lg border border-emerald-600/50 bg-emerald-950/30 hover:bg-emerald-900/40 text-xs font-medium text-emerald-300 flex items-center gap-1.5 whitespace-nowrap self-start shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Obter Chave ({activePreset.name})</span>
            </a>
          )}
        </div>

        {/* Mode 1: Dynamic Multi-Row Fields (+ Adicionar mais IA) */}
        {entryMode === 'rows' && (
          <form onSubmit={(e) => void handleSubmitRows(e)} className="space-y-3">
            {draftRows.map((row, idx) => {
              const rowPreset =
                PROVIDER_PRESETS.find((p) => p.id === row.provider) || PROVIDER_PRESETS[0];
              return (
                <div
                  key={row.localId}
                  className="p-4 rounded-xl bg-[#090B0E] border border-zinc-800/90 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono font-semibold text-emerald-400">
                      IA / Chave #{idx + 1}
                    </span>
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
                        placeholder="Ex: DeepSeek Conta 1"
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

                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400">Protocolo</label>
                      <select
                        value={row.protocol}
                        onChange={(e) =>
                          updateRow(row.localId, {
                            protocol: e.target.value === 'anthropic' ? 'anthropic' : 'openai',
                          })
                        }
                        className="w-full min-h-[44px] bg-[#12151B] border border-zinc-800 rounded-xl px-3 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="openai">OpenAI Compatible (/chat/completions)</option>
                        <option value="anthropic">Anthropic (/messages)</option>
                      </select>
                    </div>
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
                      <label className="text-[11px] text-zinc-400">
                        {rowPreset.requiresKey ? 'API Key (Obrigatória)' : 'API Key (Opcional / Local)'}
                      </label>
                      <div className="relative flex items-center">
                        <input
                          type={row.showKey ? 'text' : 'password'}
                          value={row.apiKey}
                          onChange={(e) => updateRow(row.localId, { apiKey: e.target.value })}
                          placeholder={
                            rowPreset.requiresKey
                              ? 'Cole sua chave secreta aqui (sk-..., AIza..., gsk_...)'
                              : 'Opcional para Ollama / LM Studio / Pollinations'
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

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
              <button
                type="button"
                onClick={addAnotherRow}
                className="min-h-[44px] px-4 rounded-xl border border-dashed border-zinc-700 hover:border-emerald-500/70 hover:bg-emerald-950/20 text-xs font-semibold text-zinc-200 flex items-center justify-center gap-2 transition-colors"
              >
                <Plus className="w-4 h-4 text-emerald-400" />
                <span>+ Adicionar mais IA / Outra Chave</span>
              </button>

              <button
                type="submit"
                disabled={submitting}
                className="min-h-[48px] px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                <span>
                  Salvar {draftRows.length > 1 ? `${draftRows.length} IAs` : 'na Fila'} de Failover
                </span>
              </button>
            </div>
          </form>
        )}

        {/* Mode 2: Paste Multiple Keys in Bulk */}
        {entryMode === 'bulk' && (
          <form onSubmit={(e) => void handleSubmitBulk(e)} className="space-y-3 p-4 rounded-xl bg-[#090B0E] border border-zinc-800/90">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400">Provedor das Chaves</label>
                <select
                  value={bulkPresetId}
                  onChange={(e) => {
                    const nextPreset =
                      PROVIDER_PRESETS.find((p) => p.id === e.target.value) || PROVIDER_PRESETS[0];
                    setBulkPresetId(nextPreset.id);
                    setBulkBaseName(nextPreset.name);
                    setBulkBaseUrl(nextPreset.baseUrl);
                    setBulkModel(nextPreset.defaultModel);
                    setBulkProtocol(nextPreset.protocol);
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
              <label className="text-[11px] text-zinc-400">
                Cole suas API Keys (uma chave por linha para alternar automaticamente entre todas)
              </label>
              <textarea
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
                disabled={submitting || !bulkKeysText.trim()}
                className="min-h-[48px] px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 text-sm font-semibold flex items-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                <span>Adicionar Chaves em Lote</span>
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Section 2: Priority Failover Queue */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              2. Fila de Failover por Prioridade ({providers.length})
            </h2>
            <p className="text-xs text-zinc-400">
              O hub tenta de cima (#1) para baixo. Se acabar o saldo ou der erro, pula imediatamente para a próxima.
            </p>
          </div>

          {providers.length > 0 && (
            <button
              type="button"
              disabled={testingAll}
              onClick={() => void handleTestAllProviders()}
              className="min-h-[42px] px-4 rounded-xl border border-zinc-800 bg-[#12151B] hover:bg-zinc-800 text-xs font-semibold text-zinc-200 flex items-center gap-2 whitespace-nowrap transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testingAll ? 'animate-spin' : ''}`} />
              <span>Testar Todas as APIs</span>
            </button>
          )}
        </div>

        {providers.length === 0 ? (
          <div className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-6 text-center space-y-2">
            <p className="text-sm font-medium text-zinc-200">
              Nenhuma API de IA adicionada na fila ainda
            </p>
            <p className="text-xs text-zinc-400 max-w-lg mx-auto">
              Adicione acima suas chaves (OpenAI, Claude, DeepSeek, Grok, Gemini, Groq, OpenRouter) ou conecte um servidor local Ollama / LM Studio. Você também pode adicionar o Pollinations AI como backup grátis sem chave.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((prv, idx) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const inCooldown = Boolean(prv.cooldownUntil && prv.cooldownUntil > nowSec);
              const cooldownSecLeft = inCooldown && prv.cooldownUntil ? prv.cooldownUntil - nowSec : 0;
              const isBusy = testingId === prv.id;
              const isEditing = editingId === prv.id;

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
                        <span className="text-[11px] font-mono text-zinc-500">
                          {prv.protocol.toUpperCase()}
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            !prv.enabled
                              ? 'text-zinc-500'
                              : inCooldown
                                ? 'text-amber-400'
                                : 'text-emerald-400'
                          }`}
                        >
                          {!prv.enabled
                            ? 'Pausada'
                            : inCooldown
                              ? `Cooldown (${cooldownSecLeft}s)`
                              : idx === 0
                                ? 'Pronta (Principal)'
                                : 'Pronta (Backup)'}
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
                        disabled={isBusy || idx === 0}
                        onClick={() => void runProviderAction(prv.id, 'up')}
                        aria-label="Subir prioridade"
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 disabled:opacity-30 text-zinc-300 flex items-center justify-center"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={isBusy || idx === providers.length - 1}
                        onClick={() => void runProviderAction(prv.id, 'down')}
                        aria-label="Descer prioridade"
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 disabled:opacity-30 text-zinc-300 flex items-center justify-center"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(prv))}
                        aria-label={`Editar ${prv.name}`}
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 hover:bg-zinc-800 text-zinc-300 flex items-center justify-center"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
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
                        disabled={isBusy}
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
                        disabled={isBusy}
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
                          disabled={isBusy}
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
