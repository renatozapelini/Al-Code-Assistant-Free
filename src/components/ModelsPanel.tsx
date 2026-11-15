import React, { useMemo, useState } from 'react';
import { MessageSquare, RefreshCw, Search } from 'lucide-react';
import type { QoderModel, RealmId } from '../types/hub';

interface ModelsPanelProps {
  models: QoderModel[];
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onModelsUpdated: (models: QoderModel[]) => void;
  onTestModelInChat: (modelId: string) => void;
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({
  models,
  apiFetch,
  onModelsUpdated,
  onTestModelInChat,
}) => {
  const [search, setSearch] = useState('');
  const [realmFilter, setRealmFilter] = useState<'all' | RealmId>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (realmFilter !== 'all' && !m.availableRealms.includes(realmFilter)) return false;
      if (q && !m.displayName.toLowerCase().includes(q) && !m.key.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [models, search, realmFilter]);

  const handleSyncCatalog = async (realm: RealmId) => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await apiFetch('/api/hub/catalog/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realm }),
      });
      const data = (await res.json()) as { message?: string; models?: QoderModel[] };
      if (data.models) onModelsUpdated(data.models);
      if (data.message) setSyncMessage(data.message);
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Falha ao sincronizar catálogo.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Catálogo Oficial Qoder</h1>
            <p className="text-xs text-zinc-400">
              Modelos roteados por região com multiplicador de créditos e janela de contexto.
            </p>
          </div>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleSyncCatalog(realmFilter === 'cn' ? 'cn' : 'intl')}
            className="min-h-[44px] px-4 rounded-xl border border-zinc-800 hover:bg-zinc-800 text-xs font-medium text-zinc-200 flex items-center justify-center gap-2 whitespace-nowrap self-start transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            <span>Sincronizar Oficial</span>
          </button>
        </div>

        {syncMessage && (
          <div className="px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-300">
            {syncMessage}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar modelo (ex: Qwen3.8, DeepSeek, Kimi, Ultimate)..."
              className="w-full min-h-[44px] bg-[#090B0E] border border-zinc-800 rounded-xl pl-10 pr-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#090B0E] border border-zinc-800 rounded-xl self-start">
            {(['all', 'intl', 'cn'] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setRealmFilter(val)}
                className={`min-h-[36px] px-3.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  realmFilter === val ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {val === 'all' ? 'Todos' : val === 'intl' ? 'Global' : 'China'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((m) => {
          const ctxLabel = m.maxInputTokens >= 1_000_000 ? '1M ctx' : `${Math.round(m.maxInputTokens / 1000)}K ctx`;
          return (
            <div
              key={m.key}
              className="bg-[#12151B] border border-zinc-800/80 rounded-2xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-base font-semibold text-zinc-100">{m.displayName}</h2>
                  <span
                    className={`text-xs font-mono tabular-nums font-semibold shrink-0 ${
                      m.priceFactor === 0 ? 'text-emerald-400' : 'text-zinc-300'
                    }`}
                  >
                    {m.priceFactor === 0 ? '0x Grátis' : `${m.priceFactor}x`}
                  </span>
                </div>

                <p className="text-xs text-zinc-400 font-mono">
                  {m.key} · {ctxLabel} · {m.availableRealms.map((r) => r.toUpperCase()).join('/')}
                </p>

                <p className="text-xs text-zinc-400">
                  {[
                    m.isReasoning ? 'Raciocínio' : 'Direto',
                    m.isVl ? 'Visão (VL)' : 'Texto',
                    m.thinkingEfforts?.length ? `Níveis: ${m.thinkingEfforts.join(', ')}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>

              <button
                type="button"
                onClick={() => onTestModelInChat(m.id)}
                className="min-h-[42px] w-full rounded-xl border border-zinc-800 hover:border-emerald-500/60 hover:bg-emerald-500/10 text-xs font-medium text-zinc-200 hover:text-emerald-300 flex items-center justify-center gap-2 transition-colors"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Testar no Chat</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
