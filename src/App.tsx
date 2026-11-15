import { useCallback, useEffect, useState } from 'react';
import { AiApisPanel } from './components/AiApisPanel';
import { Analytics } from './components/Analytics';
import { BottomNav } from './components/BottomNav';
import { MobileChatPanel } from './components/MobileChatPanel';
import { ModelsPanel } from './components/ModelsPanel';
import { ScriptGeneratorPanel } from './components/ScriptGeneratorPanel';
import { TopBar } from './components/TopBar';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useCodeProjects } from './hooks/useCodeProjects';
import { CodeAssistantsPanel } from './components/CodeAssistantsPanel';
import { ProjectBuildReview } from './components/ProjectBuildReview';
import { QoderAccessPanel } from './components/QoderAccessPanel';
import { androidBridge, appFetch } from './utils/androidBridge';
import { AppUpdatePanel } from './components/AppUpdatePanel';
import type { CodeProject } from './utils/codeAssistant';
import type { HubOverview, NavTab, QoderModel } from './types/hub';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<NavTab>('projects');
  const [projectPrefill, setProjectPrefill] = useState('');
  const navigate = useCallback((tab: NavTab) => {
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const [buildProject, setBuildProject] = useState<CodeProject | null>(null);
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [models, setModels] = useState<QoderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('auto-failover');
  const [chatPrefillPrompt, setChatPrefillPrompt] = useState('');
  const [testingProviders, setTestingProviders] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const apiFetch = useCallback(appFetch, []);
  const nativeAndroid = Boolean(androidBridge());
  const code = useCodeProjects(apiFetch);

  const loadAppData = useCallback(async () => {
    setFetchError(null);
    try {
      const [ovRes, catRes] = await Promise.all([
        apiFetch('/api/app/overview'),
        apiFetch('/api/app/catalog'),
      ]);
      if (!ovRes.ok) throw new Error(`Falha ao carregar serviço das assistentes (${ovRes.status})`);
      const ovData = (await ovRes.json()) as HubOverview;
      setOverview(ovData);

      if (catRes.ok) {
        const catData = (await catRes.json()) as { models?: QoderModel[] };
        if (Array.isArray(catData.models)) setModels(catData.models);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Erro ao conectar com o serviço das assistentes.');
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadAppData();
  }, [loadAppData]);

  const handleTestAllProviders = useCallback(async () => {
    const active = overview?.providers.filter((p) => p.enabled) ?? [];
    if (active.length === 0) return;
    setTestingProviders(true);
    try {
      for (const prv of active) {
        await apiFetch(`/api/app/providers/${encodeURIComponent(prv.id)}/test`, {
          method: 'POST',
        }).catch(() => undefined);
      }
      await loadAppData();
    } finally {
      setTestingProviders(false);
    }
  }, [apiFetch, loadAppData, overview]);

  const totalActiveEndpoints = overview?.totals.providersEnabled ?? 0;

  return (
    <div className="min-h-screen bg-[#090B0E] text-zinc-100 flex flex-col">
      <TopBar
        activeTab={activeTab}
        onSelectTab={navigate}
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
              onClick={() => void loadAppData()}
              className="px-3 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-800/60 text-xs font-medium whitespace-nowrap"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 w-full max-w-7xl mx-auto px-3 sm:px-6 pt-4 pb-24 md:pb-12">
        <div className="mb-3"><AppUpdatePanel apiFetch={apiFetch} expanded={activeTab === 'options'} /></div>
        {activeTab === 'options' && <section className="rounded-xl border border-zinc-800 bg-[#12151B] p-4 space-y-3">
          <h1 className="text-lg font-semibold">Opções</h1>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {([{ id: 'scripts', label: 'Pré-prompt · detalhar uma ideia' }, { id: 'models', label: 'Modelos de IA' }, { id: 'analytics', label: 'Uso e falhas das APIs' }, { id: 'accounts', label: 'Qoder · login assistido e múltiplas contas' }] as const).map(item => <button key={item.id} type="button" onClick={() => navigate(item.id)} className="min-h-[48px] text-left text-sm px-3 rounded-lg border border-zinc-800">{item.label}</button>)}
          </div>
          <p className="text-xs text-zinc-500">Projetos ficam neste dispositivo. A sincronização de arquivos com GitHub não está ativada; você pode exportar o ZIP pela área Arquivos do projeto. Nenhuma chave ou projeto é publicado automaticamente.</p>
        </section>}
        <div hidden={activeTab !== 'projects'}>
          <CodeAssistantsPanel projects={code.projects} activeId={code.activeId} busyId={code.busyId}
            providers={overview?.providers ?? []} error={code.error} prefill={projectPrefill}
            onConsumePrefill={() => setProjectPrefill('')} onCreate={code.create} onSelect={code.select}
            view="home" onConfigureProviders={code.configureProviders} onExecutionBlocked={code.setExecutionBlocked}
            onRun={(id) => void code.run(id)} onPause={code.pause} onSaveFile={code.saveFile} onImportFiles={code.saveFiles} onRequestChange={code.requestChange}
            onExport={code.exportProject} onNavigate={navigate} nativeAndroid={nativeAndroid}
            onBuild={(id) => { if (!code.busyId) {
              if (nativeAndroid) code.exportProject(id);
              else setBuildProject(code.projects.find((p) => p.id === id) ?? null);
            } }} />
        </div>

        {activeTab === 'chat' && (
          <MobileChatPanel
            models={models}
            providers={overview?.providers ?? []}
            accountsCount={totalActiveEndpoints}
            selectedModelId={selectedModelId}
            onSelectModelId={setSelectedModelId}
            apiFetch={apiFetch}
            onNavigate={navigate}
            onMessageCompleted={() => void loadAppData()}
            prefillPrompt={chatPrefillPrompt}
            onConsumePrefill={() => setChatPrefillPrompt('')}
          />
        )}

        <div hidden={activeTab !== 'scripts'}>
          <ScriptGeneratorPanel
            models={[]}
            providers={overview?.providers ?? []}
            accountsCount={totalActiveEndpoints}
            apiFetch={apiFetch}
            onNavigate={navigate}
            onSendToProject={(scriptText) => {
              setProjectPrefill(scriptText);
              navigate('projects');
            }}
            onSendToChat={(scriptText) => {
              setChatPrefillPrompt(scriptText);
              navigate('chat');
            }}
            onProvidersChanged={() => void loadAppData()}
            onScriptCompleted={() => void loadAppData()}
          />
        </div>

        <div hidden={activeTab !== 'apis'}>
          <AiApisPanel
            providers={overview?.providers ?? []}
            settings={overview?.settings}
            apiFetch={apiFetch}
            onProvidersChanged={() => void loadAppData()}
            onOpenQoder={() => navigate('accounts')}
          />
        </div>

        {activeTab === 'analytics' && (
          <Analytics
            overview={overview}
            onNavigate={navigate}
            onTestAllProviders={handleTestAllProviders}
            testingProviders={testingProviders}
          />
        )}


        {activeTab === 'models' && (
          <ModelsPanel
            models={models}
            apiFetch={apiFetch}
            onModelsUpdated={setModels}
            onNavigate={navigate}
            onProvidersChanged={() => void loadAppData()}
            onTestModelInChat={(modelId) => {
              setSelectedModelId(modelId);
              navigate('chat');
            }}
          />
        )}

        {activeTab === 'accounts' && <QoderAccessPanel />}
      </main>

      {buildProject && <ProjectBuildReview key={`${buildProject.id}-${buildProject.revision}`} project={buildProject}
        apiFetch={apiFetch} onClose={() => setBuildProject(null)}
        onResult={(result) => code.recordBuild(buildProject.id, buildProject.revision, result)} />}
      <BottomNav
        activeTab={activeTab}
        onSelectTab={navigate}
        accountsCount={overview?.totals.accountsEnabled ?? 0}
        providersCount={overview?.totals.providersEnabled ?? 0}
      />
    </div>
  );
}
