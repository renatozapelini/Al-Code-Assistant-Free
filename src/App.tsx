import { useCallback, useEffect, useRef, useState } from 'react';
import { AiApisPanel } from './components/AiApisPanel';
import { Analytics } from './components/Analytics';
import { AuthPanel } from './components/AuthPanel';
import { BottomNav } from './components/BottomNav';
import { MobileChatPanel } from './components/MobileChatPanel';
import { MobileDrawer } from './components/MobileDrawer';
import { ModelsPanel } from './components/ModelsPanel';
import { ProjectBuildReview } from './components/ProjectBuildReview';
import { QoderAccessPanel } from './components/QoderAccessPanel';
import { ScriptGeneratorPanel } from './components/ScriptGeneratorPanel';
import { TopBar } from './components/TopBar';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useCodeProjects } from './hooks/useCodeProjects';
import { isAuthenticated, login, logout, register } from './utils/authService';
import { androidBridge, appFetch } from './utils/androidBridge';
import { AppUpdatePanel } from './components/AppUpdatePanel';
import { DesktopSidebar } from './components/DesktopSidebar';
import { DesktopPanel } from './components/DesktopPanel';
import { isDesktopApp } from './utils/platform';
import type { CodeProject } from './utils/codeAssistant';
import type { HubOverview, NavTab, QoderModel } from './types/hub';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<NavTab>('projects');
  const [projectPrefill, setProjectPrefill] = useState('');
  const [buildProject, setBuildProject] = useState<CodeProject | null>(null);
  const [overview, setOverview] = useState<HubOverview | null>(null);
  const [models, setModels] = useState<QoderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('auto-failover');
  const [chatPrefillPrompt, setChatPrefillPrompt] = useState('');
  const [testingProviders, setTestingProviders] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isAuth, setIsAuth] = useState<boolean | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const navigate = useCallback((tab: NavTab) => {
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const apiFetch = useCallback(appFetch, []);
  const nativeAndroid = Boolean(androidBridge());
  const desktop = isDesktopApp();
  const code = useCodeProjects(apiFetch);
  const { importProjects } = code;

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

  const handleLogin = async (email: string, password: string) => {
    try {
      await login(email, password);
      setAuthModalOpen(false);
    } catch (err) {
      throw err;
    }
  };

  const handleRegister = async (email: string, password: string) => {
    try {
      await register(email, password);
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
      {!isAuth && (
        <div className="flex-1 flex items-center justify-center bg-[#090B0E]">
          <AuthPanel onAuthSuccess={() => setIsAuth(true)} onClose={() => setAuthModalOpen(false)} />
        </div>
      )}
      {isAuth && (
        <MainContent
          apiFetch={apiFetch}
          desktop={desktop}
          isDesktopApp={isDesktopApp}
          codeProjects={code.projects}
          setProjectPrefill={setProjectPrefill}
          setChatPrefillPrompt={setChatPrefillPrompt}
          setSelectedModelId={setSelectedModelId}
          setBuildProject={setBuildProject}
          overview={overview}
          models={models}
          selectedModelId={selectedModelId}
          chatPrefillPrompt={chatPrefillPrompt}
          testingProviders={testingProviders}
          fetchError={fetchError}
          setFetchError={setFetchError}
          loadAppData={loadAppData}
          onTestAllProviders={handleTestAllProviders}
          totalActiveEndpoints={totalActiveEndpoints}
          isAuthenticated={isAuth}
          userEmail={localStorage.getItem('code-assistants-token') ? 'usuário' : ''}
          onLogout={handleLogout}
          onOpenAuth={() => setAuthModalOpen(true)}
          mobileDrawerOpen={mobileDrawerOpen}
          setMobileDrawerOpen={setMobileDrawerOpen}
          isOnline={isOnline}
          activeTab={activeTab}
          onSelectTab={navigate}
        />
      )}
    </div>
  );
}
