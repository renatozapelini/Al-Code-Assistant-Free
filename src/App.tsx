import { useCallback, useEffect, useRef, useState } from 'react';
import { AiApisPanel } from './components/AiApisPanel';
import { Analytics } from './components/Analytics';
import { MobileChatPanel } from './components/MobileChatPanel';
import { MobileDrawer } from './components/MobileDrawer';
import { ModelsPanel } from './components/ModelsPanel';
import { QuickConnectPanel } from './components/QuickConnectPanel';
import { ScriptGeneratorPanel } from './components/ScriptGeneratorPanel';
import { TopBar } from './components/TopBar';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useCodeProjects } from './hooks/useCodeProjects';
import { CodeAssistantsPanel } from './components/CodeAssistantsPanel';
import { ProjectBuildReview } from './components/ProjectBuildReview';
import { QoderAccessPanel } from './components/QoderAccessPanel';
import { androidBridge, appFetch } from './utils/androidBridge';
import { AppUpdatePanel } from './components/AppUpdatePanel';
import { DesktopSidebar } from './components/DesktopSidebar';
import { DesktopPanel } from './components/DesktopPanel';
import { isDesktopApp } from './utils/platform';
import { isAuthenticated, login, logout, register } from './utils/authService';
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
  const [isAuth, setIsAuth] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const apiFetch = useCallback(appFetch, []);
  const nativeAndroid = Boolean(androidBridge());
  const desktop = isDesktopApp();
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('code-assistants-sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('code-assistants-sidebar-collapsed', sidebarCollapsed ? '1' : '0');
    } catch {
      // ignorar
    }
  }, [sidebarCollapsed]);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const code = useCodeProjects(apiFetch);
  const { importProjects } = code;

  // Fallback: se a injeção do /desktop-bootstrap.js no HTML falhou, tenta buscar o script
  useEffect(() => {
    if (desktop || nativeAndroid || typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/desktop-bootstrap.js', { signal: AbortSignal.timeout(3000) });
        if (!cancelled && res.ok) {
          const js = await res.text();
          if (js && js.includes('CodeAssistantsDesktop')) {
            // eslint-disable-next-line no-eval
            eval(js);
            if (!cancelled && isDesktopApp()) {
              window.location.reload();
            }
          }
        }
      } catch {
        // silencioso
      }
    })();
    return () => { cancelled = true; };
  }, [desktop, nativeAndroid]);

  const writtenVersions = useRef(new Map<string, number>());
  const knownProjectIds = new Set<string>();

  const loadAppData = useCallback(async () => {
    setFetchError(null);
    try {
      const [ovRes, catRes] = await Promise.all([
        apiFetch('/api/app/overview'),
        apiFetch('/api/app/catalog'),
      ]);
      if (!ovRes.ok) {
        let detail = '';
        let ovStatus = ovRes.status;
        try {
          const payload = (await ovRes.json()) as { error?: { message?: string } };
          detail = payload?.error?.message || '';
        } catch {
          detail = '';
        }
        throw new Error(`Não foi possível carregar o serviço local (HTTP ${ovStatus})${detail ? `: ${detail}` : '.'}`);
      }
      const ovData = (await ovRes.json()) as HubOverview;
      setOverview(ovData);

      if (catRes.ok) {
        const catData = (await catRes.json()) as { models?: QoderModel[] };
        if (Array.isArray(catData.models)) setModels(catData.models);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao conectar com o serviço local.';
      let extra = '';
      if (desktop && /\(HTTP 404\)/.test(message)) {
        extra = ' Pressione Ctrl+Shift+R para recarregar o cache. Se continuar, desinstale o Code Assistants e instale novamente o instalador mais recente.';
      }
      setFetchError(desktop ? `${message}${extra} Veja o diagnóstico em /diagnostico ou o log em “Este computador”.` : message);
    }
  }, [apiFetch, desktop]);

  useEffect(() => {
    void loadAppData();
  }, [loadAppData]);

  const saveDesktopProject = useCallback(async (project: CodeProject) => {
    const res = await apiFetch('/api/app/desktop/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    });
    if (!res.ok) throw new Error(`Não foi possível gravar “${project.name}” na pasta do computador (HTTP ${res.status}).`);
  }, [apiFetch]);

  const fetchProjectsFromDisk = useCallback(async (): Promise<unknown[]> => {
    const listRes = await apiFetch('/api/app/desktop/projects');
    if (!listRes.ok) return [];
    const data = (await listRes.json()) as { projects?: { id?: string }[] };
    const summaries = Array.isArray(data.projects) ? data.projects.slice(0, 10) : [];
    const incoming: unknown[] = [];
    for (const item of summaries) {
      if (!item || typeof item.id !== 'string') continue;
      const one = await apiFetch(`/api/app/desktop/projects/${encodeURIComponent(item.id)}`);
      if (!one.ok) continue;
      const payload = (await one.json()) as { project?: unknown };
      if (payload.project) incoming.push(payload.project);
    }
    return incoming;
  }, [apiFetch]);

  const restoreFromDisk = useCallback(async () => importProjects(await fetchProjectsFromDisk()), [importProjects, fetchProjectsFromDisk]);

  const saveAllToDisk = useCallback(async () => {
    let count = 0;
    for (const project of code.projects) {
      await saveDesktopProject(project);
      writtenVersions.current.set(project.id, project.updatedAt);
      count++;
    }
    return count;
  }, [code.projects, saveDesktopProject]);

  // Ao abrir no computador, junta o que já está na pasta (sem apagar nada).
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const incoming = await fetchProjectsFromDisk();
        if (!cancelled && incoming.length) importProjects(incoming);
      } catch {
        // a pasta é opcional
      }
    })();
    return () => { cancelled = true; };
  }, [desktop, fetchProjectsFromDisk, importProjects]);

  // Espelha cada checkpoint na pasta de projetos, sem repetir versões iguais.
  useEffect(() => {
    if (!desktop || code.projects.length === 0) return;
    const timer = setTimeout(() => {
      for (const project of code.projects) {
        if (writtenVersions.current.get(project.id) === project.updatedAt) continue;
        writtenVersions.current.set(project.id, project.updatedAt);
        void saveDesktopProject(project).catch(() => writtenVersions.current.delete(project.id));
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [desktop, code.projects, saveDesktopProject]);

  // Projeto apagado no aplicativo também sai da pasta do computador.
  useEffect(() => {
    if (!desktop) return;
    const current = new Set(code.projects.map((project) => project.id));
    for (const id of [...knownProjectIds]) {
      if (current.has(id)) continue;
      knownProjectIds.delete(id);
      writtenVersions.current.delete(id);
      void apiFetch(`/api/app/desktop/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    for (const id of current) knownProjectIds.add(id);
  }, [desktop, code.projects, apiFetch]);

  // Inicializa autenticação ao abrir o app
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loggedIn = await isAuthenticated();
        if (!cancelled) {
          setIsAuth(loggedIn);
          if (loggedIn) {
            const token = localStorage.getItem('code-assistants-token');
            if (token) {
              try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                setUserEmail(payload.email || '');
              } catch {
                // ignora erro de parse
              }
            }
          }
        }
      } catch {
        if (!cancelled) setIsAuth(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError('');
    try {
      await login(authEmail, authPassword);
      setAuthError('');
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Erro ao fazer login');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError('');
    try {
      await register(authEmail, authPassword);
      setAuthError('');
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Erro ao cadastrar');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    logout();
    setIsAuth(false);
    setUserEmail('');
  };

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
    <div className="min-h-screen bg-[#090B0E] text-zinc-100 flex flex-col lg:flex-row">
      <DesktopSidebar activeTab={activeTab} onSelectTab={navigate} online={isOnline} desktop={desktop} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)} />
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="lg:hidden">
          <TopBar
            activeTab={activeTab}
            onSelectTab={navigate}
            onQuickAddApi={() => setActiveTab('apis')}
            onOpenDrawer={() => setMobileDrawerOpen(true)}
            onOpenAuth={() => setAuthModalOpen(true)}
            onLogout={handleLogout}
            isAuthenticated={isAuth}
            userEmail={userEmail}
          />
        </div>

        {!isOnline && (
          <div className="bg-amber-950/70 border-b border-amber-800/60 px-4 py-2 text-xs text-amber-200 text-center">
            Sem conexão com a internet — operando em cache offline PWA / local.
          </div>
        )}

        {fetchError && (
          <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-4">
            <div className="px-4 py-3 rounded-xl bg-red-950/40 border border-red-900/60 text-xs text-red-200 flex flex-wrap items-center justify-between gap-3">
              <span>{fetchError}</span>
              <span className="flex items-center gap-2">
                {desktop && (
                  <a href="/diagnostico" className="px-3 py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-xs font-medium whitespace-nowrap">
                    Diagnóstico
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void loadAppData()}
                  className="px-3 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-800/60 text-xs font-medium whitespace-nowrap"
                >
                  Tentar novamente
                </button>
              </span>
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0 w-full max-w-7xl lg:max-w-[1500px] mx-auto px-3 sm:px-6 lg:px-8 pt-4 lg:pt-6 pb-24 md:pb-12 lg:pb-16">
          <div className="mb-3"><AppUpdatePanel apiFetch={apiFetch} expanded={activeTab === 'options'} /></div>
          {activeTab === 'options' && <section className="rounded-xl border border-zinc-800 bg-[#12151B] p-4 space-y-3">
            <h1 className="text-lg font-semibold">Opções</h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {([
                { id: 'scripts', label: 'Pré-prompt · detalhar uma ideia' },
                { id: 'models', label: 'Modelos de IA' },
                { id: 'analytics', label: 'Uso e falhas das APIs' },
                { id: 'accounts', label: 'Qoder · login assistido e múltiplas contas' },
                ...(desktop ? [{ id: 'desktop', label: 'Este computador · pastas e GitHub' }] : []),
              ] as const).map(item => <button key={item.id} type="button" onClick={() => navigate(item.id as NavTab)} className="min-h-[48px] text-left text-sm px-3 rounded-lg border border-zinc-800">{item.label}</button>)}
            </div>
            <p className="text-xs text-zinc-500">Projetos ficam neste dispositivo. {desktop
              ? 'No aplicativo Windows, os arquivos são gravados em uma pasta normal do computador e podem ser enviados ao seu GitHub em “Este computador”.'
              : 'Você pode exportar o ZIP pela área Arquivos do projeto.'} Nenhuma chave ou projeto é publicado automaticamente.</p>
          </section>}
          <div hidden={activeTab !== 'projects'}>
            <CodeAssistantsPanel projects={code.projects} activeId={code.activeId} busyId={code.busyId}
              providers={overview?.providers ?? []} error={code.error} prefill={projectPrefill}
              onConsumePrefill={() => setProjectPrefill('')} onCreate={code.create} onSelect={code.select}
              view="home" onConfigureProviders={code.configureProviders} onExecutionBlocked={code.setExecutionBlocked}
              onRun={(id) => void code.run(id)} onPause={code.pause} onSaveFile={code.saveFile} onImportFiles={code.saveFiles} onRequestChange={code.requestChange}
              onExport={code.exportProject} onNavigate={navigate} nativeAndroid={nativeAndroid}
              onRenameProject={code.renameProject} onDeleteProject={code.deleteProject}
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

          {activeTab === 'scripts' && (
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
          )}

          <div hidden={activeTab !== 'apis'} className="space-y-6">
            <QuickConnectPanel
              providers={overview?.providers ?? []}
              settings={overview?.settings}
              apiFetch={apiFetch}
              onProvidersChanged={() => void loadAppData()}
            />
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

          {activeTab === 'desktop' && (
            <DesktopPanel
              apiFetch={apiFetch}
              projects={code.projects.map((project) => ({ id: project.id, name: project.name, files: Object.keys(project.files).length }))}
              onSaveAll={saveAllToDisk}
              onRestoreFromDisk={restoreFromDisk}
            />
          )}
        </main>

        {buildProject && <ProjectBuildReview key={`${buildProject.id}-${buildProject.revision}`} project={buildProject}
          apiFetch={apiFetch} onClose={() => setBuildProject(null)}
          onResult={(result) => code.recordBuild(buildProject.id, buildProject.revision, result)} />}
        <MobileDrawer
          activeTab={activeTab}
          onSelectTab={navigate}
          isOpen={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          online={isOnline}
          desktop={desktop}
        />

        {/* Modal de autenticação */}
        {isAuth === null ? null : (
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            style={{ display: authModalOpen ? 'flex' : 'none' }}
            onClick={() => setAuthModalOpen(false)}
          >
            <div
              className="fixed inset-y-0 left-0 z-50 w-full max-w-md bg-[#0B0E12] border border-zinc-800/80 p-6 flex flex-col transform transition-transform duration-300 ease-in-out -translate-x-full"
              style={{ transform: 'translateX(0)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-zinc-100">
                  {authMode === 'login' ? 'Entrar no Code Assistants' : 'Criar conta'}
                </h2>
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(false)}
                  className="p-2 rounded-md hover:bg-zinc-800/50 text-zinc-400 focus:outline-none"
                >
                  <span className="sr-only">Fechar</span>
                  <span className="text-zinc-400">✕</span>
                </button>
              </div>

              <form onSubmit={authMode === 'login' ? handleLogin : handleRegister} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-400">E-mail</label>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="seu@email.com"
                    className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-600"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-400">Senha</label>
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-600"
                    required
                  />
                </div>
                {authError && (
                  <p className="text-xs text-red-400 text-center">{authError}</p>
                )}
                <button
                  type="submit"
                  disabled={authBusy}
                  className={`w-full rounded-lg px-3 py-2 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50 ${
                    authBusy
                      ? 'bg-zinc-800/50 text-zinc-400'
                      : 'bg-emerald-600 text-white hover:bg-emerald-500'
                  }`}
                >
                  {authBusy ? (
                    <>
                      <span className="w-4 h-4 animate-spin border-2 border-white border-t-transparent rounded-full" />
                      {authMode === 'login' ? 'Entrando...' : 'Criando conta...'}
                    </>
                  ) : (
                    <>
                      {authMode === 'login' ? 'Entrar' : 'Criar conta'}
                    </>
                  )}
                </button>
              </form>

              <div className="mt-6 flex items-center gap-4 text-xs text-zinc-400">
                <button
                  type="button"
                  onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                  className="underline hover:text-zinc-200"
                >
                  {authMode === 'login' ? 'Não tem uma conta? Criar conta' : 'Já tem uma conta? Entrar'}
                </button>
              </div>

              <div className="mt-4 border-t border-zinc-800 pt-4 text-xs text-zinc-500 text-center">
                <p>Conta de administrador:</p>
                <p className="text-emerald-400 font-mono">admin@codeassistants.local</p>
                <p className="text-emerald-400 font-mono">CodeAssistantsAdmin2026!</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
