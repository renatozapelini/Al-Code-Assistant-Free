import { useCallback, useEffect, useState } from 'react';
import { AccountsPanel } from './components/AccountsPanel';
import { AiApisPanel } from './components/AiApisPanel';
import { Analytics } from './components/Analytics';
import { AndroidSettingsPanel } from './components/AndroidSettingsPanel';
import { BottomNav } from './components/BottomNav';
import { HubOverviewPanel } from './components/HubOverviewPanel';
import { MobileChatPanel } from './components/MobileChatPanel';
import { ModelsPanel } from './components/ModelsPanel';
import { ScriptGeneratorPanel } from './components/ScriptGeneratorPanel';
import { TopBar } from './components/TopBar';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import type { HubOverview, NavTab, QoderModel } from './types/hub';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<NavTab>('hub');
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [models, setModels] = useState<QoderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('auto-failover');
  const [chatPrefillPrompt, setChatPrefillPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [testingProviders, setTestingProviders] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const apiFetch = useCallback((path: string, init?: RequestInit) => {
    return fetch(path, init);
  }, []);

  const loadHubData = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const [ovRes, catRes] = await Promise.all([
        apiFetch('/api/hub/overview'),
        apiFetch('/api/hub/catalog'),
      ]);
      if (!ovRes.ok) throw new Error(`Falha ao carregar gateway (${ovRes.status})`);
      const ovData = (await ovRes.json()) as HubOverview;
      setOverview(ovData);

      if (catRes.ok) {
        const catData = (await catRes.json()) as { models?: QoderModel[] };
        if (Array.isArray(catData.models)) setModels(catData.models);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Erro ao conectar com o gateway.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadHubData();
  }, [loadHubData]);

  const handleTestAllProviders = useCallback(async () => {
    const active = overview?.providers.filter((p) => p.enabled) ?? [];
    if (active.length === 0) return;
    setTestingProviders(true);
    try {
      for (const prv of active) {
        await apiFetch(`/api/hub/providers/${encodeURIComponent(prv.id)}/test`, {
          method: 'POST',
        }).catch(() => undefined);
      }
      await loadHubData();
    } finally {
      setTestingProviders(false);
    }
  }, [apiFetch, loadHubData, overview]);

  const totalActiveEndpoints =
    (overview?.totals.accountsEnabled ?? 0) + (overview?.totals.providersEnabled ?? 0);

  return (
    <div className="min-h-screen bg-[#090B0E] text-zinc-100 flex flex-col">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onQuickAddApi={() => setActiveTab('apis')}
      />

      {!isOnline && (
        <div className="bg-amber-950/70 border-b border-amber-800/60 px-4 py-2 text-xs text-amber-200 text-center">
          Sem conexão com a internet — operando em cache offline PWA / local.
        </div>
      )}

      {fetchError && (
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-4">
          <div className="px-4 py-3 rounded-xl bg-red-950/40 border border-red-900/60 text-xs text-red-200 flex items-center justify-between gap-3">
            <span>{fetchError}</span>
            <button
              type="button"
              onClick={() => void loadHubData()}
              className="px-3 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-800/60 text-xs font-medium whitespace-nowrap"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-24 md:pb-12">
        {activeTab === 'hub' && (
          <HubOverviewPanel
            overview={overview}
            loading={loading}
            onRefresh={() => void loadHubData()}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'chat' && (
          <MobileChatPanel
            models={models}
            providers={overview?.providers ?? []}
            accountsCount={totalActiveEndpoints}
            selectedModelId={selectedModelId}
            onSelectModelId={setSelectedModelId}
            apiFetch={apiFetch}
            onNavigate={setActiveTab}
            onMessageCompleted={() => void loadHubData()}
            prefillPrompt={chatPrefillPrompt}
            onConsumePrefill={() => setChatPrefillPrompt('')}
          />
        )}

        {activeTab === 'scripts' && (
          <ScriptGeneratorPanel
            models={models}
            providers={overview?.providers ?? []}
            accountsCount={totalActiveEndpoints}
            apiFetch={apiFetch}
            onNavigate={setActiveTab}
            onSendToChat={(scriptText) => {
              setChatPrefillPrompt(scriptText);
              setActiveTab('chat');
            }}
            onProvidersChanged={() => void loadHubData()}
            onScriptCompleted={() => void loadHubData()}
          />
        )}

        {activeTab === 'apis' && (
          <AiApisPanel
            providers={overview?.providers ?? []}
            settings={overview?.settings}
            apiFetch={apiFetch}
            onProvidersChanged={() => void loadHubData()}
          />
        )}

        {activeTab === 'analytics' && (
          <Analytics
            overview={overview}
            onNavigate={setActiveTab}
            onTestAllProviders={handleTestAllProviders}
            testingProviders={testingProviders}
          />
        )}

        {activeTab === 'accounts' && (
          <AccountsPanel
            accounts={overview?.accounts ?? []}
            providersCount={overview?.totals.providersTotal ?? 0}
            apiFetch={apiFetch}
            onAccountsChanged={() => void loadHubData()}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'models' && (
          <ModelsPanel
            models={models}
            apiFetch={apiFetch}
            onModelsUpdated={setModels}
            onTestModelInChat={(modelId) => {
              setSelectedModelId(modelId);
              setActiveTab('chat');
            }}
          />
        )}

        {activeTab === 'android' && overview && (
          <AndroidSettingsPanel
            settings={overview.settings}
            apiKeys={overview.apiKeys}
            apiFetch={apiFetch}
            onSettingsChanged={() => void loadHubData()}
          />
        )}
      </main>

      <BottomNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        accountsCount={overview?.totals.accountsEnabled ?? 0}
        providersCount={overview?.totals.providersEnabled ?? 0}
      />
    </div>
  );
}
